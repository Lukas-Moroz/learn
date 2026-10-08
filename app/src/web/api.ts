// Thin client for the local server. All mutating calls carry the x-learn header
// (the server rejects cross-site requests without it).
import type { AttemptView, Block, QuestionView } from "../shared/schemas.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly paused: Paused | null = null,
  ) {
    super(message);
  }
}

export interface Paused {
  reason: string;
  code: string;
  since: string;
  usageUrl?: string;
}

async function call<T>(method: string, path: string, body?: unknown, raw?: { data: ArrayBuffer; filename: string }): Promise<T> {
  const headers: Record<string, string> = { "x-learn": "1" };
  let payload: BodyInit | undefined;
  if (raw) {
    headers["content-type"] = "application/octet-stream";
    headers["x-filename"] = encodeURIComponent(raw.filename);
    payload = raw.data;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (!res.ok) {
    let err: any = {};
    try {
      err = await res.json();
    } catch {
      // non-JSON error
    }
    throw new ApiError(res.status, err?.error?.code ?? "error", err?.error?.message ?? res.statusText, err?.paused ?? null);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export type BlockView = Block & { question?: QuestionView };

export interface ConceptStatus {
  conceptId: string;
  name: string;
  role: "central" | "background" | "optional";
  onPath: boolean;
  status: "not_assessed" | "developing" | "demonstrated" | "needs_review" | "deferred";
  reasons: string[];
  dimensions: Record<string, string>;
  ref: { sourceId: string; page: number; label: string | null } | null;
}

export interface LessonView {
  lesson: { id: string; title: string; objective: string | null; courseId: string | null; lectureId: string | null; updatedAt: string; createdAt: string };
  source: { id: string; unit: "page" | "slide"; pageCount: number; filename: string; kind: string; version: number } | null;
  state: { pendingQuestionId: string | null; complete: boolean; reviewQueue: string[]; detours: number };
  nav: {
    course: string | null;
    lecture: string | null;
    concept: string | null;
    conceptRole: string | null;
    conceptRoleLabel: string | null;
    sourcePosition: { sourceId: string; page: number; label: string | null } | null;
    activity: { kind: "detour" | "path" | "complete"; label: string; reason?: string; returnTo?: string; depth?: number };
    progress: { done: number; total: number };
  };
  concepts: ConceptStatus[];
  blocks: BlockView[];
  recap: { lastActive: string; lines: string[]; next: string; anchorBlockId: string | null } | null;
  nextAction: string;
  paused: Paused | null;
}

export interface ProviderStatus {
  id: "openai" | "claude" | "mock";
  label: string;
  ready: boolean;
  state: string;
  message: string;
  billing: string;
  model?: string;
  account?: string;
  usageUrl?: string;
}

export interface Status {
  active: string;
  settings: { primary: string; claudeFallback: boolean };
  paused: Paused | null;
  providers: ProviderStatus[];
  dataDir: string;
}

export interface CourseSummary {
  id: string;
  title: string;
  lectures: {
    id: string;
    title: string;
    position: number;
    source: { id: string; filename: string; pageCount: number; unit: string; version: number } | null;
    lesson: { id: string; complete: boolean; updatedAt: string; pathIndex: number; pathLength: number } | null;
  }[];
}

export interface ReviewItem {
  conceptId: string;
  name: string;
  status: string;
  due: boolean;
  nextReviewAt: string | null;
  question: QuestionView;
}

export const api = {
  status: () => call<Status>("GET", "/status"),
  setProviders: (s: { primary?: string; claudeFallback?: boolean }) => call("PATCH", "/settings/providers", s),
  openaiModels: () => call<{ id: string; label: string }[]>("GET", "/providers/openai/models"),
  setOpenaiModel: (model: string) => call("PUT", "/settings/openai-model", { model }),
  setClaudeModel: (model: string) => call("PUT", "/settings/claude-model", { model }),
  openaiSignIn: () => call("POST", "/providers/openai/signin"),
  openaiCancel: () => call("POST", "/providers/openai/cancel"),
  openaiDisconnect: () => call("POST", "/providers/openai/disconnect"),
  resume: () => call("POST", "/providers/resume"),
  courses: () => call<CourseSummary[]>("GET", "/courses"),
  createCourse: (title: string) => call<{ id: string }>("POST", "/courses", { title }),
  importFile: (courseId: string, file: File) =>
    file.arrayBuffer().then((data) => call<{ status: string; lectureId: string }>("POST", `/courses/${courseId}/import`, undefined, { data, filename: file.name })),
  importFolder: (courseId: string, path: string) => call<{ file: string; status: string }[]>("POST", `/courses/${courseId}/import-folder`, { path }),
  reorderLectures: (courseId: string, ids: string[]) => call("PUT", `/courses/${courseId}/lecture-order`, { ids }),
  startLecture: (lectureId: string) => call<{ lessonId: string }>("POST", `/lectures/${lectureId}/lesson`),
  startObjective: (objective: string, courseId?: string) => call<{ lessonId: string }>("POST", "/lessons", { objective, courseId }),
  lessons: () => call<{ id: string; title: string; objective: string | null; complete: boolean; updatedAt: string; progress: { index: number; total: number } }[]>("GET", "/lessons"),
  lesson: (id: string) => call<LessonView>("GET", `/lessons/${id}`),
  advance: (id: string) => call<LessonView>("POST", `/lessons/${id}/advance`),
  answer: (id: string, questionId: string, a: { selected: string[]; dontKnow: boolean; confidence: string | null; note?: string }) =>
    call<LessonView>("POST", `/lessons/${id}/answer`, { questionId, ...a }),
  skipReview: (id: string) => call<LessonView>("POST", `/lessons/${id}/skip-review`),
  cancelJob: (jobId: string) => call("POST", `/jobs/${jobId}/cancel`),
  exportMarkdown: (id: string) => fetch(`/api/lessons/${id}/export.md`).then(async (r) => ({ text: await r.text(), path: r.headers.get("x-export-path") })),
  page: (sourceId: string, page: number) => call<{ text: string; page: number; pageCount: number; unit: string; kind: string; filename: string }>("GET", `/sources/${sourceId}/pages/${page}`),
  review: () => call<ReviewItem[]>("GET", "/review"),
  answerReview: (questionId: string, a: { selected: string[]; dontKnow: boolean; confidence: string | null; note?: string }) =>
    call<{ attempt: AttemptView; message: string; mastery: { status: string; reasons: string[] } }>("POST", `/review/${questionId}/answer`, a),
  concepts: () => call<{ concepts: any[]; edges: { concept_id: string; related_id: string; kind: string }[] }>("GET", "/concepts"),
};

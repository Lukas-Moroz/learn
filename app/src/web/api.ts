// Thin client for the local server. All mutating calls carry the x-learn header
// (the server rejects cross-site requests without it).
import type { PracticeAnswerInput, PracticeCandidates, PracticeProblemView, PracticeSetSummary, PracticeSetView, PracticeStepView } from "../shared/practice.ts";
import type { FollowUpTargetKind, FollowUpThreadView } from "../shared/followup.ts";
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

/** A message fit to show the learner: the server's own words, or a plain network failure. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Could not reach the Learn server. Check that it is running.";
  return e instanceof Error ? e.message : String(e);
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

export type BlockView = Block & { question?: QuestionView; followUp?: FollowUpThreadView | null };

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
  state: { conceptId: string | null; pendingQuestionId: string | null; complete: boolean; reviewQueue: string[]; detours: number };
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
  /** "prefetch": the next lesson step is prepared in the background. */
  generation?: { prefetch: boolean };
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
  /** Exam practice sets; their documents are not listed in `lectures`. */
  practice: PracticeSetSummary[];
}

/** Server-sent event for practice extraction progress, finished free-text grades, and warm-up ("primer") or coaching ("coached") generation. */
export interface PracticeEvent {
  type: "practice";
  setId?: string;
  problemId?: string;
  stepId?: string;
  status?: string;
  done?: number;
  total?: number;
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
  setGeneration: (s: { prefetch: boolean }) => call<{ prefetch: boolean }>("PATCH", "/settings/generation", s),
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
  /** The lesson page opened: prepare what Continue will need next (no-op when prefetch is off). */
  prefetchLesson: (id: string) => call("POST", `/lessons/${id}/prefetch`),
  /** The lesson page closed: cancel what was prepared for it. Survives the page unloading. */
  leaveLesson: (id: string) => {
    try {
      void fetch(`/api/lessons/${id}/leave`, { method: "POST", keepalive: true, headers: { "x-learn": "1" } }).catch(() => undefined);
    } catch {
      // best effort
    }
  },
  skipReview: (id: string) => call<LessonView>("POST", `/lessons/${id}/skip-review`),
  skipLessonConcept: (id: string, conceptId: string) => call<LessonView>("POST", `/lessons/${id}/skip`, { conceptId }),
  cancelJob: (jobId: string) => call("POST", `/jobs/${jobId}/cancel`),
  exportMarkdown: (id: string) => fetch(`/api/lessons/${id}/export.md`).then(async (r) => ({ text: await r.text(), path: r.headers.get("x-export-path") })),
  page: (sourceId: string, page: number) => call<{ text: string; page: number; pageCount: number; unit: string; kind: string; filename: string }>("GET", `/sources/${sourceId}/pages/${page}`),
  review: () => call<ReviewItem[]>("GET", "/review"),
  answerReview: (questionId: string, a: { selected: string[]; dontKnow: boolean; confidence: string | null; note?: string }) =>
    call<{ attempt: AttemptView; message: string; mastery: { status: string; reasons: string[] } }>("POST", `/review/${questionId}/answer`, a),
  concepts: () => call<{ concepts: any[]; edges: { concept_id: string; related_id: string; kind: string }[] }>("GET", "/concepts"),
  // Exam practice
  practiceCandidates: (courseId: string) => call<PracticeCandidates>("GET", `/courses/${courseId}/practice/candidates`),
  createPractice: (courseId: string, body: { problemSourceId: string; solutionSourceId?: string | null; title?: string }) =>
    call<PracticeSetView>("POST", `/courses/${courseId}/practice`, body),
  coursePractice: (courseId: string) => call<PracticeSetView[]>("GET", `/courses/${courseId}/practice`),
  practiceSet: (setId: string) => call<PracticeSetView>("GET", `/practice/${setId}`),
  retryPractice: (setId: string) => call<PracticeSetView>("POST", `/practice/${setId}/retry`),
  deletePractice: (setId: string) => call<{ ok: true }>("DELETE", `/practice/${setId}`),
  practiceProblem: (problemId: string) => call<PracticeProblemView>("GET", `/practice/problems/${problemId}`),
  attemptStep: (stepId: string, a: PracticeAnswerInput) => call<PracticeStepView>("POST", `/practice/steps/${stepId}/attempt`, a),
  revealStep: (stepId: string) => call<PracticeStepView>("POST", `/practice/steps/${stepId}/reveal`),
  skipStep: (stepId: string) => call<PracticeStepView>("POST", `/practice/steps/${stepId}/skip`),
  overrideAttempt: (attemptId: string) => call<PracticeStepView>("POST", `/practice/attempts/${attemptId}/override`),
  startPrimer: (problemId: string) => call<PracticeProblemView>("POST", `/practice/problems/${problemId}/primer`),
  skipPrimer: (problemId: string) => call<PracticeProblemView>("POST", `/practice/problems/${problemId}/primer/skip`),
  answerProbe: (problemId: string, index: number, a: { selected: string[]; dontKnow: boolean; confidence: string | null }) =>
    call<PracticeProblemView>("POST", `/practice/problems/${problemId}/primer/${index}/answer`, a),
  retryCoaching: (stepId: string) => call<PracticeStepView>("POST", `/practice/steps/${stepId}/coach`),
  answerCoachingCheck: (coachingId: string, a: { selected: string[]; dontKnow: boolean; confidence: string | null }) =>
    call<PracticeStepView>("POST", `/practice/coaching/${coachingId}/check`, a),
  // Follow-up questions
  askFollowUp: (kind: FollowUpTargetKind, id: string, question: string) => call<FollowUpThreadView>("POST", "/follow-ups", { kind, id, question }),
  followUpThread: (threadId: string) => call<FollowUpThreadView>("GET", `/follow-ups/${threadId}`),
  retryFollowUp: (turnId: string) => call<FollowUpThreadView>("POST", `/follow-ups/turns/${turnId}/retry`),
  learnProblem: (problemId: string, conceptId?: string) => call<{ lessonId: string }>("POST", `/practice/problems/${problemId}/learn`, conceptId ? { conceptId } : {}),
};

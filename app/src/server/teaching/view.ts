// Client-facing projection of a lesson. Questions never reveal their answer before
// they have been attempted. Navigation shows the two independent positions: where the
// learner is in the source, and which concept they are studying.
import type { AttemptRow, LessonRow, QuestionRow } from "../db/repo.ts";
import type { AttemptView, Block, QuestionView } from "../../shared/schemas.ts";
import type { Engine } from "./engine.ts";
import { currentConcept } from "./planner.ts";

export function questionView(q: QuestionRow, attempt: AttemptRow | undefined): QuestionView {
  return {
    id: q.id,
    conceptId: q.concept_id,
    purpose: q.purpose,
    kind: q.kind,
    context: q.context,
    stem: q.stem,
    options: q.options.map((o) => ({ value: o.value, label: o.label })),
    multiSelect: q.multi_select,
    difficulty: q.difficulty,
    ...(attempt ? { attempt: attemptView(q, attempt) } : {}),
  };
}

export function attemptView(q: QuestionRow, a: AttemptRow): AttemptView {
  return {
    id: a.id,
    selected: a.selected,
    dontKnow: a.dont_know,
    confidence: a.confidence,
    ...(a.note ? { note: a.note } : {}),
    correct: a.correct,
    correctValues: q.correct,
    explanation: q.explanation,
    reasoning: a.reasoning,
    reasoningStatus: a.reasoning_status,
    createdAt: a.created_at,
  };
}

const ROLE_LABEL = { central: "Central to the source", background: "Useful background", optional: "Optional deeper exploration" } as const;

export function lessonView(engine: Engine, lesson: LessonRow) {
  const repo = engine.repo;
  const state = lesson.state;
  const blocks = repo.listBlocks(lesson.id).map((b): Block & { question?: QuestionView } => {
    if (b.type !== "question") return b;
    const q = repo.getQuestion(b.payload.questionId)!;
    return { ...b, question: questionView(q, repo.attemptsForQuestion(q.id).find((a) => a.lesson_id === lesson.id)) };
  });

  const course = lesson.course_id ? repo.getCourse(lesson.course_id) : undefined;
  const lecture = lesson.lecture_id ? repo.getLecture(lesson.lecture_id) : undefined;
  const source = lesson.source_id ? repo.getSource(lesson.source_id) : undefined;
  const cur = currentConcept(state);
  const curConcept = cur ? repo.getConcept(cur) : undefined;
  const frame = state.detours[state.detours.length - 1];
  const role = cur ? state.roles[cur] ?? "background" : null;

  const ids = [...new Set([...state.path, ...state.detours.map((d) => d.conceptId), ...repo.listBlocks(lesson.id).filter((b) => b.type === "detour_start").map((b) => b.conceptId!)])];
  const concepts = ids.map((id) => {
    const m = engine.mastery(id, state.roles[id] ?? "background");
    return {
      conceptId: id,
      name: repo.getConcept(id)!.name,
      role: state.roles[id] ?? "background",
      onPath: state.path.includes(id),
      status: state.deferred.includes(id) && m.status !== "demonstrated" ? "deferred" : m.status,
      reasons: m.reasons,
      dimensions: m.dimensions,
      ref: (() => {
        const pages = engine.conceptPages(lesson, id);
        return pages.length && source ? { sourceId: source.id, page: pages[0], label: engine.positionLabel(lesson, pages[0]) } : null;
      })(),
    };
  });
  const done = concepts.filter((c) => c.onPath && c.status === "demonstrated").length;

  const nav = {
    course: course?.title ?? null,
    lecture: lecture?.title ?? null,
    concept: curConcept?.name ?? null,
    conceptRole: role,
    conceptRoleLabel: role ? ROLE_LABEL[role] : null,
    sourcePosition: state.sourcePosition ? { ...state.sourcePosition, label: engine.positionLabel(lesson, state.sourcePosition.page) } : null,
    activity: frame
      ? { kind: "detour" as const, label: `Prerequisite detour: ${repo.getConcept(frame.conceptId)!.name}`, reason: frame.reason, returnTo: `${repo.getConcept(frame.fromConceptId)!.name}${frame.returnTo.page ? ` (${engine.positionLabel(lesson, frame.returnTo.page)})` : ""}`, depth: state.detours.length }
      : state.complete
        ? { kind: "complete" as const, label: "Lesson complete" }
        : { kind: "path" as const, label: curConcept ? `Studying ${curConcept.name}` : "Starting" },
    progress: { done, total: state.path.length },
  };

  return {
    lesson: { id: lesson.id, title: lesson.title, objective: lesson.objective, courseId: lesson.course_id, lectureId: lesson.lecture_id, updatedAt: lesson.updated_at, createdAt: lesson.created_at },
    source: source ? { id: source.id, unit: source.unit, pageCount: source.page_count, filename: source.filename, kind: source.kind, version: source.version } : null,
    state: { pendingQuestionId: state.pendingQuestionId, complete: state.complete, reviewQueue: state.reviewQueue, detours: state.detours.length },
    nav,
    concepts,
    blocks,
    recap: recap(engine, lesson, nav),
    nextAction: engine.nextAction(lesson.id).type,
  };
}

/** A concise "where you left off", computed from stored state only. */
export function recap(engine: Engine, lesson: LessonRow, nav: { concept: string | null; sourcePosition: { label: string | null } | null; activity: { kind: string; label: string; returnTo?: string } }) {
  const repo = engine.repo;
  const blocks = repo.listBlocks(lesson.id);
  if (blocks.length === 0) return null;
  const feedback = blocks.filter((b) => b.type === "feedback");
  const recent = feedback.slice(-5);
  const right = recent.filter((b) => b.payload.correct === true).length;
  const lastCp = [...blocks].reverse().find((b) => b.type === "checkpoint");
  const open = lesson.state.path
    .flatMap((id) => repo.activeMisconceptions(id).map((m) => m.label))
    .slice(0, 3);
  const lines: string[] = [];
  if (nav.concept) lines.push(`You were studying **${nav.concept}**${nav.sourcePosition?.label ? ` (${nav.sourcePosition.label})` : ""}.`);
  if (nav.activity.kind === "detour") lines.push(`You were in a ${nav.activity.label.toLowerCase()}, and will return to ${nav.activity.returnTo}.`);
  if (recent.length) lines.push(`Your last ${recent.length} answers: ${right} correct.`);
  if (lastCp) lines.push(`Last checkpoint: ${lastCp.payload.learned.map((l: { name: string }) => l.name).join(", ") || "in progress"}.`);
  if (open.length) lines.push(`Still open: ${open.join("; ")}.`);
  const pending = lesson.state.pendingQuestionId;
  return {
    lastActive: lesson.updated_at,
    lines,
    next: pending ? "Answer the open question" : lesson.state.complete ? "Lesson complete" : "Continue the lesson",
    anchorBlockId: pending ? blocks.find((b) => b.type === "question" && b.payload.questionId === pending)?.id ?? null : blocks[blocks.length - 1]?.id ?? null,
  };
}

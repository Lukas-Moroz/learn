// Client views of practice sets, problems and steps. Answer keys stay server-side:
// a step's key appears (as `reveal`) only once the step has an attempt.
import { normalizeOptions, visibleOptionRefs } from "../../shared/grading.ts";
import { expectedDisplay, givenCells } from "../../shared/practice-grading.ts";
import type {
  PracticeAttemptView,
  PracticeCoachingView,
  PracticePrimerView,
  PracticeQuestionView,
  PracticeProblemSummary,
  PracticeProblemView,
  PracticeSetSummary,
  PracticeSetView,
  PracticeStepView,
  StepStatus,
} from "../../shared/practice.ts";
import { documentTitle } from "./extract.ts";
import { FollowUpRepo } from "../followup/repo.ts";
import type { FollowUpThreadView } from "../../shared/followup.ts";
import type { Confidence, QuestionPurpose } from "../../shared/schemas.ts";
import type { CoachingRow, PracticeAttemptRow, PracticeProblemRow, PracticeRepo, PracticeSetRow, PracticeStepRow, StoredQuestion } from "./repo.ts";

/**
 * A step's status: the latest attempt decides, except that an attempt the learner counted as
 * correct makes the step correct (they judged their answer right against the key).
 */
export function stepStatus(attempts: PracticeAttemptRow[]): StepStatus {
  const latest = attempts[attempts.length - 1];
  if (!latest) return "unanswered";
  if (attempts.some((a) => a.overridden)) return "correct";
  if (latest.grading_status === "pending") return "pending";
  if (latest.dont_know) return latest.revealed ? "revealed" : "dont_know";
  if (latest.score === 1) return "correct";
  if (latest.score !== null && latest.score > 0) return "partial";
  return "incorrect";
}

/** Completed steps unlock the next one (a written answer waiting for its grade does too). */
export const completed = (s: StepStatus) => s === "correct" || s === "revealed";

/** An attempt that shows a gap to coach: wrong, partly right or "I don't know" (not a reveal, not counted as correct). */
export function unsuccessful(a: PracticeAttemptRow): boolean {
  if (a.revealed || a.overridden) return false;
  return a.dont_know || (a.grading_status === "done" && a.correct === false);
}

/** The key is shown once the step is completed, or when a written answer couldn't be graded (the learner compares it). */
export function keyShown(attempts: PracticeAttemptRow[], status: StepStatus): boolean {
  if (status === "skipped") return attempts.some((a) => a.revealed);
  return completed(status) || attempts.some((a) => a.revealed) || attempts[attempts.length - 1]?.grading_status === "failed";
}

/** A stored guided-practice question as QuestionCard renders it; the answer appears only once answered. */
export function questionView(
  id: string,
  conceptId: string,
  purpose: QuestionPurpose,
  q: StoredQuestion,
  answer: { selected: string[]; dont_know: boolean; confidence: Confidence | null; correct: boolean | null; at: string } | null,
): PracticeQuestionView {
  return {
    id,
    conceptId,
    purpose,
    kind: q.kind,
    context: q.context,
    stem: q.stem,
    options: q.options.map((o) => ({ value: o.value, label: o.label })),
    multiSelect: q.multiSelect,
    difficulty: q.difficulty,
    ...(answer
      ? {
          attempt: {
            id,
            selected: answer.selected,
            dontKnow: answer.dont_know,
            confidence: answer.confidence,
            correct: answer.correct,
            correctValues: q.correct,
            explanation: visibleOptionRefs(q.explanation, q.options),
            reasoning: null,
            reasoningStatus: "none" as const,
            createdAt: answer.at,
          },
        }
      : {}),
  };
}

/** The first paragraph of Markdown text (for coaching stored before it had a summary). */
export function firstParagraph(text: string): string {
  return text.trim().split(/\n\s*\n/)[0]?.trim() ?? "";
}

export function coachingView(c: CoachingRow, conceptId: string, followUp: FollowUpThreadView | null = null): PracticeCoachingView {
  const x = c.content;
  return {
    id: c.id,
    round: c.round,
    status: c.status,
    error: c.status === "ready" ? null : c.error,
    strategy: x?.strategy ?? null,
    diagnosis: x?.diagnosis ?? "",
    summary: x ? (x.summary ?? firstParagraph(x.explanation)) : "",
    explanation: x?.explanation ?? "",
    example: x?.example ?? "",
    nextHint: x?.nextHint ?? "",
    refs: c.refs,
    provenance: c.refs.some((r) => r.verified && r.quote) ? "source" : "supplementary",
    check: x?.check ? questionView(c.id, conceptId, "check", x.check, c.check) : null,
    checkStatus: x?.check ? "ready" : x ? (x.checkStatus ?? "pending") : c.status === "ready" ? "pending" : c.status,
    checkError: x && !x.check ? (x.checkError ?? null) : null,
    followUp,
  };
}

export function primerView(store: PracticeRepo, problemId: string, started: boolean): PracticePrimerView {
  const row = store.getPrimer(problemId);
  if (!row) return { status: started ? "none" : "not_started", error: null, probes: [], done: started };
  if (row.skipped) return { status: "skipped", error: null, probes: [], done: true };
  if (row.status === "none") return { status: "none", error: null, probes: [], done: true };
  if (row.status !== "ready") return { status: row.status, error: row.error, probes: [], done: false };
  const answers = new Map(store.probeAnswers(problemId).map((a) => [a.idx, a]));
  const probes = row.probes.map((p, index) => {
    const a = answers.get(index);
    return {
      index,
      concept: { id: p.conceptId, name: p.conceptName },
      why: p.why,
      question: questionView(`${problemId}:${index}`, p.conceptId, "probe", p.question, a ? { ...a, at: a.created_at } : null),
      teach: a ? p.teach : null,
      refs: a ? p.refs : [],
    };
  });
  return { status: "ready", error: null, probes, done: probes.every((p) => p.question.attempt) };
}

export function attemptView(a: PracticeAttemptRow): PracticeAttemptView {
  return {
    id: a.id,
    value: a.dont_know ? null : a.value,
    dontKnow: a.dont_know,
    confidence: a.confidence,
    correct: a.correct,
    score: a.score,
    ...(a.cell_results ? { cellResults: a.cell_results } : {}),
    feedback: a.feedback,
    gradingStatus: a.grading_status,
    overridden: a.overridden,
    createdAt: a.created_at,
  };
}

/** A step's concepts as graph ids and names; the problem's when the step names none. */
export function stepConcepts(store: PracticeRepo, problem: PracticeProblemRow, step: PracticeStepRow): { id: string; name: string }[] {
  if (!step.concepts.length) return problem.concepts;
  const known = new Map(problem.concepts.map((c) => [c.id, c.name]));
  return step.concepts.flatMap((id) => {
    const name = known.get(id) ?? store.repo.getConcept(id)?.name;
    return name ? [{ id, name }] : [];
  });
}

/** True only when a solution reference's quote was verified on a solution page. */
export function keyVerified(step: PracticeStepRow): boolean {
  return step.solution_refs.some((r) => r.verified === true && Boolean(r.quote));
}

export function stepView(
  step: PracticeStepRow,
  attempts: PracticeAttemptRow[],
  concepts: { id: string; name: string }[],
  keySource: PracticeSetRow["key_source"] = "solutions",
  coaching: CoachingRow[] = [],
  followUps?: FollowUpRepo,
): PracticeStepView {
  const status = step.skipped ? "skipped" : stepStatus(attempts);
  const key = step.key;
  const input: PracticeStepView["input"] = {};
  if (key.kind === "table") input.table = { rowLabels: key.rowLabels, colLabels: key.colLabels, given: givenCells(key) };
  if (key.kind === "choice") input.choice = { options: normalizeOptions(key.options).map((o) => ({ value: o.value, label: o.label })), multiSelect: key.multiSelect };
  if (key.kind === "number" && key.unit) input.unit = key.unit;
  return {
    id: step.id,
    problemId: step.problem_id,
    position: step.position,
    label: step.label,
    prompt: step.prompt,
    kind: step.kind,
    input,
    hint: step.hint,
    keyVerified: keyVerified(step),
    keySource,
    concepts,
    status,
    attempts: attempts.map(attemptView),
    coaching: coaching.map((c) => coachingView(c, concepts[0]?.id ?? "", followUps?.view("practice_coaching", c.id) ?? null)),
    followUp: followUps?.view("practice_step", step.id) ?? null,
    misses: attempts.filter(unsuccessful).length,
    ...(keyShown(attempts, status) ? { reveal: { solution: step.solution, expected: expectedDisplay(key), solutionRefs: step.solution_refs } } : {}),
  };
}

export function problemView(store: PracticeRepo, problem: PracticeProblemRow): PracticeProblemView {
  const keySource = store.getSet(problem.set_id)?.key_source ?? "solutions";
  const followUps = new FollowUpRepo(store.repo);
  const steps = store.listSteps(problem.id).map((s) => stepView(s, store.attemptsForStep(s.id), stepConcepts(store, problem, s), keySource, store.coachingForStep(s.id), followUps));
  return {
    id: problem.id,
    setId: problem.set_id,
    number: problem.number,
    title: problem.title,
    intro: problem.intro,
    steps,
    primer: primerView(store, problem.id, steps.some((s) => s.attempts.length > 0 || s.status === "skipped")),
    concepts: problem.concepts,
    taughtIn: problem.taught_in,
    problemRefs: problem.problem_refs,
  };
}

/** Per-problem counts: steps, steps attempted, steps whose latest attempt is correct. */
function problemSummaries(store: PracticeRepo, set: PracticeSetRow): PracticeProblemSummary[] {
  const byStep = new Map<string, PracticeAttemptRow[]>();
  for (const a of store.attemptsForSet(set.id)) byStep.set(a.step_id, [...(byStep.get(a.step_id) ?? []), a]);
  const steps = store.stepsForSet(set.id);
  return store.listProblems(set.id).map((p) => {
    const own = steps.filter((s) => s.problem_id === p.id);
    const statuses = own.map((s) => s.skipped ? "skipped" : stepStatus(byStep.get(s.id) ?? []));
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      stepCount: own.length,
      answered: own.filter((s) => byStep.has(s.id)).length,
      correct: statuses.filter((s) => s === "correct").length,
      skipped: statuses.filter((s) => s === "skipped").length,
      completed: statuses.filter((s) => completed(s) || s === "pending" || s === "skipped").length,
      unverifiedSteps: own.filter((s) => !keyVerified(s)).length,
    };
  });
}

export function setView(store: PracticeRepo, set: PracticeSetRow): PracticeSetView {
  const problems = problemSummaries(store, set);
  const title = (id: string) => {
    const source = store.repo.getSource(id);
    return source ? documentTitle(store.repo, source) : "";
  };
  return {
    id: set.id,
    courseId: set.course_id,
    title: set.title,
    problemSourceId: set.problem_source_id,
    solutionSourceId: set.solution_source_id,
    problemTitle: title(set.problem_source_id),
    solutionTitle: set.solution_source_id ? title(set.solution_source_id) : null,
    keySource: set.key_source,
    unverifiedSteps: problems.reduce((n, p) => n + p.unverifiedSteps, 0),
    status: set.status,
    progress: { done: problems.length, total: set.progress_total },
    error: set.error,
    problems,
    createdAt: set.created_at,
  };
}

export function setSummary(store: PracticeRepo, set: PracticeSetRow): PracticeSetSummary {
  const { problems, ...rest } = setView(store, set);
  const sum = (k: "stepCount" | "answered" | "correct") => problems.reduce((n, p) => n + p[k], 0);
  return { ...rest, problemCount: problems.length, stepCount: sum("stepCount"), answered: sum("answered"), correct: sum("correct") };
}

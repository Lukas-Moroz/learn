// Exam practice: worked problems from a study guide, checked step by step against its
// solution key. Shared contract between server and client; AI output is validated here.
import { z } from "zod";
import type { FollowUpThreadView } from "./followup.ts";
import { Confidence, QuestionContent, Strategy, type AttemptView, type Provenance, type QuestionView, type SourceRef } from "./schemas.ts";

// ── Answer keys (AI-extracted from the solution document, validated) ────────

/** How a step is answered and graded. Everything except "free" is graded deterministically. */
export const AnswerKind = z.enum(["number", "text", "sequence", "table", "choice", "free"]);
export type AnswerKind = z.infer<typeof AnswerKind>;

/** A value written the way a student would: "3/64", "-0.415", "2^-3", "log2(6)", "F", "ACT-". */
const Cell = z.union([z.string().max(60), z.number()]);

export const AnswerKey = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    /** Exact value as an expression ("7/64", "log2(3)") or a number. */
    value: Cell,
    /** Other forms that are also correct (e.g. a different but valid convention). */
    alternatives: z.array(Cell).max(6).default([]),
    /** Absolute tolerance. Omitted: a decimal is accepted when it rounds correctly at the precision typed. */
    tolerance: z.number().nonnegative().optional(),
    unit: z.string().max(20).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    /** Accepted answers, compared case-insensitively with whitespace normalised. */
    accepted: z.array(z.string().min(1).max(300)).min(1).max(8),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("sequence"),
    /** Tokens; the learner may separate them with spaces, commas or brackets. */
    value: z.array(Cell).min(1).max(60),
    /** false: a set (order ignored), e.g. the text positions of all occurrences. */
    ordered: z.boolean().default(true),
    alternatives: z.array(z.array(Cell).max(60)).max(6).default([]),
  }),
  z.object({
    kind: z.literal("table"),
    rowLabels: z.array(z.string().max(30)).min(1).max(30),
    colLabels: z.array(z.string().max(30)).min(1).max(30),
    /** cells[r][c]; null = not graded (e.g. "—"). Strings may hold several accepted forms separated by " | ". */
    cells: z.array(z.array(Cell.nullable()).max(30)).max(30),
    /** Cells shown pre-filled to the learner (same shape; null = learner fills it). */
    given: z.array(z.array(Cell.nullable()).max(30)).max(30).optional(),
  }),
  z.object({
    kind: z.literal("choice"),
    options: z.array(z.object({ value: z.string().min(1).max(60), label: z.string().min(1).max(400) })).min(2).max(8),
    correct: z.union([z.string(), z.array(z.string())]),
    multiSelect: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("free"),
    /** The key's own answer (Markdown); shown after the attempt. */
    modelAnswer: z.string().min(1).max(4000),
    /** Points a full-credit answer must make; used by the AI grader and for self-checking. */
    keyIdeas: z.array(z.string().max(300)).min(1).max(8),
  }),
]);
export type AnswerKey = z.infer<typeof AnswerKey>;

const AiRef = z.object({
  page: z.number().int().positive(),
  pageEnd: z.number().int().positive().optional(),
  quote: z.string().max(400).optional(),
});

export const PracticeStepContent = z.object({
  /** "(a)", "(b) matrix", "(b) traceback" … one gradable thing per step. */
  label: z.string().min(1).max(40),
  /** What to do in this step, Markdown with $…$ math. Self-contained together with the problem intro. */
  prompt: z.string().min(1).max(3000),
  key: AnswerKey,
  /** Worked solution for this step from the solution document, Markdown. Shown after an attempt. */
  solution: z.string().min(1).max(6000),
  /** A nudge that does not give the answer away. */
  hint: z.string().max(800).optional(),
  /** Concept names this step exercises (subset of the problem's concepts). */
  concepts: z.array(z.string().max(120)).max(6).default([]),
  /** Pages in the SOLUTION document where this step is answered. */
  solutionRefs: z.array(AiRef).max(4).default([]),
});
export type PracticeStepContent = z.infer<typeof PracticeStepContent>;

/** AI task "practice_outline": find the problems and their page ranges in both documents. */
export const PracticeOutline = z.object({
  title: z.string().min(1).max(200),
  problems: z
    .array(
      z.object({
        number: z.string().min(1).max(20),
        title: z.string().min(1).max(200),
        problemPages: z.array(z.number().int().positive()).min(1).max(12),
        solutionPages: z.array(z.number().int().positive()).max(12).default([]),
      }),
    )
    .min(1)
    .max(40),
});
export type PracticeOutline = z.infer<typeof PracticeOutline>;

/** AI task "practice_problem": one problem split into gradable steps with an answer key. */
export const PracticeProblemContent = z.object({
  title: z.string().min(1).max(200),
  /** Shared setup and given data (sequences, scoring scheme, matrices), Markdown. */
  intro: z.string().min(1).max(6000),
  steps: z.array(PracticeStepContent).min(1).max(20),
  concepts: z
    .array(z.object({ name: z.string().min(1).max(120), definition: z.string().min(1).max(800), sense: z.string().max(80).optional() }))
    .min(1)
    .max(8),
  /** Distinctive terms used to find the lecture pages that teach this problem. */
  keywords: z.array(z.string().max(60)).min(1).max(15),
});
export type PracticeProblemContent = z.infer<typeof PracticeProblemContent>;

/** AI task "grade_practice": grade a free-text step against the key. */
export const PracticeGrade = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  /** Key ideas the answer covered (by index into keyIdeas). */
  covered: z.array(z.number().int().nonnegative()).max(8).default([]),
  feedback: z.string().max(800),
  misconception: z.object({ label: z.string().max(200), description: z.string().max(500) }).optional(),
});
export type PracticeGrade = z.infer<typeof PracticeGrade>;

// ── Guided practice: warm-up probes and coaching after a miss ──────────────

/**
 * A reference into the lecture excerpts sent with a guided-practice request. "doc" is the
 * excerpt's document number (1-based) in the input; the server maps it to a source and
 * checks the page and quote like lesson refs.
 */
export const PracticeRef = z.object({
  doc: z.number().int().positive(),
  page: z.number().int().positive(),
  pageEnd: z.number().int().positive().optional(),
  quote: z.string().max(400).optional(),
});
export type PracticeRef = z.infer<typeof PracticeRef>;

/** One warm-up probe on an idea the problem assumes. */
export const PrimerProbe = z.object({
  /** The idea probed: a name from the input's "concepts", or a new prerequisite (then "definition" is required). */
  concept: z.string().min(1).max(120),
  /** A real definition, required when "concept" is not in the input list. */
  definition: z.string().max(800).optional(),
  /** One sentence on why the problem needs this idea (shown above the question). */
  why: z.string().min(1).max(400),
  question: QuestionContent,
  /** Short conceptual explanation of the idea, shown when the learner misses the probe. Markdown + math. */
  teach: z.string().min(1).max(3000),
  refs: z.array(PracticeRef).max(4).default([]),
});
export type PrimerProbe = z.infer<typeof PrimerProbe>;

/** AI task "practice_primer": 1–2 probing questions on the prerequisites a problem assumes. */
export const PracticePrimer = z.object({
  probes: z.array(PrimerProbe).min(1).max(2),
});
export type PracticePrimer = z.infer<typeof PracticePrimer>;

/**
 * AI task "practice_coach": what to teach after a wrong answer or "I don't know", without giving the
 * answer away. The check question is a separate task ("practice_coach_check") written afterwards from
 * the committed explanation, so the explanation can be shown (and streamed) without waiting for it.
 */
export const PracticeCoaching = z.object({
  /** The teaching angle; a second round must take a different one. */
  strategy: Strategy,
  /** The likely misunderstanding, phrased tentatively. Never states the answer. */
  diagnosis: z.string().min(1).max(800),
  /** The core idea in at most two sentences: what the learner sees first (the full explanation is one click away). */
  summary: z.string().min(1).max(500),
  /** Conceptual, first-principles explanation of the idea the step needs. Markdown + math. */
  explanation: z.string().min(1).max(5000),
  /** A fully worked mini-example on different, smaller data that exercises the same idea. Markdown + math. */
  example: z.string().min(1).max(5000),
  /** What to look at when retrying the step. */
  nextHint: z.string().min(1).max(600),
  refs: z.array(PracticeRef).max(5).default([]),
});
export type PracticeCoaching = z.infer<typeof PracticeCoaching>;

/** AI task "practice_coach_check": one multiple-choice question on the committed coaching's mini-example. */
export const PracticeCoachCheck = z.object({ check: QuestionContent });
export type PracticeCoachCheck = z.infer<typeof PracticeCoachCheck>;

/** A practice question the client renders with QuestionCard (no answer until attempted). */
export type PracticeQuestionView = QuestionView & { attempt?: AttemptView };

/** Generation state of a primer or coaching block. "waiting": no AI provider available right now (retried later). */
export type GuideStatus = "pending" | "waiting" | "failed" | "ready";

export interface PracticeCoachingView {
  id: string;
  /** 1 for the first miss on a step, 2 for the second, … */
  round: number;
  status: GuideStatus;
  /** Why it is waiting or failed. */
  error: string | null;
  strategy: Strategy | null;
  diagnosis: string;
  /** The core idea in at most two sentences (older rows: the explanation's first paragraph). */
  summary: string;
  explanation: string;
  example: string;
  nextHint: string;
  refs: SourceRef[];
  provenance: Provenance;
  check: PracticeQuestionView | null;
  /** Follow-up questions asked about this round. */
  followUp: FollowUpThreadView | null;
  /** The check question is generated after the explanation: its own state ("ready" once it is there). */
  checkStatus: GuideStatus;
  checkError: string | null;
}

export interface PracticePrimerView {
  /**
   * "not_started": offer it (the client asks the server to prepare it); "none": nothing to warm up
   * (every concept already demonstrated, or the problem was started before warm-ups existed).
   */
  status: "not_started" | "none" | "skipped" | GuideStatus;
  error: string | null;
  probes: {
    index: number;
    concept: { id: string; name: string };
    why: string;
    question: PracticeQuestionView;
    /** Shown once answered (opened when the answer was wrong or "I don't know"). */
    teach: string | null;
    refs: SourceRef[];
  }[];
  /** Skipped, nothing to do, or every probe answered: the problem's first step is open. */
  done: boolean;
}

// ── Learner input ───────────────────────────────────────────────────────────

export const PracticeAnswerInput = z
  .object({
    /** number/text/sequence/free: a string; choice: selected values; table: rows of cell strings. */
    value: z.union([z.string().max(6000), z.array(z.string().max(60)).max(8), z.array(z.array(z.string().max(60)).max(30)).max(30)]).optional(),
    dontKnow: z.boolean().default(false),
    confidence: Confidence.nullable().default(null),
  })
  .refine((a) => a.dontKnow || a.value !== undefined, { message: "Enter an answer or choose “I don't know”." })
  .refine((a) => a.dontKnow || a.confidence !== null, { message: "Choose how confident you are." });
export type PracticeAnswerInput = z.infer<typeof PracticeAnswerInput>;

// ── Views (what the client renders; keys stay server-side until attempted) ──

/**
 * "dont_know": the latest attempt was "I don't know" (coaching follows, the key stays hidden).
 * "skipped": set aside without recording an answer, revealing the key or awarding evidence.
 * A step allows onward navigation when "correct", "revealed" or "skipped"; "pending" (a written answer waiting for its
 * grade) also lets the learner move on.
 */
export type StepStatus = "unanswered" | "correct" | "partial" | "incorrect" | "revealed" | "pending" | "dont_know" | "skipped";

export interface PracticeAttemptView {
  id: string;
  value: string | string[] | string[][] | null;
  dontKnow: boolean;
  confidence: z.infer<typeof Confidence> | null;
  /** null while an AI grade is pending or when grading was impossible. */
  correct: boolean | null;
  /** 0..1; tables score the fraction of graded cells that are right. */
  score: number | null;
  /** Tables: per-cell result (null = not graded). */
  cellResults?: (boolean | null)[][];
  feedback: string;
  gradingStatus: "done" | "pending" | "failed";
  /** The learner overrode the grade ("Count as correct"). */
  overridden: boolean;
  createdAt: string;
}

export interface PracticeStepView {
  id: string;
  problemId: string;
  position: number;
  label: string;
  prompt: string;
  kind: AnswerKind;
  /** What the input control needs. Never contains the answer. */
  input: {
    table?: { rowLabels: string[]; colLabels: string[]; given: (string | null)[][] };
    choice?: { options: { value: string; label: string }[]; multiSelect: boolean };
    unit?: string;
  };
  hint: string | null;
  /**
   * The key is backed by the solution document: a solution reference's quote was found on a
   * solution page. false: AI-derived (generated set, or not found in the solutions).
   */
  keyVerified: boolean;
  /** The set's key source, so an unverified step can say why ("generated": no solutions were given). */
  keySource: "solutions" | "generated";
  /** Concepts this step exercises (the problem's when the step names none): targets for "Learn this concept". */
  concepts: { id: string; name: string }[];
  status: StepStatus;
  /** Oldest first; the latest decides `status`. */
  attempts: PracticeAttemptView[];
  /** Coaching after each unsuccessful attempt, oldest first. */
  coaching: PracticeCoachingView[];
  /** Follow-up questions asked about the step itself (outside a coaching round). */
  followUp: FollowUpThreadView | null;
  /** Unsuccessful attempts so far (wrong, partly right, "I don't know"); from 2 the solution is offered prominently. */
  misses: number;
  /** Present once the step is completed: answered correctly (or counted as correct), or the solution was shown. */
  reveal?: {
    solution: string;
    /** The key in display form: a string, or a table of strings. */
    expected: string | (string | null)[][];
    solutionRefs: SourceRef[];
  };
}

export interface PracticeProblemView {
  id: string;
  setId: string;
  number: string;
  title: string;
  intro: string;
  steps: PracticeStepView[];
  /** Warm-up on the ideas the problem assumes, before its first step. */
  primer: PracticePrimerView;
  concepts: { id: string; name: string }[];
  /** Lecture pages that teach this problem's ideas, ranked. */
  taughtIn: SourceRef[];
  /** Pages of the problem in the study-guide document. */
  problemRefs: SourceRef[];
}

export interface PracticeProblemSummary {
  id: string;
  number: string;
  title: string;
  stepCount: number;
  answered: number;
  correct: number;
  /** Steps set aside for later, which may also have earlier attempts. */
  skipped: number;
  /** Steps that allow onward navigation: correct, revealed, skipped, or awaiting a grade. */
  completed: number;
  /** Steps whose key was not verified against the solution document. */
  unverifiedSteps: number;
}

export interface PracticeSetView {
  id: string;
  courseId: string;
  title: string;
  problemSourceId: string;
  /** May equal problemSourceId: one document holding both the problems and their solutions. */
  solutionSourceId: string | null;
  /** Document titles, for naming them on the set page. */
  problemTitle: string;
  solutionTitle: string | null;
  /** "solutions": keys copied from the solution document; "generated": no solutions given, the AI solved it (unverified). */
  keySource: "solutions" | "generated";
  /** Steps whose key is not backed by a verified solution quote (all of them for "generated"). */
  unverifiedSteps: number;
  status: "extracting" | "ready" | "failed";
  /** Extraction progress, e.g. 4 of 11 problems. */
  progress: { done: number; total: number | null };
  error: string | null;
  problems: PracticeProblemSummary[];
  createdAt: string;
}

/** One practice set on a course card (GET /api/courses → course.practice[]). */
export type PracticeSetSummary = Omit<PracticeSetView, "problems"> & {
  problemCount: number;
  stepCount: number;
  answered: number;
  correct: number;
};

/** GET /api/courses/:id/practice/candidates: course documents and suggested problem/solution pairs. */
export interface PracticeCandidates {
  sources: { id: string; title: string; filename: string; pageCount: number; inPractice: boolean }[];
  suggested: { problemSourceId: string; solutionSourceId: string | null; title: string }[];
}

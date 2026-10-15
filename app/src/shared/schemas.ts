// Typed contracts shared by server and client. Anything persisted or returned by
// an AI provider is validated against one of these schemas before it is used.
import { z } from "zod";

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const ConceptRole = z.enum(["central", "background", "optional"]);
export type ConceptRole = z.infer<typeof ConceptRole>;

export const EdgeKind = z.enum(["prerequisite", "application", "refinement", "related"]);
export type EdgeKind = z.infer<typeof EdgeKind>;

/** Assessment types. Each maps onto an evidence dimension (see mastery.ts). */
export const QuestionKind = z.enum([
  "conceptual", // basic conceptual check
  "causal", // why does X lead to Y
  "application", // apply to a new scenario
  "multi_step", // multi-step problem
  "diagnose_explanation", // find the flaw in someone's explanation
  "compare", // compare related concepts
  "plain_language", // pick the best plain-language explanation
  "assumptions", // identify assumptions / limitations
  "why_alternative_fails", // explain why an alternative approach fails
]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const EvidenceDimension = z.enum([
  "recognition",
  "explanation",
  "application",
  "transfer",
  "retention",
  "calibration",
]);
export type EvidenceDimension = z.infer<typeof EvidenceDimension>;

export const MasteryStatus = z.enum(["not_assessed", "developing", "demonstrated", "needs_review"]);
export type MasteryStatus = z.infer<typeof MasteryStatus>;

export const Confidence = z.enum(["sure", "unsure", "guess"]);
export type Confidence = z.infer<typeof Confidence>;

/** Teaching strategies. Remediation rotates through untried ones instead of rewording. */
export const Strategy = z.enum([
  "first_principles",
  "worked_example",
  "analogy",
  "contrasting_cases",
  "visual",
  "derivation",
]);
export type Strategy = z.infer<typeof Strategy>;

export const QuestionPurpose = z.enum(["probe", "check", "review", "transfer"]);
export type QuestionPurpose = z.infer<typeof QuestionPurpose>;

// ── Source provenance ───────────────────────────────────────────────────────

/** A pointer into an imported document. `page` is a 1-based page or slide number. */
export const SourceRef = z.object({
  sourceId: z.string(),
  page: z.number().int().positive(),
  pageEnd: z.number().int().positive().optional(),
  quote: z.string().max(400).optional(),
  /** Set by the server after checking the page exists (and the quote appears on it). */
  verified: z.boolean().optional(),
  /** Human label computed server-side, e.g. "Lecture 4, slides 8–12". */
  label: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** Where content came from: the document itself, or AI-generated supplementary teaching. */
export const Provenance = z.enum(["source", "supplementary", "system"]);
export type Provenance = z.infer<typeof Provenance>;

// ── AI contracts (provider output, validated) ───────────────────────────────

/** Refs as the model writes them: page numbers within the current source only. */
const AiRef = z.object({
  page: z.number().int().positive(),
  pageEnd: z.number().int().positive().optional(),
  quote: z.string().max(400).optional(),
});

export const AnalysisConcept = z.object({
  name: z.string().min(1).max(120),
  /** Disambiguates identically named concepts used differently (e.g. "kernel (ML)"). */
  sense: z.string().max(80).optional(),
  definition: z.string().min(1).max(800),
  role: ConceptRole,
  /** Pages/slides where the source discusses it; empty for background not in the source. */
  pages: z.array(z.number().int().positive()).max(40).default([]),
  prerequisites: z.array(z.string()).max(12).default([]),
  /** How this course uses the concept, if narrower than the general definition. */
  interpretation: z.string().max(400).optional(),
  section: z.string().max(160).optional(),
});
export type AnalysisConcept = z.infer<typeof AnalysisConcept>;

export const SourceAnalysis = z.object({
  kind: z.enum(["paper", "lecture", "other"]),
  title: z.string().min(1).max(200),
  researchQuestion: z.string().max(600).optional(),
  motivation: z.string().max(800).optional(),
  overview: z.string().min(1).max(2500),
  contributions: z.array(z.string().max(400)).max(10).default([]),
  methods: z.array(z.string().max(400)).max(10).default([]),
  experiments: z.array(z.string().max(400)).max(10).default([]),
  conclusions: z.array(z.string().max(400)).max(10).default([]),
  structure: z
    .array(
      z.object({
        title: z.string().max(160),
        pageStart: z.number().int().positive(),
        pageEnd: z.number().int().positive(),
        summary: z.string().max(500).optional(),
      }),
    )
    .max(40)
    .default([]),
  concepts: z.array(AnalysisConcept).min(1).max(40),
  /** Concept names in teaching order (prerequisites first, then the source's own order). */
  learningPath: z.array(z.string()).min(1).max(40),
  relationsToPrevious: z.array(z.string().max(300)).max(10).default([]),
});
export type SourceAnalysis = z.infer<typeof SourceAnalysis>;

export const ObjectivePlan = z.object({
  title: z.string().min(1).max(200),
  overview: z.string().min(1).max(1500),
  concepts: z.array(AnalysisConcept).min(1).max(25),
  learningPath: z.array(z.string()).min(1).max(25),
});
export type ObjectivePlan = z.infer<typeof ObjectivePlan>;

export const EquationExplainer = z.object({
  latex: z.string().min(1).max(600),
  /** Why the equation exists / what problem it solves. */
  purpose: z.string().max(600),
  terms: z.array(z.object({ symbol: z.string().max(80), meaning: z.string().max(300) })).max(12),
  /** What happens when terms grow, shrink or are removed. */
  behavior: z.array(z.string().max(300)).max(8).default([]),
  assumptions: z.array(z.string().max(300)).max(8).default([]),
  /** Optional deeper derivation, shown collapsed. */
  derivation: z.string().max(3000).optional(),
});
export type EquationExplainer = z.infer<typeof EquationExplainer>;

export const ExplanationContent = z.object({
  title: z.string().min(1).max(160),
  strategy: Strategy,
  /** Main body, Markdown with $…$ / $$…$$ math. */
  body: z.string().min(1).max(8000),
  equation: EquationExplainer.optional(),
  analogy: z
    .object({ text: z.string().max(1200), breaksDown: z.string().min(1).max(600) })
    .optional(),
  workedExample: z.string().max(3000).optional(),
  diagram: z.object({ mermaid: z.string().max(2000), caption: z.string().max(300) }).optional(),
  /** Explicit edges to concepts the learner already has. */
  connections: z.array(z.string().max(300)).max(6).default([]),
  refs: z.array(AiRef).max(10).default([]),
});
export type ExplanationContent = z.infer<typeof ExplanationContent>;

export const QuestionOption = z.object({
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(500),
  /** For distractors: the specific misconception choosing this option suggests. */
  misconception: z.string().max(200).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const QuestionContent = z.object({
  stem: z.string().min(1).max(2000),
  kind: QuestionKind,
  /** "novel" = the concept applied outside the context it was taught in (transfer). */
  context: z.enum(["original", "novel"]),
  /** Short tag for the situation used, so later questions can avoid it. */
  scenario: z.string().min(1).max(120),
  options: z.array(QuestionOption).min(2).max(6),
  multiSelect: z.boolean().default(false),
  correct: z.union([z.string(), z.array(z.string())]),
  explanation: z.string().min(1).max(2500),
  rubric: z.object({
    keyIdeas: z.array(z.string().max(200)).min(1).max(6),
    commonFlaws: z.array(z.string().max(200)).max(6).default([]),
  }),
  difficulty: z.number().int().min(1).max(5),
  refs: z.array(AiRef).max(5).default([]),
});
export type QuestionContent = z.infer<typeof QuestionContent>;

export const ReasoningEvaluation = z.object({
  verdict: z.enum(["sound", "partially_sound", "flawed", "off_topic"]),
  summary: z.string().max(600),
  issues: z.array(z.string().max(300)).max(5).default([]),
  misconception: z.object({ label: z.string().max(200), description: z.string().max(500) }).optional(),
});
export type ReasoningEvaluation = z.infer<typeof ReasoningEvaluation>;

// ── Learner input ───────────────────────────────────────────────────────────

export const AttemptInput = z
  .object({
    selected: z.array(z.string()).max(6).default([]),
    dontKnow: z.boolean().default(false),
    confidence: Confidence.nullable().default(null),
    note: z.string().max(4000).optional(),
  })
  .refine((a) => a.dontKnow || a.selected.length > 0, { message: "Select an answer or choose “I don't know”." })
  .refine((a) => a.dontKnow || a.confidence !== null, { message: "Choose how confident you are." });
export type AttemptInput = z.infer<typeof AttemptInput>;

// ── Lesson stream blocks (what the client renders) ──────────────────────────

export const BlockType = z.enum([
  "overview",
  "plan",
  "explanation",
  "question",
  "feedback",
  "detour_start",
  "detour_end",
  "checkpoint",
  "review",
  "notice",
]);
export type BlockType = z.infer<typeof BlockType>;

export interface Block {
  id: string;
  lessonId: string;
  seq: number;
  type: BlockType;
  conceptId: string | null;
  payload: any;
  refs: SourceRef[];
  provenance: Provenance;
  createdAt: string;
}

/** Client-safe view of a question: never contains the answer until it has been attempted. */
export interface QuestionView {
  id: string;
  conceptId: string;
  purpose: QuestionPurpose;
  kind: QuestionKind;
  context: "original" | "novel";
  stem: string;
  options: { value: string; label: string }[];
  multiSelect: boolean;
  difficulty: number;
  attempt?: AttemptView;
  /** Set aside in this lesson without an answer or any mastery credit. */
  skipped?: boolean;
}

export interface AttemptView {
  id: string;
  selected: string[];
  dontKnow: boolean;
  confidence: Confidence | null;
  note?: string;
  correct: boolean | null;
  correctValues: string[];
  explanation: string;
  reasoning: ReasoningEvaluation | null;
  reasoningStatus: "none" | "pending" | "done" | "failed";
  createdAt: string;
}

export interface DetourFrame {
  conceptId: string;
  reason: string;
  fromConceptId: string;
  returnTo: { conceptId: string; page: number | null };
}

/** Deterministic lesson state. The engine owns it; the LLM never does. */
export interface LessonState {
  path: string[];
  pathIndex: number;
  /** Concept currently being studied (may be a detour concept off the path). */
  conceptId: string | null;
  /** Where the learner is in the original document. */
  sourcePosition: { sourceId: string; page: number } | null;
  detours: DetourFrame[];
  overviewShown: boolean;
  pendingQuestionId: string | null;
  /** Concepts covered since the last checkpoint (for the next checkpoint's summary). */
  sinceCheckpoint: string[];
  checkpointCount: number;
  /** Per concept: number of in-lesson attempts at the moment the miss streak was reset (after a detour). */
  streakResets: Record<string, number>;
  /** Detours already taken, as "from>to", so remediation never loops into the same detour. */
  detourHistory: string[];
  /** Set when a detour just ended; the next explanation reconnects to the original concept. */
  justReturned: { conceptId: string; fromDetour: string } | null;
  /** Concepts set aside after repeated unsuccessful strategies (kept for review). */
  deferred: string[];
  /** Due concepts to review (cumulative retrieval practice) before continuing; skippable. */
  reviewQueue: string[];
  /** Role of each concept in this lesson (central concepts must also show transfer). */
  roles: Record<string, ConceptRole>;
  complete: boolean;
}

export function initialLessonState(
  path: string[],
  sourcePosition: LessonState["sourcePosition"],
  roles: Record<string, ConceptRole> = {},
): LessonState {
  return {
    path,
    pathIndex: 0,
    conceptId: path[0] ?? null,
    sourcePosition,
    detours: [],
    overviewShown: false,
    pendingQuestionId: null,
    sinceCheckpoint: [],
    checkpointCount: 0,
    streakResets: {},
    detourHistory: [],
    justReturned: null,
    deferred: [],
    reviewQueue: [],
    roles,
    complete: false,
  };
}

export interface MasterySummary {
  conceptId: string;
  status: MasteryStatus;
  dimensions: Record<EvidenceDimension, "none" | "positive" | "negative" | "weak">;
  reasons: string[];
  lastEvidenceAt: string | null;
}

// The planner is a PURE function: lesson state + facts about each concept → the
// next teaching move. All adaptivity rules live here, where they can be read and
// unit-tested without any AI. The engine executes the move (calling the AI only to
// produce content) and persists the result.
import type {
  Confidence,
  ConceptRole,
  LessonState,
  MasterySummary,
  QuestionKind,
  QuestionPurpose,
  ReasoningEvaluation,
  Strategy,
} from "../../shared/schemas.ts";
import { tokens } from "../../shared/similarity.ts";

export interface AttemptFact {
  correct: boolean | null;
  confidence: Confidence | null;
  purpose: QuestionPurpose;
  kind: QuestionKind;
  context: "original" | "novel";
  reasoning: ReasoningEvaluation["verdict"] | null;
}

/** Chronological in-lesson history for a concept. */
export type HistoryEvent = { type: "explanation"; strategy: Strategy } | ({ type: "attempt" } & AttemptFact);

export interface ConceptFacts {
  id: string;
  name: string;
  role: ConceptRole;
  mastery: MasterySummary;
  activeMisconceptions: string[];
  /** Labels and descriptions of the active misconceptions, for choosing which prerequisite to revisit. */
  misconceptionText?: string;
  definition?: string;
  prerequisites: string[];
  history: HistoryEvent[];
  /** Strategies that preceded a wrong answer, across all lessons. */
  failedStrategies: Strategy[];
  hasStoredReviewQuestion: boolean;
}

export interface Snapshot {
  state: LessonState;
  facts: (id: string) => ConceptFacts;
  hasSource: boolean;
}

export type Action =
  | { type: "await_answer" }
  | { type: "overview" }
  | { type: "review"; conceptId: string }
  | { type: "probe"; conceptId: string; kind: QuestionKind; difficulty: number }
  | { type: "explain"; conceptId: string; strategy: Strategy; purpose: "introduce" | "remediate" | "detour" | "return"; reason: string }
  | { type: "check"; conceptId: string; kind: QuestionKind; context: "original" | "novel"; difficulty: number; purpose: QuestionPurpose; reason: string }
  | { type: "detour"; conceptId: string; fromConceptId: string; reason: string }
  | { type: "return" }
  | { type: "checkpoint" }
  | { type: "stuck"; conceptId: string; reason: string }
  | { type: "advance" }
  | { type: "complete" };

export const STRATEGY_ORDER: Strategy[] = ["first_principles", "worked_example", "contrasting_cases", "analogy", "visual", "derivation"];
export const MAX_DETOUR_DEPTH = 3;
/** After this many different explanations of one concept in a lesson fail, set it aside. */
export const MAX_STRATEGIES_PER_LESSON = 4;
/** Checkpoint after this many concepts are completed since the last one. */
export const CHECKPOINT_EVERY = 2;

export function currentConcept(state: LessonState): string | null {
  if (state.detours.length) return state.detours[state.detours.length - 1].conceptId;
  return state.path[state.pathIndex] ?? null;
}

export function attempts(f: ConceptFacts): AttemptFact[] {
  return f.history.filter((h): h is { type: "attempt" } & AttemptFact => h.type === "attempt");
}

/** Wrong or "I don't know" answers since the last correct one (and since any streak reset). */
export function missStreak(f: ConceptFacts, resetAt = 0): number {
  const a = attempts(f).slice(resetAt);
  let n = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i].correct === true) break;
    n++;
  }
  return n;
}

function strategiesInLesson(f: ConceptFacts): Strategy[] {
  return f.history.filter((h): h is { type: "explanation"; strategy: Strategy } => h.type === "explanation").map((h) => h.strategy);
}

export function nextStrategy(f: ConceptFacts): Strategy | null {
  const used = new Set([...strategiesInLesson(f), ...f.failedStrategies]);
  return STRATEGY_ORDER.find((s) => !used.has(s)) ?? STRATEGY_ORDER.find((s) => !strategiesInLesson(f).includes(s)) ?? null;
}

const EXPLANATION_KINDS: QuestionKind[] = ["causal", "diagnose_explanation", "plain_language", "why_alternative_fails", "compare", "assumptions"];
const APPLICATION_KINDS: QuestionKind[] = ["application", "multi_step"];

/** Choose the evidence the concept still lacks, and a question kind that tests it. */
export function nextCheck(f: ConceptFacts): { kind: QuestionKind; context: "original" | "novel"; difficulty: number; purpose: QuestionPurpose; reason: string } {
  const d = f.mastery.dimensions;
  const a = attempts(f);
  const last = a[a.length - 1];
  const recentKinds = a.slice(-3).map((x) => x.kind);
  const streak = (() => {
    let n = 0;
    for (let i = a.length - 1; i >= 0 && a[i].correct === true && a[i].confidence === "sure"; i--) n++;
    return n;
  })();
  const pick = (kinds: QuestionKind[]) => kinds.find((k) => !recentKinds.includes(k)) ?? kinds[0];
  const base = last && last.correct !== true ? 2 : 2 + Math.min(streak, 2);

  if (d.explanation === "negative") {
    return { kind: pick(["diagnose_explanation", "plain_language", "causal"]), context: "original", difficulty: base, purpose: "check", reason: "Your last written reasoning didn't hold up, so this checks the reasoning itself" };
  }
  if (d.recognition !== "positive" && d.explanation !== "positive") {
    return { kind: pick(EXPLANATION_KINDS.slice(0, 3)), context: "original", difficulty: base, purpose: "check", reason: "Checks that the core idea makes sense, not just the terms" };
  }
  if (d.application !== "positive") {
    return { kind: pick(APPLICATION_KINDS), context: "original", difficulty: base + 1, purpose: "check", reason: "Applies the idea to a concrete situation" };
  }
  if (f.role === "central" && d.transfer !== "positive") {
    return { kind: pick(["application", "causal", "multi_step"]), context: "novel", difficulty: Math.min(5, base + 1), purpose: "transfer", reason: "Applies the idea in an unfamiliar setting, the real test of understanding" };
  }
  return { kind: pick(EXPLANATION_KINDS), context: "original", difficulty: base, purpose: "check", reason: "One more confirmation" };
}

/** Pick the prerequisite to detour into: an unsolid one we haven't already detoured into for this concept. */
export function detourTarget(snap: Snapshot, f: ConceptFacts): string | null {
  const { state } = snap;
  if (state.detours.length >= MAX_DETOUR_DEPTH) return null;
  const inStack = new Set([...state.detours.map((d) => d.conceptId), ...state.detours.map((d) => d.fromConceptId)]);
  const candidates = f.prerequisites
    .filter((p) => !inStack.has(p) && !state.detourHistory.includes(`${f.id}>${p}`) && !state.deferred.includes(p))
    .map((p) => snap.facts(p))
    .filter((p) => p.mastery.status !== "demonstrated");
  // Prefer the prerequisite the learner's misconception points at; then one with known
  // misconceptions of its own, then one never assessed.
  const rank = (p: ConceptFacts) => (p.activeMisconceptions.length ? 0 : p.mastery.status === "not_assessed" ? 1 : 2);
  const related = new Map(candidates.map((p) => [p.id, misconceptionRelatedness(f, p)]));
  candidates.sort((a, b) => related.get(b.id)! - related.get(a.id)! || rank(a) - rank(b));
  return candidates[0]?.id ?? null;
}

// Stems that say how a misconception is phrased, not what it is about ("Assumes …", "Thinks …").
const FRAMING = new Set(["think", "belie", "assum", "treat", "confu", "means", "uses", "mista", "ignor", "expec", "learn"]);
const stems = (text: string) => tokens(text).filter((t) => t.length > 2).map((t) => t.slice(0, 5));

/** Content words shared by the learner's misconceptions about `f` and a prerequisite's name and definition. */
export function misconceptionRelatedness(f: ConceptFacts, pre: ConceptFacts): number {
  const text = f.misconceptionText ?? f.activeMisconceptions.join(" ");
  if (!text.trim()) return 0;
  const own = new Set(stems(f.name)); // words of the concept itself don't say which prerequisite is at fault
  const cue = new Set(stems(text).filter((w) => !own.has(w) && !FRAMING.has(w)));
  const target = new Set(stems(`${pre.name} ${pre.definition ?? ""}`));
  let n = 0;
  for (const w of cue) if (target.has(w)) n++;
  return n;
}

export function plan(snap: Snapshot): Action {
  const { state } = snap;
  if (state.pendingQuestionId) return { type: "await_answer" };
  if (state.complete) return { type: "complete" };
  if (snap.hasSource && !state.overviewShown) return { type: "overview" };

  // Optional cumulative review of due concepts before continuing.
  if (state.reviewQueue.length) return { type: "review", conceptId: state.reviewQueue[0] };

  const cur = currentConcept(state);
  if (!cur) return state.sinceCheckpoint.length ? { type: "checkpoint" } : { type: "complete" };
  const f = snap.facts(cur);
  const inDetour = state.detours.length > 0;
  const a = attempts(f);
  const last = f.history[f.history.length - 1];

  // ── Concept finished ──
  if (f.mastery.status === "demonstrated") {
    // The engine records the concept and places a checkpoint at major transitions.
    return inDetour ? { type: "return" } : { type: "advance" };
  }

  // ── Never seen in this lesson: use prior knowledge before teaching ──
  if (f.history.length === 0) {
    if (f.mastery.status === "needs_review") {
      return { type: "check", conceptId: cur, kind: "application", context: "original", difficulty: 3, purpose: "review", reason: "You learned this before; a quick retrieval check" };
    }
    // Foundations get a short diagnostic probe; new central material is taught first.
    if (f.role !== "central" || f.mastery.status === "developing") {
      return { type: "probe", conceptId: cur, kind: f.mastery.status === "developing" ? "causal" : "application", difficulty: 2 };
    }
    return { type: "explain", conceptId: cur, strategy: nextStrategy(f) ?? "first_principles", purpose: inDetour ? "detour" : "introduce", reason: "New concept" };
  }

  const resetAt = state.streakResets[cur] ?? 0;
  const streak = missStreak(f, resetAt);
  const explained = f.history.some((h) => h.type === "explanation");

  if (last.type === "explanation") {
    const c = nextCheck(f);
    return { type: "check", conceptId: cur, ...c };
  }

  // last event is an attempt
  if (last.correct === true) {
    // Correct but unsure/guessed before any teaching → a possible gap: teach it.
    if (!explained && last.confidence !== "sure") {
      return { type: "explain", conceptId: cur, strategy: nextStrategy(f) ?? "first_principles", purpose: inDetour ? "detour" : "introduce", reason: "You got it right but weren't sure, so the idea deserves a proper look" };
    }
    // Right answer, flawed written reasoning → teach the reasoning before moving on.
    if (last.reasoning === "flawed" && !strategiesInLesson(f).length) {
      return { type: "explain", conceptId: cur, strategy: nextStrategy(f) ?? "first_principles", purpose: "remediate", reason: "Your answer was right but the reasoning behind it wasn't" };
    }
    const c = nextCheck(f);
    return { type: "check", conceptId: cur, ...c };
  }

  // last attempt wrong or "I don't know"
  if (streak >= 2) {
    const target = detourTarget(snap, f);
    if (target) {
      return {
        type: "detour",
        conceptId: target,
        fromConceptId: cur,
        reason: `Two misses in a row on ${f.name} suggest the difficulty may sit in ${snap.facts(target).name}, which it builds on`,
      };
    }
  }
  if (strategiesInLesson(f).length >= MAX_STRATEGIES_PER_LESSON || (streak >= 2 && nextStrategy(f) === null)) {
    return { type: "stuck", conceptId: cur, reason: `Several different explanations of ${f.name} haven't clicked yet` };
  }
  const strategy = nextStrategy(f);
  if (!strategy) return { type: "stuck", conceptId: cur, reason: `All teaching strategies for ${f.name} have been tried` };
  if (state.justReturned?.conceptId === cur) {
    return { type: "explain", conceptId: cur, strategy, purpose: "return", reason: "Reconnecting the prerequisite you just studied" };
  }
  return {
    type: "explain",
    conceptId: cur,
    strategy,
    purpose: last.correct === null && !explained ? (inDetour ? "detour" : "introduce") : "remediate",
    reason: last.correct === null ? "You said you didn't know, which is a gap to fill, not a mistake" : "Trying a different way in, not a rewording",
  };
}

/** True when the concept just finished should trigger a checkpoint. */
export function shouldCheckpoint(state: LessonState, isLast: boolean): boolean {
  return state.sinceCheckpoint.length >= CHECKPOINT_EVERY || (isLast && state.sinceCheckpoint.length > 0);
}

export { attempts as attemptFacts };

// Evidence-based mastery. Understanding is tracked as separate evidence
// dimensions; a status is derived from them with explicit, inspectable rules.
// No single correct answer can produce "demonstrated".
import type {
  Confidence,
  EvidenceDimension,
  MasteryStatus,
  MasterySummary,
  QuestionKind,
  QuestionPurpose,
  ReasoningEvaluation,
} from "./schemas.ts";

export interface EvidenceItem {
  dimension: EvidenceDimension;
  /** Signed strength: positive supports understanding, negative contradicts it. */
  delta: number;
  at: string; // ISO timestamp
  note?: string;
}

export const DIMENSIONS: EvidenceDimension[] = [
  "recognition",
  "explanation",
  "application",
  "transfer",
  "retention",
  "calibration",
];

/** Which dimension a question kind primarily tests. */
export function primaryDimension(kind: QuestionKind): EvidenceDimension {
  switch (kind) {
    case "conceptual":
      return "recognition";
    case "application":
    case "multi_step":
      return "application";
    default:
      return "explanation";
  }
}

const CORRECT_WEIGHT: Record<Confidence, number> = { sure: 1, unsure: 0.6, guess: 0.25 };
const WRONG_WEIGHT: Record<Confidence, number> = { sure: -1, unsure: -0.7, guess: -0.4 };
const DONT_KNOW_WEIGHT = -0.5;
/** Positive deltas below this never accumulate toward "positive": lucky guesses are not evidence. */
const MIN_COUNTED_DELTA = 0.5;
/** Accumulated positive strength needed since the last negative: one sure answer, or two unsure ones. */
const POSITIVE_THRESHOLD = 0.9;

export interface AttemptFacts {
  kind: QuestionKind;
  context: "original" | "novel";
  purpose: QuestionPurpose;
  correct: boolean | null; // null = "I don't know"
  confidence: Confidence | null;
  /** Verdict on the learner's optional written reasoning; null when none was written (or pending). */
  reasoning: ReasoningEvaluation["verdict"] | null;
}

/**
 * Translate one graded attempt into evidence. This is where the learning-science
 * rules live:
 *  - confidence scales evidence (correct+guess is almost nothing; wrong+sure is strong);
 *  - "I don't know" is a gap, not a misconception, and carries no calibration penalty;
 *  - written reasoning is judged separately: a correct pick with flawed reasoning
 *    only earns recognition, and counts *against* explanation;
 *  - novel-context application is transfer evidence.
 */
export function evidenceFromAttempt(f: AttemptFacts, at: string): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const primary = primaryDimension(f.kind);
  const add = (dimension: EvidenceDimension, delta: number, note: string) => out.push({ dimension, delta, at, note });

  if (f.correct === null) {
    add(primary, DONT_KNOW_WEIGHT, "said “I don't know”");
    if (f.purpose === "review") add("retention", -1, "could not recall on review");
    return out;
  }

  const confidence = f.confidence ?? "unsure";
  const isTransfer = f.context === "novel" && primary !== "recognition";

  if (f.correct) {
    const w = CORRECT_WEIGHT[confidence];
    if (f.reasoning === "flawed" || f.reasoning === "off_topic") {
      // Right answer, wrong reasons: weak recognition only.
      add("recognition", Math.min(w, 0.5), "correct choice, but the written reasoning was flawed");
      add("explanation", -0.8, "written reasoning did not support the answer");
    } else {
      add(primary, w, `correct (${confidence})`);
      if (isTransfer) add("transfer", w, `correct in an unfamiliar context (${confidence})`);
      if (f.reasoning === "sound" && primary !== "explanation") add("explanation", w, "sound written reasoning");
      if (f.reasoning === "partially_sound") add("explanation", 0.3, "partially sound written reasoning");
    }
    if (f.purpose === "review") add("retention", w, `recalled on review (${confidence})`);
  } else {
    const w = WRONG_WEIGHT[confidence];
    add(primary, w, `incorrect (${confidence})`);
    if (isTransfer) add("transfer", w, "incorrect in an unfamiliar context");
    if (f.purpose === "review") add("retention", -1, "missed on review");
  }

  // Calibration: does stated confidence match outcome?
  if (confidence === "sure") add("calibration", f.correct ? 0.5 : -1, f.correct ? "confident and correct" : "confident but wrong");
  else if (confidence === "guess") add("calibration", f.correct ? -0.25 : 0.5, f.correct ? "correct guess (underconfident?)" : "knew it was a guess");
  else add("calibration", f.correct ? 0.25 : 0.25, "appropriately unsure");

  return out;
}

export type DimensionState = "none" | "positive" | "negative" | "weak";

/** Walk evidence in time order: a negative resets accumulated support. */
export function dimensionState(items: EvidenceItem[]): DimensionState {
  if (items.length === 0) return "none";
  let acc = 0;
  let last: number | null = null;
  for (const e of items) {
    last = e.delta;
    if (e.delta < 0) acc = 0;
    else if (e.delta >= MIN_COUNTED_DELTA) acc += e.delta;
  }
  if (last !== null && last < 0) return "negative";
  if (acc >= POSITIVE_THRESHOLD) return "positive";
  return acc > 0 || (last !== null && last > 0) ? "weak" : "none";
}

/** Spaced review intervals (days), indexed by successful retention checks so far. */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 21, 60, 120];

export interface MasteryOptions {
  /** Central concepts must also show transfer to an unfamiliar context. */
  central: boolean;
  activeMisconceptions: { label: string }[];
  now: Date;
}

export function computeMastery(conceptId: string, evidence: EvidenceItem[], opts: MasteryOptions): MasterySummary {
  const sorted = [...evidence].sort((a, b) => a.at.localeCompare(b.at));
  const byDim = Object.fromEntries(DIMENSIONS.map((d) => [d, sorted.filter((e) => e.dimension === d)])) as Record<
    EvidenceDimension,
    EvidenceItem[]
  >;
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, dimensionState(byDim[d])])) as MasterySummary["dimensions"];
  const lastEvidenceAt = sorted.length ? sorted[sorted.length - 1].at : null;
  const reasons: string[] = [];

  if (sorted.filter((e) => e.dimension !== "calibration").length === 0) {
    return { conceptId, status: "not_assessed", dimensions: dims, reasons: ["No evidence yet"], lastEvidenceAt };
  }

  const understands = dims.recognition === "positive" || dims.explanation === "positive";
  const applies = dims.application === "positive";
  const transfers = !opts.central || dims.transfer === "positive";
  const reasoningOk = dims.explanation !== "negative";
  const noMisconceptions = opts.activeMisconceptions.length === 0;

  if (!understands) reasons.push("Needs solid evidence of understanding (a confident correct conceptual or reasoning answer)");
  if (!applies) reasons.push("Needs confident correct application to a scenario");
  if (!transfers) reasons.push("Needs to apply it correctly in an unfamiliar context");
  if (!reasoningOk) reasons.push("Most recent written reasoning was flawed");
  for (const m of opts.activeMisconceptions) reasons.push(`Unresolved misconception: ${m.label}`);
  for (const d of ["recognition", "explanation", "application", "transfer"] as const) {
    if (dims[d] === "weak") reasons.push(`${d[0].toUpperCase()}${d.slice(1)}: correct but not yet confident`);
  }

  let status: MasteryStatus = "developing";
  if (understands && applies && transfers && reasoningOk && noMisconceptions) {
    status = "demonstrated";
    const retentionWins = byDim.retention.filter((e) => e.delta >= MIN_COUNTED_DELTA).length;
    const interval = REVIEW_INTERVALS_DAYS[Math.min(retentionWins, REVIEW_INTERVALS_DAYS.length - 1)];
    const lastPositive = [...sorted].reverse().find((e) => e.delta >= MIN_COUNTED_DELTA && e.dimension !== "calibration");
    const ageDays = lastPositive ? (opts.now.getTime() - Date.parse(lastPositive.at)) / 86_400_000 : 0;
    if (dims.retention === "negative") {
      status = "needs_review";
      reasons.push("Missed on the most recent review");
    } else if (ageDays > interval) {
      status = "needs_review";
      reasons.push(`Last demonstrated ${Math.floor(ageDays)} days ago (review interval ${interval} days)`);
    } else {
      reasons.length = 0;
      reasons.push("Understood, applied" + (opts.central ? ", and transferred to a new context" : "") + " with confidence");
    }
  }
  return { conceptId, status, dimensions: dims, reasons, lastEvidenceAt };
}

/** When a demonstrated concept is next due for spaced review. */
export function nextReviewAt(evidence: EvidenceItem[]): string | null {
  const sorted = [...evidence].sort((a, b) => a.at.localeCompare(b.at));
  const lastPositive = [...sorted].reverse().find((e) => e.delta >= MIN_COUNTED_DELTA && e.dimension !== "calibration");
  if (!lastPositive) return null;
  const wins = sorted.filter((e) => e.dimension === "retention" && e.delta >= MIN_COUNTED_DELTA).length;
  const days = REVIEW_INTERVALS_DAYS[Math.min(wins, REVIEW_INTERVALS_DAYS.length - 1)];
  return new Date(Date.parse(lastPositive.at) + days * 86_400_000).toISOString();
}

/** Aggregate calibration across attempts, for an interpretable summary. */
export function calibrationSummary(attempts: { correct: boolean | null; confidence: Confidence | null }[]) {
  const c = { sureRight: 0, sureWrong: 0, unsureRight: 0, unsureWrong: 0, guessRight: 0, guessWrong: 0, dontKnow: 0 };
  for (const a of attempts) {
    if (a.correct === null) c.dontKnow++;
    else if (a.confidence === "sure") a.correct ? c.sureRight++ : c.sureWrong++;
    else if (a.confidence === "guess") a.correct ? c.guessRight++ : c.guessWrong++;
    else a.correct ? c.unsureRight++ : c.unsureWrong++;
  }
  const sureTotal = c.sureRight + c.sureWrong;
  let verdict = "Not enough answers yet";
  if (sureTotal >= 3) {
    const acc = c.sureRight / sureTotal;
    verdict = acc >= 0.85 ? "Well calibrated: “Sure” answers are reliably right" : acc >= 0.6 ? "Slightly overconfident" : "Overconfident: many “Sure” answers were wrong";
  }
  return { ...c, verdict };
}

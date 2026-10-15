import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createContext, type AppContext, type ContextOptions } from "../src/server/context.ts";
import { testEncryption } from "../src/server/providers/keychain.ts";
import { findFixture } from "../src/server/providers/mock/curriculum.ts";
import type { QuestionView } from "../src/shared/schemas.ts";

export function tmpDir(prefix = "learn-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fresh app context on a temp data dir with the deterministic mock provider. */
export function testContext(o: ContextOptions = {}): AppContext {
  const dataDir = o.dataDir ?? tmpDir();
  return createContext({ dataDir, dbFile: o.dbFile ?? join(dataDir, "learn.db"), forceProvider: "mock", encryption: testEncryption(), claudeBin: "/nonexistent/claude", siwcDir: "/nonexistent/siwc", ...o });
}

export const MARKOV_LECTURE: string[][] = [
  ["Lecture 4: Markov Chains for Sequences", "Probabilistic Models"],
  ["Motivation", "Many quantities arrive as sequences: daily weather, letters in text, DNA bases.", "Goal: assign probabilities to whole sequences and predict the next symbol."],
  ["Review: conditional probability", "P(A | B) = P(A and B) / P(B)", "Conditioning restricts attention to outcomes where B occurred."],
  ["The chain rule", "P(x1, ..., xn) = P(x1) P(x2 | x1) ... P(xn | x1, ..., xn-1)", "This factorisation is exact for any sequence."],
  ["Why we need assumptions", "The number of possible histories grows exponentially with length.", "We cannot estimate a separate distribution for every history."],
  ["The Markov assumption", "First-order: P(xt | x1, ..., xt-1) = P(xt | xt-1)", "The present screens off the past."],
  ["Transition matrices", "A[i][j] = P(next = j | current = i), and each row sums to 1.", "A first-order chain with k states has k x k transition probabilities."],
  ["Example: a weather chain", "sun to sun 0.8, sun to rain 0.2, rain to sun 0.4, rain to rain 0.6"],
  ["Second-order Markov models", "P(xt | x1, ..., xt-1) = P(xt | xt-1, xt-2)", "Two symbols of memory."],
  ["Second-order as a chain on pairs", "Define the state as the pair of previous symbols (xt-1, xt)."],
  ["Estimating transition probabilities", "Count how often each context is followed by each symbol, then normalise by the context count."],
  ["Summary", "Chain rule (exact) plus a limited-memory assumption gives tractable sequence models."],
];

// Exam practice: a two-problem study guide, its solutions, and a lecture that teaches both.
export const PRACTICE_GUIDE: string[][] = [
  ["Practice Exam (demo)", "Two worked problems on edit distance and entropy."],
  [
    "Problem 1: Edit distance",
    "Let X = GCA and Y = GAC. Insertion, deletion and substitution cost 1.",
    "(a) Complete the matrix D, including the boundary row and column.",
    "(b) Report the edit distance.",
    "(c) Explain what the three candidates in the recurrence represent.",
  ],
  [
    "Problem 2: Entropy",
    "A source emits a and b with probability 1/4 each,",
    "and c, d, e and f with probability 1/8 each.",
    "(a) Give the self-information of each symbol.",
    "(b) Compute the entropy H(X).",
    "(c) Compute the entropy of a uniform source on six symbols.",
    "(d) Which source has the greater entropy?",
  ],
];

export const PRACTICE_SOLUTIONS: string[][] = [
  ["Practice Exam (demo): Solutions"],
  [
    "Problem 1: Edit distance",
    "The complete matrix has rows eps, G, C, A and columns eps, G, A, C.",
    "Rows: 0 1 2 3 / 1 0 1 2 / 2 1 1 1 / 3 2 1 2.",
    "The edit distance is D(3,3) = 2.",
    "The candidates delete X_i, insert Y_j, or match or substitute.",
  ],
  [
    "Problem 2: Entropy",
    "Self-information: a and b carry 2 bits; c, d, e and f carry 3 bits.",
    "H(X) = 2(1/4)(2) + 4(1/8)(3) = 2.5 bits.",
    "The uniform source has entropy log2 6 = 2.585 bits, which is greater.",
  ],
];

/** Page 6 imitates text extracted with a dropped "fi" ligature ("Suf x" for "Suffix"). */
export const ALIGNMENT_LECTURE: string[][] = [
  ["Lecture 5: Alignment and information", "Computational Genomics"],
  ["Edit distance", "The Levenshtein edit distance counts insertions, deletions and substitutions."],
  ["Edit distance by dynamic programming", "D(i,j) is the minimum of three candidates: delete, insert, or match/substitute.", "Fill the table row by row, starting from the empty prefixes."],
  ["Self-information", "I(E) = -log2 P(E): rare events carry more information."],
  ["Entropy", "Entropy is expected self-information: H(X) = -sum p(x) log2 p(x).", "A uniform source has the maximum entropy."],
  ["Suf x arrays", "A suf x array lists the starting positions of the sorted suf xes."],
];

export async function makePdf(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  for (const lines of pages) {
    const page = doc.addPage([720, 405]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 340 - i * 34, size: i === 0 ? 22 : 14, font }));
  }
  return doc.save({ useObjectStreams: false });
}

// ── Simulated learner for deterministic educational tests ───────────────────

export interface LearnerAnswer {
  selected: string[];
  dontKnow: boolean;
  confidence: "sure" | "unsure" | "guess" | null;
  note?: string;
}

export interface LearnerModel {
  /** Misconception labels the learner holds, per concept slug. */
  misconceptions: Record<string, string[]>;
  /** A misconception disappears once the learner has seen these explanation strategies (any one), or N explanations. */
  fixedBy: Record<string, { strategies?: string[]; explanations?: number }>;
  /** Concepts the learner has never heard of (answers "I don't know" until taught). */
  unknown?: string[];
  /** Written notes to attach: per concept, while holding the misconception / after understanding. */
  notes?: Record<string, { flawed?: string; sound?: string }>;
}

export function simulateAnswer(model: LearnerModel, conceptName: string, q: QuestionView, seenStrategies: string[]): LearnerAnswer {
  const slug = findFixture(conceptName)?.slug ?? conceptName;
  const fix = model.fixedBy[slug];
  const fixed = fix && ((fix.strategies && seenStrategies.some((s) => fix.strategies!.includes(s))) || (fix.explanations !== undefined && seenStrategies.length >= fix.explanations));
  if (model.unknown?.includes(slug) && seenStrategies.length === 0) return { selected: [], dontKnow: true, confidence: null };
  const fixture = findFixture(conceptName)?.questions.find((x) => x.stem === q.stem);
  const held = fixed ? [] : model.misconceptions[slug] ?? [];
  if (fixture && held.length) {
    const wrong = fixture.options.find((o) => o.misconception && held.includes(o.misconception));
    if (wrong) return { selected: [wrong.value], dontKnow: false, confidence: "sure", ...(model.notes?.[slug]?.flawed ? { note: model.notes[slug].flawed } : {}) };
    // Holds a misconception this question doesn't probe: right answer, but unsure.
    return { selected: [String(fixture.correct)], dontKnow: false, confidence: "unsure" };
  }
  const correct = fixture ? (Array.isArray(fixture.correct) ? fixture.correct : [fixture.correct]) : ["def"];
  return { selected: correct, dontKnow: false, confidence: "sure", ...(model.notes?.[slug]?.sound ? { note: model.notes[slug].sound } : {}) };
}

import type { Engine } from "../src/server/teaching/engine.ts";
import { lessonView } from "../src/server/teaching/view.ts";

/** Drive a lesson with a simulated learner until `stop` returns true, the lesson completes, or `maxSteps`. */
export async function runLesson(ctx: AppContext, lessonId: string, learner: LearnerModel, opts: { maxSteps?: number; stop?: (ctx: AppContext) => boolean } = {}) {
  const engine: Engine = ctx.engine;
  for (let i = 0; i < (opts.maxSteps ?? 120); i++) {
    if (opts.stop?.(ctx)) return;
    const lesson = ctx.repo.getLesson(lessonId)!;
    if (lesson.state.complete) return;
    if (lesson.state.pendingQuestionId) {
      const q = pendingQuestion(ctx, lessonId)!;
      const name = ctx.repo.getConcept(q.conceptId)!.name;
      const seen = ctx.repo.listBlocks(lessonId).filter((b) => b.type === "explanation" && b.conceptId === q.conceptId).map((b) => b.payload.strategy);
      await engine.answer(lessonId, q.id, simulateAnswer(learner, name, q, seen));
    } else {
      const { created } = await engine.advance(lessonId);
      if (!created.length && !ctx.repo.getLesson(lessonId)!.state.pendingQuestionId && !ctx.repo.getLesson(lessonId)!.state.complete) throw new Error("lesson made no progress");
    }
  }
}

export function pendingQuestion(ctx: AppContext, lessonId: string) {
  const lesson = ctx.repo.getLesson(lessonId)!;
  return lessonView(ctx.engine, lesson).blocks.find((b) => b.type === "question" && b.question?.id === lesson.state.pendingQuestionId)?.question;
}

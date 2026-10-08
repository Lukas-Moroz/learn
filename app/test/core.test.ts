import { describe, expect, it } from "vitest";
import { coerceCorrectAnswer, grade, normalizeOptions, optionShapeProblem, resolveCorrect, seededRandom, shuffle } from "../src/shared/grading.ts";
import { computeMastery, dimensionState, evidenceFromAttempt, type EvidenceItem } from "../src/shared/mastery.ts";
import { parrotingScore, questionSimilarity, repetitionProblem } from "../src/shared/similarity.ts";
import { extractSections } from "../src/server/ai/principles.ts";
import { teachingPrinciples } from "../src/server/ai/principles.ts";

const opts = normalizeOptions([
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", misconception: "confuses alpha with beta" },
  { value: "c", label: "Gamma" },
]);

describe("grading (ported from the pi quiz tool)", () => {
  it("keys answers by value, so shuffling cannot break grading", () => {
    const correct = resolveCorrect("a", opts);
    for (let i = 0; i < 5; i++) {
      const shuffled = shuffle(opts, seededRandom(`s${i}`));
      expect(grade(shuffled, correct, { selected: ["a"], dontKnow: false }).correct).toBe(true);
      expect(grade(shuffled, correct, { selected: ["b"], dontKnow: false }).correct).toBe(false);
    }
  });
  it("treats I don't know as a distinct outcome, never right or wrong", () => {
    expect(grade(opts, ["a"], { selected: [], dontKnow: true }).correct).toBeNull();
  });
  it("reports the misconception attached to the chosen distractor", () => {
    expect(grade(opts, ["a"], { selected: ["b"], dontKnow: false }).misconceptions).toEqual(["confuses alpha with beta"]);
  });
  it("multi-select is an exact-set match", () => {
    expect(grade(opts, ["a", "c"], { selected: ["a"], dontKnow: false }).correct).toBe(false);
    expect(grade(opts, ["a", "c"], { selected: ["c", "a"], dontKnow: false }).correct).toBe(true);
  });
  it("parses JSON-stringified multi-select answers and rejects unknown values", () => {
    expect(coerceCorrectAnswer('["a","c"]')).toEqual(["a", "c"]);
    expect(() => resolveCorrect("zzz", opts)).toThrow(/does not match/);
    expect(() => normalizeOptions([{ value: "x", label: "1" }, { value: "x", label: "2" }])).toThrow(/duplicate/);
  });
  it("flags a correct option that stands out by length", () => {
    const o = normalizeOptions([
      { value: "r", label: "Because conditioning restricts the outcome space to B and then renormalises every probability inside it" },
      { value: "w1", label: "Because it is smaller" },
      { value: "w2", label: "Because of independence" },
    ]);
    expect(optionShapeProblem(o, ["r"])).toMatch(/longer/);
  });
});

const T0 = "2026-01-01T00:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const ev = (facts: Parameters<typeof evidenceFromAttempt>[0], min: number) => evidenceFromAttempt(facts, at(min));
const base = { context: "original" as const, purpose: "check" as const, reasoning: null };

describe("mastery evidence", () => {
  it("SCENARIO 1: a correct answer with low confidence records uncertainty, not mastery", () => {
    const e = ev({ ...base, kind: "application", correct: true, confidence: "unsure" }, 0);
    const m = computeMastery("c", e, { central: false, activeMisconceptions: [], now: new Date(at(1)) });
    expect(m.status).toBe("developing");
    expect(m.dimensions.application).toBe("weak");
    expect(m.reasons.join(" ")).toMatch(/not yet confident/);
  });

  it("a single confident correct answer is still not mastery", () => {
    const e = ev({ ...base, kind: "conceptual", correct: true, confidence: "sure" }, 0);
    const m = computeMastery("c", e, { central: false, activeMisconceptions: [], now: new Date(at(1)) });
    expect(m.status).toBe("developing");
  });

  it("guesses never accumulate into evidence", () => {
    const e = [0, 1, 2, 3, 4].flatMap((i) => ev({ ...base, kind: "application", correct: true, confidence: "guess" }, i));
    expect(dimensionState(e.filter((x) => x.dimension === "application"))).toBe("weak");
  });

  it("SCENARIO 2: correct choice with flawed written reasoning counts against explanation", () => {
    const e = ev({ ...base, kind: "causal", correct: true, confidence: "sure", reasoning: "flawed" }, 0);
    expect(e.find((x) => x.dimension === "explanation")!.delta).toBeLessThan(0);
    expect(e.find((x) => x.dimension === "recognition")!.delta).toBeLessThanOrEqual(0.5);
    const all: EvidenceItem[] = [
      ...e,
      ...ev({ ...base, kind: "application", correct: true, confidence: "sure" }, 1),
      ...ev({ ...base, kind: "conceptual", correct: true, confidence: "sure" }, 2),
    ];
    const m = computeMastery("c", all, { central: false, activeMisconceptions: [], now: new Date(at(3)) });
    expect(m.status).toBe("developing");
    expect(m.reasons.join(" ")).toMatch(/reasoning was flawed/);
  });

  it("demonstrated needs understanding + application (+ transfer for central concepts)", () => {
    const e = [
      ...ev({ ...base, kind: "causal", correct: true, confidence: "sure" }, 0),
      ...ev({ ...base, kind: "application", correct: true, confidence: "sure" }, 1),
    ];
    expect(computeMastery("c", e, { central: false, activeMisconceptions: [], now: new Date(at(2)) }).status).toBe("demonstrated");
    expect(computeMastery("c", e, { central: true, activeMisconceptions: [], now: new Date(at(2)) }).status).toBe("developing");
    const withTransfer = [...e, ...ev({ ...base, kind: "application", context: "novel", correct: true, confidence: "sure" }, 3)];
    expect(computeMastery("c", withTransfer, { central: true, activeMisconceptions: [], now: new Date(at(4)) }).status).toBe("demonstrated");
    expect(computeMastery("c", withTransfer, { central: true, activeMisconceptions: [{ label: "x" }], now: new Date(at(4)) }).status).toBe("developing");
  });

  it("confident wrong answers outweigh guesses; I don't know carries no calibration penalty", () => {
    const sureWrong = ev({ ...base, kind: "application", correct: false, confidence: "sure" }, 0);
    const guessWrong = ev({ ...base, kind: "application", correct: false, confidence: "guess" }, 0);
    expect(sureWrong[0].delta).toBeLessThan(guessWrong[0].delta);
    expect(sureWrong.find((x) => x.dimension === "calibration")!.delta).toBeLessThan(0);
    const dk = ev({ ...base, kind: "application", correct: null, confidence: null }, 0);
    expect(dk.find((x) => x.dimension === "calibration")).toBeUndefined();
  });

  it("demonstrated concepts become needs-review after the spaced interval", () => {
    const e = [
      ...ev({ ...base, kind: "causal", correct: true, confidence: "sure" }, 0),
      ...ev({ ...base, kind: "application", correct: true, confidence: "sure" }, 1),
    ];
    const later = new Date(Date.parse(T0) + 3 * 86_400_000);
    expect(computeMastery("c", e, { central: false, activeMisconceptions: [], now: later }).status).toBe("needs_review");
  });
});

describe("question repetition checks", () => {
  it("rejects a near-copy or a reused scenario, accepts a genuinely different question", () => {
    const prior = [{ text: "In a class, 40% take statistics and 10% take both. What is P(econ | stats)?", scenario: "students" }];
    expect(repetitionProblem({ text: "In a class, 40% take statistics and 10% take both. What is P(econ given stats)?", scenario: "x" }, prior, null)).toMatch(/similar/);
    expect(repetitionProblem({ text: "anything", scenario: "Students" }, prior, null)).toMatch(/scenario/);
    expect(repetitionProblem({ text: "A screening test is positive 90% of the time for sick people. How likely is a positive person sick?", scenario: "medical" }, prior, null)).toBeNull();
  });
  it("detects a question that parrots the explanation's wording", () => {
    const expl = "Conditioning restricts the outcome space to the event B and then renormalises probabilities inside B.";
    expect(parrotingScore("Conditioning restricts the outcome space to the event B and then what happens?", expl)).toBeGreaterThan(0.3);
    expect(questionSimilarity("a b c d", "w x y z")).toBe(0);
  });
});

describe("teaching principles come from the pi skill", () => {
  it("extracts the philosophy and quiz-construction sections from skills/teach/SKILL.md", () => {
    const text = teachingPrinciples();
    expect(text).toMatch(/Principle i/);
    expect(text).toMatch(/How could I have discovered this/);
    expect(text).toMatch(/Writing quiz options/);
    expect(extractSections("## A\nx\n## B\ny\n### B1\nz\n## C\nw", ["B"])).toBe("## B\ny\n### B1\nz");
  });
});

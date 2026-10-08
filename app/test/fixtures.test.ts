import { describe, expect, it } from "vitest";
import { CURRICULUM } from "../src/server/providers/mock/curriculum.ts";
import { normalizeOptions, optionShapeProblem, resolveCorrect } from "../src/shared/grading.ts";
import { ExplanationContent, QuestionContent } from "../src/shared/schemas.ts";
import { questionSimilarity } from "../src/shared/similarity.ts";

// The fixture curriculum must pass the same quality gates applied to live model output.
describe("fixture curriculum quality", () => {
  for (const c of CURRICULUM) {
    it(`${c.slug}: questions are valid, parallel, misconception-mapped and distinct`, () => {
      const scenarios = new Set<string>();
      for (const q of c.questions) {
        expect(QuestionContent.safeParse({ ...q, refs: [] }).success).toBe(true);
        const o = normalizeOptions(q.options);
        const correct = resolveCorrect(q.correct, o);
        expect(optionShapeProblem(o, correct), q.scenario).toBeNull();
        for (const d of o.filter((x) => !correct.includes(x.value))) expect(d.misconception, `${q.scenario}: ${d.label}`).toBeTruthy();
        expect(scenarios.has(q.scenario)).toBe(false);
        scenarios.add(q.scenario);
      }
      for (let i = 0; i < c.questions.length; i++)
        for (let j = i + 1; j < c.questions.length; j++) expect(questionSimilarity(c.questions[i].stem, c.questions[j].stem)).toBeLessThan(0.5);
      expect(c.questions.some((q) => q.context === "novel")).toBe(true);
    });
    it(`${c.slug}: has at least two genuinely different explanation strategies`, () => {
      const strategies = Object.keys(c.explanations);
      expect(strategies.length).toBeGreaterThanOrEqual(2);
      for (const [strategy, e] of Object.entries(c.explanations)) {
        expect(ExplanationContent.safeParse({ ...e, strategy, refs: [] }).success).toBe(true);
        if (e!.analogy) expect(e!.analogy.breaksDown.length).toBeGreaterThan(20);
      }
    });
  }
});

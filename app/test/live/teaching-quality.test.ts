// OPT-IN live evaluation of teaching quality against your configured subscription
// provider. Uses ~4 requests from your plan allowance. Run: `npm run eval:live`.
// It reuses your provider settings and stored ChatGPT sign-in from the data dir, but
// writes to a throwaway database, so your learning history is untouched.
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext, defaultDataDir } from "../../src/server/context.ts";
import { DB } from "../../src/server/db/database.ts";
import { importFile } from "../../src/server/ingest/import.ts";
import { normalizeOptions, optionShapeProblem, resolveCorrect } from "../../src/shared/grading.ts";
import { parrotingScore } from "../../src/shared/similarity.ts";
import { MARKOV_LECTURE, makePdf, tmpDir } from "../helpers.ts";

const enabled = process.env.LEARN_LIVE_EVAL === "1";

describe.skipIf(!enabled)("live teaching quality: second-order Markov models", async () => {
  const realDir = defaultDataDir();
  const scratch = tmpDir("learn-live-");
  const ctx = createContext({ dataDir: realDir, dbFile: join(scratch, "eval.db"), forceProvider: null });
  // Bring over provider settings (which provider, which model), nothing else.
  if (existsSync(join(realDir, "learn.db"))) {
    copyFileSync(join(realDir, "learn.db"), join(scratch, "settings-source.db"));
    const src = new DB(join(scratch, "settings-source.db"));
    for (const row of src.prepare("SELECT key, value_json FROM settings").all() as { key: string; value_json: string }[]) ctx.repo.setSetting(row.key, JSON.parse(row.value_json));
    src.close();
  }
  const status = await ctx.router.statuses();
  const active = status.providers.find((p) => p.id === status.active)!;
  if (!active?.ready) throw new Error(`Live eval needs a ready provider; ${status.active} says: ${active?.message}`);
  console.log(`Live eval using ${active.label}${active.model ? ` (${active.model})` : ""}`);

  const course = ctx.repo.createCourse("Live eval");
  const r = await importFile(ctx.repo, scratch, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const pages = ctx.repo.getPages(r.source.id).map((text, i) => ({ page: i + 1, text }));
  const concept = { name: "Second-order Markov model", definition: "P(x_t | x_1..x_{t-1}) = P(x_t | x_{t-1}, x_{t-2})" };

  const explanation = await ctx.gen.run("explain", {
    concept,
    strategy: "first_principles",
    purpose: "introduce",
    avoidStrategies: [],
    learner: { known: ["Conditional probability", "First-order Markov model"], misconceptions: [], recentAttempts: [] },
    connectTo: ["First-order Markov model"],
    source: { unit: "page", pages: pages.slice(8, 10) },
  });
  console.log("\n--- EXPLANATION ---\n", JSON.stringify(explanation, null, 1));

  it("cites only pages that exist, with quotes that are really there", () => {
    for (const ref of explanation.refs) {
      expect(ref.page).toBeGreaterThanOrEqual(1);
      expect(ref.page).toBeLessThanOrEqual(pages.length);
      if (ref.quote) expect(pages[ref.page - 1].text.replace(/\s+/g, " ").toLowerCase()).toContain(ref.quote.replace(/\s+/g, " ").toLowerCase().slice(0, 40));
    }
  });

  it("explains an equation's purpose, behaviour and assumptions when it uses one", () => {
    if (explanation.equation) {
      expect(explanation.equation.purpose.length).toBeGreaterThan(20);
      expect(explanation.equation.terms.length).toBeGreaterThan(0);
      expect(explanation.equation.behavior.length + explanation.equation.assumptions.length).toBeGreaterThan(0);
    }
    if (explanation.analogy) expect(explanation.analogy.breaksDown.length).toBeGreaterThan(20);
    expect(explanation.connections.length).toBeGreaterThan(0);
  });

  const question = await ctx.gen.run("question", {
    concept,
    kind: "application",
    context: "novel",
    purpose: "transfer",
    difficulty: 3,
    avoid: [{ stem: "In a second-order weather model, which quantity gives the chance of rain tomorrow?", scenario: "weather" }],
    recentExplanation: explanation.body,
    targetMisconceptions: ["thinks 'second order' means predicting two steps ahead"],
    source: null,
  });
  console.log("\n--- QUESTION ---\n", JSON.stringify(question, null, 1));

  it("writes a transfer question that is not a recognition check of the explanation", () => {
    expect(question.context).toBe("novel");
    expect(question.scenario.toLowerCase()).not.toContain("weather");
    expect(parrotingScore(question.stem, explanation.body)).toBeLessThan(0.3);
  });

  it("builds parallel options with misconception-based distractors", () => {
    const options = normalizeOptions(question.options);
    const correct = resolveCorrect(question.correct, options);
    expect(optionShapeProblem(options, correct)).toBeNull();
    for (const o of options.filter((x) => !correct.includes(x.value))) expect(o.misconception).toBeTruthy();
  });

  const evaluation = await ctx.gen.run("evaluate_reasoning", {
    question: { stem: question.stem, options: question.options.map((o) => ({ value: o.value, label: o.label })) },
    correctValues: resolveCorrect(question.correct, normalizeOptions(question.options)),
    selected: [String(Array.isArray(question.correct) ? question.correct[0] : question.correct)],
    selectionWasCorrect: true,
    note: "Second order means the model predicts two steps into the future instead of one.",
    rubric: question.rubric,
  });
  console.log("\n--- REASONING EVALUATION ---\n", JSON.stringify(evaluation, null, 1));

  it("judges reasoning independently of a correct selection", () => {
    expect(evaluation.verdict).toBe("flawed");
    expect(evaluation.misconception).toBeDefined();
  });
});

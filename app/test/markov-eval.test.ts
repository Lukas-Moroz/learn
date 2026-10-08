// End-to-end educational evaluation: a simulated learner works from probability
// foundations to second-order Markov models. The learner holds two realistic
// misconceptions. We assert on teaching behaviour, not on rendering.
import { describe, expect, it } from "vitest";
import { importFile } from "../src/server/ingest/import.ts";
import { lessonView } from "../src/server/teaching/view.ts";
import { MARKOV_LECTURE, makePdf, runLesson, testContext, type LearnerModel } from "./helpers.ts";

const learner: LearnerModel = {
  misconceptions: {
    "conditional-probability": ["confuses P(A|B) with P(B|A)"],
    "second-order-markov-model": ["thinks 'second order' means predicting two steps ahead", "thinks the model uses future context"],
  },
  // The inverse confusion survives one explanation; "second order = two steps ahead"
  // only goes away when the two models are contrasted directly.
  fixedBy: { "conditional-probability": { explanations: 2 }, "second-order-markov-model": { strategies: ["contrasting_cases"] } },
  notes: {
    "conditional-probability": { flawed: "P(A|B) and P(B|A) are the same thing either way" },
    "second-order-markov-model": { sound: "the next note is predicted from the previous two notes, the pair is the context" },
  },
};

describe("educational evaluation: second-order Markov models", async () => {
  const ctx = testContext();
  const course = ctx.repo.createCourse("Probabilistic Models");
  const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
  await runLesson(ctx, lesson.id, learner, { maxSteps: 200 });

  const id = (slug: string) => ctx.repo.findConceptBySlug(slug)!.id;
  const blocks = ctx.repo.listBlocks(lesson.id);
  const questions = blocks.filter((b) => b.type === "question").map((b) => ({ block: b, q: ctx.repo.getQuestion(b.payload.questionId)!, a: ctx.repo.attemptsForQuestion(b.payload.questionId)[0] }));
  const of = (slug: string) => questions.filter((x) => x.q.concept_id === id(slug));
  const explanationsOf = (slug: string) => blocks.filter((b) => b.type === "explanation" && b.conceptId === id(slug));

  it("completes, with every concept demonstrated and no unresolved misconceptions", () => {
    const v = lessonView(ctx.engine, ctx.repo.getLesson(lesson.id)!);
    expect(v.state.complete).toBe(true);
    expect(v.concepts.filter((c) => c.onPath).every((c) => c.status === "demonstrated")).toBe(true);
    expect(ctx.repo.misconceptions().filter((m) => m.status !== "resolved")).toHaveLength(0);
  });

  it("probes foundations before teaching central material, and fast-tracks what is already known", () => {
    expect(questions[0].q.purpose).toBe("probe");
    expect(questions[0].q.concept_id).toBe(id("probability"));
    // Probability: known → demonstrated from questions alone, no explanation needed.
    expect(explanationsOf("probability")).toHaveLength(0);
    expect(of("probability").length).toBeLessThanOrEqual(2);
    const firstCentral = blocks.find((b) => b.type === "explanation" && ctx.repo.getLesson(lesson.id)!.state.roles[b.conceptId!] === "central")!;
    const condDone = of("conditional-probability").at(-1)!.block.seq;
    expect(firstCentral.seq).toBeGreaterThan(condDone);
  });

  it("diagnoses the P(A|B)/P(B|A) confusion and changes strategy rather than rewording", () => {
    const misses = of("conditional-probability").filter((x) => x.a.correct === false);
    expect(misses.length).toBe(2);
    expect(misses[0].a.confidence).toBe("sure");
    expect(misses[0].a.reasoning?.verdict).toBe("flawed"); // written reasoning evaluated separately
    const m = ctx.repo.misconceptions(id("conditional-probability"))[0];
    expect(m.label).toBe("confuses P(A|B) with P(B|A)");
    expect(m.occurrences).toBeGreaterThanOrEqual(2);
    expect(m.status).toBe("resolved");
    const strategies = explanationsOf("conditional-probability").map((b) => b.payload.strategy);
    expect(new Set(strategies).size).toBe(strategies.length);
    expect(explanationsOf("conditional-probability").every((b) => b.payload.purpose === "remediate")).toBe(true);
  });

  it("establishes why dependency assumptions matter before using them", () => {
    const why = of("markov-assumption").find((x) => x.q.kind === "causal")!;
    expect(why.q.stem).toMatch(/limited-history/);
    expect(why.a.correct).toBe(true);
    const assumptionDone = of("markov-assumption").at(-1)!.block.seq;
    expect(explanationsOf("first-order-markov-model")[0].seq).toBeGreaterThan(assumptionDone);
    expect(explanationsOf("second-order-markov-model")[0].seq).toBeGreaterThan(assumptionDone);
  });

  it("rotates through different explanations of second-order models until one lands", () => {
    const strategies = explanationsOf("second-order-markov-model").map((b) => b.payload.strategy);
    expect(strategies).toContain("contrasting_cases");
    expect(new Set(strategies).size).toBe(strategies.length);
    const stems = of("second-order-markov-model").map((x) => x.q.stem);
    expect(new Set(stems).size).toBe(stems.length);
  });

  it("asks questions of increasing demand, ending each central concept with transfer", () => {
    for (const slug of ["chain-rule-of-probability", "markov-assumption", "first-order-markov-model", "second-order-markov-model", "estimating-transition-probabilities"]) {
      const qs = of(slug);
      const last = qs.at(-1)!;
      expect(last.q.context, slug).toBe("novel");
      expect(last.q.purpose, slug).toBe("transfer");
      expect(qs.some((x) => x.q.kind === "application" || x.q.kind === "multi_step"), slug).toBe(true);
    }
    // The engine asks for harder questions as confident correct answers accumulate.
    const requested = ctx.mock.calls.filter((c) => c.task === "question");
    for (const name of ["Chain rule of probability", "Markov assumption", "First-order Markov model", "Estimating transition probabilities"]) {
      const d = requested.filter((c) => c.input.concept.name === name).map((c) => c.input.difficulty as number);
      expect(d.at(-1)!, name).toBeGreaterThan(d[0]);
      for (let i = 1; i < d.length; i++) expect(d[i], name).toBeGreaterThanOrEqual(d[i - 1]);
    }
  });

  it("finally explains the model correctly in an unfamiliar context", () => {
    const transfer = of("second-order-markov-model").at(-1)!;
    expect(transfer.q.context).toBe("novel");
    expect(transfer.q.scenario).toMatch(/melody|dna/);
    expect(transfer.a.correct).toBe(true);
    expect(transfer.a.confidence).toBe("sure");
    expect(transfer.a.reasoning?.verdict).toBe("sound");
    const m = ctx.engine.mastery(id("second-order-markov-model"), "central");
    expect(m.dimensions.transfer).toBe("positive");
    expect(m.dimensions.explanation).toBe("positive");
  });

  it("places checkpoints at conceptual transitions and summarises honestly", () => {
    const cps = blocks.filter((b) => b.type === "checkpoint");
    expect(cps.length).toBeGreaterThanOrEqual(3);
    const all = cps.flatMap((c) => c.payload.learned.map((l: { name: string }) => l.name));
    expect(all).toEqual(expect.arrayContaining(["Conditional probability", "Second-order Markov model", "Estimating transition probabilities"]));
    const withMisconception = cps.find((c) => c.payload.misconceptions.some((m: { label: string }) => m.label === "confuses P(A|B) with P(B|A)"))!;
    expect(withMisconception.payload.misconceptions[0].status).toBe("resolved");
    expect(cps.at(-1)!.payload.next).toBeNull();
  });

  it("uses AI calls economically: one analysis, no question regenerated for repetition", () => {
    const tasks = ctx.mock.calls.map((c) => c.task);
    expect(tasks.filter((t) => t === "analyze_source")).toHaveLength(1);
    expect(tasks.filter((t) => t === "question")).toHaveLength(questions.length);
    expect(ctx.repo.jobsForLesson(lesson.id).filter((j) => j.status === "failed")).toHaveLength(0);
  });
});

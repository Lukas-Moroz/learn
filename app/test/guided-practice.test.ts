// Guided practice: warm-up probes before a problem, coaching (not the key) after a miss,
// strategy rotation, the key-leak check, persistence, pauses and migration 3.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { AppContext } from "../src/server/context.ts";
import { DB, MIGRATIONS } from "../src/server/db/database.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { leakedKeyValues } from "../src/shared/practice-leak.ts";
import type { AnswerKey, PracticeProblemView, PracticeSetView, PracticeStepView } from "../src/shared/practice.ts";
import { ALIGNMENT_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf, testContext, tmpDir } from "./helpers.ts";

const H = { "x-learn": "1" };

async function readySet(ctx: AppContext) {
  const course = ctx.repo.createCourse("Computational Genomics");
  const add = async (pages: string[][], filename: string) => importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(pages), filename });
  await add(ALIGNMENT_LECTURE, "Lecture 5 - Alignment.pdf");
  const guide = await add(PRACTICE_GUIDE, "Exam 2 Study Guide.pdf");
  const solutions = await add(PRACTICE_SOLUTIONS, "Exam 2 Study Guide Solutions.pdf");
  const app = createApp(ctx);
  const res = await request(app).post(`/api/courses/${course.id}/practice`).set(H).send({ problemSourceId: guide.source.id, solutionSourceId: solutions.source.id });
  await ctx.practice.extraction(res.body.id);
  const set = (await request(app).get(`/api/practice/${res.body.id}`)).body as PracticeSetView;
  const problem = async (n: number) => (await request(app).get(`/api/practice/problems/${set.problems[n].id}`)).body as PracticeProblemView;
  return { app, set, course, problem };
}

const stepOf = (p: PracticeProblemView, label: string) => p.steps.find((s) => s.label.startsWith(label))!;
type App = ReturnType<typeof createApp>;
const attempt = async (app: App, stepId: string, body: object) => (await request(app).post(`/api/practice/steps/${stepId}/attempt`).set(H).send(body)).body as PracticeStepView;
const check = (app: App, coachingId: string, body: object) => request(app).post(`/api/practice/coaching/${coachingId}/check`).set(H).send(body);
const evidenceOf = (ctx: AppContext, attemptId: string) =>
  ctx.repo.db.prepare("SELECT concept_id, dimension, delta FROM evidence WHERE attempt_id = ? ORDER BY id").all(attemptId) as { concept_id: string; dimension: string; delta: number }[];
const coachCalls = (ctx: AppContext) => ctx.mock.calls.filter((c) => c.task === "practice_coach");

describe("coaching after a miss", () => {
  it("wrong answer → no key → coaching → check answered → retry correct", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const entropy = stepOf(await problem(1), "(b)");

    const wrong = await attempt(app, entropy.id, { value: "3", confidence: "sure" });
    expect(wrong.status).toBe("incorrect");
    expect(wrong.reveal).toBeUndefined();
    expect(wrong.misses).toBe(1);
    expect(wrong.coaching).toEqual([expect.objectContaining({ round: 1, status: "pending", check: null })]);
    // Nothing the client receives carries the key or the worked solution.
    expect(JSON.stringify(wrong)).not.toMatch(/2\.5|"solution"|"expected"/);

    await ctx.practice.idle();
    expect(coachCalls(ctx)).toHaveLength(1); // one explanation request for a typical miss (its check question is a second, separate one)
    const input = coachCalls(ctx)[0].input;
    expect(input.key.expected).toBe("2.5 bits"); // the model sees the key; the learner doesn't
    expect(input.learner).toMatchObject({ answer: "3", confidence: "sure" });
    expect(input.strategy).toBe("first_principles");
    expect(input.lecture.excerpts.map((e: { page: number }) => e.page)).toEqual([4, 5]);

    const p = await problem(1);
    const coached = stepOf(p, "(b)");
    expect(coached.reveal).toBeUndefined();
    const c = coached.coaching[0];
    expect(c).toMatchObject({ status: "ready", round: 1, strategy: "first_principles", diagnosis: expect.stringMatching(/It looks like/), explanation: expect.stringMatching(/Entropy/) });
    expect(c.example).toMatch(/fair coin/);
    expect(c.nextHint).toBeTruthy();
    expect(c.refs[0]).toMatchObject({ page: 5, verified: true, quote: expect.stringMatching(/expected self-information/) });
    expect(c.provenance).toBe("source");
    expect(c.check!.attempt).toBeUndefined();
    expect(JSON.stringify(coached)).not.toMatch(/2\.5|"correctValues"/);

    // The check question: graded deterministically, recorded like a lesson check on the step's concepts.
    const right = c.check!.options.find((o) => o.label.startsWith("One bit"))!.value;
    const answered = (await check(app, c.id, { selected: [right], confidence: "sure" })).body as PracticeStepView;
    expect(answered.coaching[0].check!.attempt).toMatchObject({ correct: true, correctValues: [right], explanation: expect.stringMatching(/logarithm/) });
    const items = evidenceOf(ctx, c.id);
    const entropyId = p.concepts.find((x) => x.name === "Entropy")!.id;
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ concept_id: entropyId, dimension: "application", delta: 1 })]));
    // Answering twice records once.
    await check(app, c.id, { selected: [right], confidence: "sure" });
    expect(evidenceOf(ctx, c.id)).toHaveLength(items.length);

    const retry = await attempt(app, entropy.id, { value: "2.5", confidence: "sure" });
    expect(retry.status).toBe("correct");
    expect(retry.reveal!.expected).toBe("2.5 bits");
    expect(evidenceOf(ctx, retry.attempts[1].id)).toEqual([]); // the first-attempt rule for the step is unchanged
    await ctx.practice.idle();
    expect(coachCalls(ctx)).toHaveLength(1); // no coaching after a correct answer
  });

  it("a second miss gets a second round with a different strategy, and the solution is offered", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    await attempt(app, step.id, { value: "3", confidence: "sure" });
    await ctx.practice.idle();
    const idk = await attempt(app, step.id, { dontKnow: true });
    expect(idk.status).toBe("dont_know");
    expect(idk.misses).toBe(2);
    expect(idk.reveal).toBeUndefined();
    await ctx.practice.idle();

    expect(coachCalls(ctx)).toHaveLength(2);
    const second = coachCalls(ctx)[1].input;
    expect(second.strategy).toBe("contrasting_cases");
    expect(second.avoidStrategies).toEqual(["first_principles"]);
    expect(second.priorCoaching).toEqual([expect.objectContaining({ round: 1, strategy: "first_principles", checkAnswered: "not answered" })]);
    expect(second.learner.answer).toBe("I don't know");
    expect(second.earlierAttempts).toEqual([expect.objectContaining({ answer: "3" })]);

    const s = stepOf(await problem(1), "(b)");
    expect(s.coaching.map((c) => [c.round, c.status, c.strategy])).toEqual([
      [1, "ready", "first_principles"],
      [2, "ready", "contrasting_cases"],
    ]);
    expect(s.misses).toBe(2);

    // A model that repeats the earlier strategy is asked to revise.
    ctx.mock.failNext({ task: "practice_coach", kind: "mutate", mutate: (o) => ({ ...o, strategy: "first_principles" }) });
    await attempt(app, step.id, { value: "4", confidence: "unsure" });
    await ctx.practice.idle();
    const failed = ctx.repo.db.prepare("SELECT error_json FROM ai_jobs WHERE task = 'practice_coach' AND status = 'failed'").all() as { error_json: string }[];
    expect(failed.map((f) => f.error_json)).toEqual([expect.stringMatching(/strategy \\"first_principles\\" was already used/)]);
    expect(stepOf(await problem(1), "(b)").coaching[2]).toMatchObject({ status: "ready", strategy: "worked_example" });

    // "Show solution" reveals; nothing more is coached after that.
    const shown = (await request(app).post(`/api/practice/steps/${step.id}/reveal`).set(H)).body as PracticeStepView;
    expect(shown.status).toBe("revealed");
    expect(shown.reveal!.expected).toBe("2.5 bits");
    const calls = coachCalls(ctx).length;
    await attempt(app, step.id, { value: "7", confidence: "sure" });
    await ctx.practice.idle();
    expect(coachCalls(ctx)).toHaveLength(calls);
  });

  it("rejects coaching that gives the answer away, and stores the repaired version", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    ctx.mock.failNext({ task: "practice_coach", kind: "mutate", mutate: (o) => ({ ...o, explanation: `${o.explanation}\n\nSo $H(X) = 2.5$ bits.` }) });
    await attempt(app, step.id, { value: "3", confidence: "sure" });
    await ctx.practice.idle();
    expect(coachCalls(ctx)).toHaveLength(2);
    const failed = ctx.repo.db.prepare("SELECT error_json FROM ai_jobs WHERE task = 'practice_coach' AND status = 'failed'").get() as { error_json: string };
    expect(failed.error_json).toMatch(/gives the step's answer away: it contains 2\.5/);
    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c.status).toBe("ready");
    expect(c.explanation).not.toMatch(/2\.5/);
  });

  it("tables: the coach is told which cells were wrong; the learner sees which, not the key", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(0), "(a)");
    const rows = [["", "1", "2", "3"], ["1", "0", "1", "2"], ["2", "1", "1", "1"], ["3", "2", "2", "2"]];
    const wrong = await attempt(app, step.id, { value: rows, confidence: "sure" });
    expect(wrong.status).toBe("partial");
    expect(wrong.attempts[0].cellResults![3][2]).toBe(false);
    expect(wrong.reveal).toBeUndefined();
    await ctx.practice.idle();
    expect(coachCalls(ctx)[0].input.learner.wrongCells).toEqual([{ row: "A", column: "A", typed: "2" }]);
    expect(stepOf(await problem(0), "(a)").coaching[0].status).toBe("ready");
  });

  it("a written answer graded partly right is coached", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(0), "(c)");
    const pending = ctx.practice.attempt(step.id, { value: "One candidate deletes X_i.", confidence: "unsure" });
    expect(pending.coaching).toEqual([]); // nothing to coach until it is graded
    await ctx.practice.processPendingGrades();
    await ctx.practice.idle();
    const s = stepOf(await problem(0), "(c)");
    expect(s.status).toBe("partial");
    expect(s.reveal).toBeUndefined();
    expect(s.coaching[0]).toMatchObject({ status: "ready" });
    expect(coachCalls(ctx)[0].input.learner.feedback).toMatch(/key points/);
  });
});

describe("warm-up before a problem", () => {
  it("probes prerequisites once, hides answers until answered, and records probe evidence", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const p = await problem(0);
    expect(p.primer).toEqual({ status: "not_started", error: null, probes: [], done: false });

    const started = (await request(app).post(`/api/practice/problems/${p.id}/primer`).set(H)).body as PracticeProblemView;
    expect(started.primer.status).toBe("pending");
    await ctx.practice.idle();
    const calls = ctx.mock.calls.filter((c) => c.task === "practice_primer");
    expect(calls).toHaveLength(1);
    expect(calls[0].input.concepts.map((c: { name: string }) => c.name)).toEqual(["Edit distance", "Dynamic programming"]);
    expect(calls[0].input.problem.intro).toMatch(/GCA/);

    const ready = (await problem(0)).primer;
    expect(ready.status).toBe("ready");
    expect(ready.done).toBe(false);
    expect(ready.probes).toHaveLength(2);
    expect(ready.probes[0]).toMatchObject({ concept: { name: "Edit distance" }, teach: null, refs: [] });
    expect(JSON.stringify(ready)).not.toMatch(/correctValues|"correct"|misconception/);

    // Starting again does nothing new.
    await request(app).post(`/api/practice/problems/${p.id}/primer`).set(H);
    await ctx.practice.idle();
    expect(ctx.mock.calls.filter((c) => c.task === "practice_primer")).toHaveLength(1);

    const wrongValue = ready.probes[0].question.options.find((o) => o.label.includes("reverse"))!.value;
    const after = (await request(app).post(`/api/practice/problems/${p.id}/primer/0/answer`).set(H).send({ selected: [wrongValue], confidence: "sure" })).body as PracticeProblemView;
    const probe = after.primer.probes[0];
    expect(probe.question.attempt).toMatchObject({ correct: false });
    expect(probe.teach).toMatch(/Edit distance/);
    expect(probe.refs[0]).toMatchObject({ verified: true });
    const answerId = ctx.repo.db.prepare("SELECT id FROM practice_probe_answers").get() as { id: string };
    const edit = p.concepts.find((c) => c.name === "Edit distance")!.id;
    expect(evidenceOf(ctx, answerId.id)).toEqual(expect.arrayContaining([expect.objectContaining({ concept_id: edit, dimension: "recognition", delta: -1 })]));
    expect(ctx.repo.misconceptions(edit).map((m) => m.label)).toEqual(["inverts the meaning of Edit distance"]);

    const both = (await request(app).post(`/api/practice/problems/${p.id}/primer/1/answer`).set(H).send({ dontKnow: true })).body as PracticeProblemView;
    expect(both.primer.done).toBe(true);
    expect((await request(app).post(`/api/practice/problems/${p.id}/primer/5/answer`).set(H).send({ dontKnow: true })).status).toBe(404);
  });

  it("can be skipped (no AI request), and is not offered once a problem was started", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const p = await problem(0);
    const skipped = (await request(app).post(`/api/practice/problems/${p.id}/primer/skip`).set(H)).body as PracticeProblemView;
    expect(skipped.primer).toMatchObject({ status: "skipped", done: true });
    await request(app).post(`/api/practice/problems/${p.id}/primer`).set(H);
    await ctx.practice.idle();
    expect(ctx.mock.calls.filter((c) => c.task === "practice_primer")).toHaveLength(0);

    const p2 = await problem(1);
    await attempt(app, stepOf(p2, "(b)").id, { value: "2.5", confidence: "sure" });
    expect((await problem(1)).primer).toMatchObject({ status: "none", done: true });
  });

  it("skips concepts the learner has already demonstrated", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const p = await problem(1);
    const at = new Date().toISOString();
    const strong = ["recognition", "application", "transfer"].map((dimension) => ({ dimension: dimension as "recognition", delta: 1, at }));
    const entropy = p.concepts.find((c) => c.name === "Entropy")!;
    ctx.repo.addEvidence(entropy.id, null, null, [...strong, ...strong]);
    await request(app).post(`/api/practice/problems/${p.id}/primer`).set(H);
    await ctx.practice.idle();
    const input = ctx.mock.calls.find((c) => c.task === "practice_primer")!.input;
    expect(input.alreadyDemonstrated).toEqual(["Entropy"]);
    expect(input.concepts.map((c: { name: string }) => c.name)).toEqual(["Self-information"]);
    expect((await problem(1)).primer.probes.map((x) => x.concept.name)).toEqual(["Self-information"]);

    // Everything demonstrated: nothing to warm up, and no request at all.
    const self = p.concepts.find((c) => c.name === "Self-information")!;
    ctx.repo.addEvidence(self.id, null, null, [...strong, ...strong]);
    const p1 = await problem(0);
    for (const c of p1.concepts) ctx.repo.addEvidence(c.id, null, null, [...strong, ...strong]);
    const n = ctx.mock.calls.length;
    const none = (await request(app).post(`/api/practice/problems/${p1.id}/primer`).set(H)).body as PracticeProblemView;
    expect(none.primer).toMatchObject({ status: "none", done: true });
    expect(ctx.mock.calls.length).toBe(n);
  });
});

describe("persistence and pauses", () => {
  it("coaching and warm-ups survive a restart unchanged; generation cut off by shutdown waits for a retry", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { app, problem, set } = await readySet(ctx1);
    const p = await problem(1);
    await request(app).post(`/api/practice/problems/${p.id}/primer`).set(H);
    await attempt(app, stepOf(p, "(b)").id, { value: "3", confidence: "sure" });
    await ctx1.practice.idle();
    const before = await problem(1);
    // A coaching job in flight at shutdown.
    await attempt(app, stepOf(p, "(c)").id, { value: "2", confidence: "sure" });
    await ctx1.practice.idle();
    ctx1.repo.db.prepare("UPDATE practice_coaching SET status = 'pending', content_json = NULL WHERE step_id = ?").run(stepOf(p, "(c)").id);
    ctx1.db.close();

    const ctx2 = testContext({ dataDir });
    const app2 = createApp(ctx2);
    const after = (await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body as PracticeProblemView;
    expect(after.primer).toEqual(before.primer);
    expect(stepOf(after, "(b)").coaching).toEqual(stepOf(before, "(b)").coaching);
    expect(stepOf(after, "(c)").coaching[0]).toMatchObject({ status: "waiting", error: expect.stringMatching(/closed/) });
    expect(ctx2.mock.calls).toHaveLength(0);
    await request(app2).post(`/api/practice/steps/${stepOf(p, "(c)").id}/coach`).set(H);
    await ctx2.practice.idle();
    expect(stepOf((await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body, "(c)").coaching[0].status).toBe("ready");
  });

  it("while paused coaching waits, the solution can still be shown, and resuming generates it", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    ctx.mock.failNext({ task: "practice_coach", kind: "usage_limit" });
    await attempt(app, step.id, { value: "3", confidence: "sure" });
    await ctx.practice.idle();
    expect(ctx.router.paused).not.toBeNull();
    const waiting = stepOf(await problem(1), "(b)");
    expect(waiting.coaching[0]).toMatchObject({ status: "waiting", error: expect.stringMatching(/usage limit/i), check: null });
    expect(waiting.reveal).toBeUndefined();

    // A warm-up started while paused waits too.
    const p0 = await problem(0);
    await request(app).post(`/api/practice/problems/${p0.id}/primer`).set(H);
    await ctx.practice.idle();
    expect((await problem(0)).primer).toMatchObject({ status: "waiting", done: false });

    await request(app).post("/api/providers/resume").set(H);
    await ctx.practice.idle();
    expect(stepOf(await problem(1), "(b)").coaching[0].status).toBe("ready");
    expect((await problem(0)).primer.status).toBe("ready");

    // Paused again: "Show solution" never needs the AI.
    ctx.mock.failNext({ task: "practice_coach", kind: "usage_limit" });
    const other = stepOf(await problem(1), "(c)");
    await attempt(app, other.id, { value: "2", confidence: "sure" });
    await ctx.practice.idle();
    const shown = (await request(app).post(`/api/practice/steps/${other.id}/reveal`).set(H)).body as PracticeStepView;
    expect(shown).toMatchObject({ status: "revealed", reveal: expect.objectContaining({ expected: "log2(6) ≈ 2.585 bits" }) });
  });
});

describe("migration 3", () => {
  it("upgrades a database at version 2: old “I don't know” attempts stay reveals, new tables appear", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { app, problem, set } = await readySet(ctx1);
    const p = await problem(1);
    await attempt(app, stepOf(p, "(a)").id, { value: "1 1 1 1 1 1", confidence: "sure" });
    await ctx1.practice.idle();
    await request(app).post(`/api/practice/steps/${stepOf(p, "(b)").id}/reveal`).set(H);
    // Turn it back into a version-2 database (as the learner's real one is).
    ctx1.repo.db.exec(`ALTER TABLE practice_steps DROP COLUMN skipped; ALTER TABLE practice_attempts DROP COLUMN revealed; DROP TABLE practice_coaching; DROP TABLE practice_probe_answers;
      DROP TABLE practice_primers; DROP TABLE follow_up_turns; DROP TABLE follow_up_threads; PRAGMA user_version = 2`);
    ctx1.db.close();
    const raw = new DB(`${dataDir}/learn.db`);
    expect(raw.pragma("user_version", { simple: true })).toBe(2);
    expect((raw.pragma("table_info(practice_attempts)") as { name: string }[]).some((c) => c.name === "revealed")).toBe(false);
    raw.close();

    const ctx2 = testContext({ dataDir });
    expect(ctx2.repo.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(5);
    const app2 = createApp(ctx2);
    const after = (await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body as PracticeProblemView;
    expect(stepOf(after, "(b)")).toMatchObject({ status: "revealed", reveal: expect.objectContaining({ expected: "2.5 bits" }) });
    expect(stepOf(after, "(a)")).toMatchObject({ status: "incorrect", coaching: [], misses: 1 });
    expect(after.primer.status).toBe("none");
    // The new tables work.
    await attempt(app2, stepOf(after, "(c)").id, { value: "2", confidence: "sure" });
    await ctx2.practice.idle();
    expect(stepOf((await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body, "(c)").coaching[0].status).toBe("ready");
  });
});

describe("key-leak check", () => {
  const intro = "A source emits a and b with probability 1/4 each.";
  it("catches number keys written exactly, as expressions, or rounded; ignores tiny integers and intro values", () => {
    const num = (value: string | number, alternatives: (string | number)[] = []): AnswerKey => ({ kind: "number", value, alternatives });
    expect(leakedKeyValues(num("2.5"), "so $H(X) = 2.5$ bits", intro)).toEqual(["2.5"]);
    expect(leakedKeyValues(num("2.5"), "so H is 2.50 bits.", intro)).toEqual(["2.5"]);
    expect(leakedKeyValues(num("2.5"), "a value of 12.5 or 2.55", intro)).toEqual([]);
    expect(leakedKeyValues(num("log2(6)"), "the answer is $\\log_2 6$", intro)).toEqual(["log2(6)"]);
    expect(leakedKeyValues(num("log2(6)"), "about 2.585 bits", intro)).toEqual(["log2(6)"]);
    expect(leakedKeyValues(num("log2(6)"), "about 2.6 bits", intro)).toEqual([]);
    expect(leakedKeyValues(num("3/64"), "it is $\\frac{3}{64}$", intro)).toEqual(["3/64"]);
    expect(leakedKeyValues(num(2), "the distance is 2", intro)).toEqual([]);
    expect(leakedKeyValues(num("1/4"), "each has probability 1/4", intro)).toEqual([]);
    expect(leakedKeyValues(num(7, [7.0]), "it takes 7 steps", intro)).toEqual(["7"]);
  });

  it("catches whole sequences and distinctive table rows or columns, not single small values or DP boundaries", () => {
    const seq: AnswerKey = { kind: "sequence", value: ["6", "4", "1", "5"], ordered: true, alternatives: [] };
    expect(leakedKeyValues(seq, "The suffix array is [6, 4, 1, 5].", intro)).toEqual(["6 4 1 5"]);
    expect(leakedKeyValues(seq, "Position 6 comes before 4 here.", intro)).toEqual([]);
    const set: AnswerKey = { kind: "sequence", value: ["3", "7", "9"], ordered: false, alternatives: [] };
    expect(leakedKeyValues(set, "occurrences at 9, 3 and 7", intro)).toEqual([]);
    expect(leakedKeyValues(set, "occurrences at 9, 3, 7", intro)).toEqual(["3 7 9"]);
    const table: AnswerKey = {
      kind: "table",
      rowLabels: ["ε", "G", "C", "A"],
      colLabels: ["ε", "G", "A", "C"],
      cells: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 1, 1], [3, 2, 1, 2]],
      given: [[0, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]],
    };
    expect(leakedKeyValues(table, "The last row is 3 & 2 & 1 & 2.", intro)).toEqual(["3 2 1 2"]);
    expect(leakedKeyValues(table, "Boundary: 0, 1, 2, 3. Then 1 0 1 2.", intro)).toEqual([]);
  });
});

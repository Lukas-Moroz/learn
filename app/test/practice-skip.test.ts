import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { AppContext } from "../src/server/context.ts";
import { DB, MIGRATIONS } from "../src/server/db/database.ts";
import type { LiveEvent } from "../src/server/events.ts";
import { importFile } from "../src/server/ingest/import.ts";
import type { PracticeProblemView, PracticeSetView, PracticeStepView } from "../src/shared/practice.ts";
import { currentStepIndex, stepDone } from "../src/web/practice.ts";
import { PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf, testContext, tmpDir } from "./helpers.ts";

const H = { "x-learn": "1" };

async function readySet(ctx: AppContext) {
  const course = ctx.repo.createCourse("Practice skip tests");
  const add = async (pages: string[][], filename: string) => importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(pages), filename });
  const guide = await add(PRACTICE_GUIDE, "Exam 2 Study Guide.pdf");
  const solutions = await add(PRACTICE_SOLUTIONS, "Exam 2 Study Guide Solutions.pdf");
  const app = createApp(ctx);
  const created = await request(app).post(`/api/courses/${course.id}/practice`).set(H).send({ problemSourceId: guide.source.id, solutionSourceId: solutions.source.id });
  expect(created.status).toBe(200);
  await ctx.practice.extraction(created.body.id);
  const set = (await request(app).get(`/api/practice/${created.body.id}`)).body as PracticeSetView;
  const problem = async (index: number) => (await request(app).get(`/api/practice/problems/${set.problems[index].id}`)).body as PracticeProblemView;
  return { app, set, problem };
}

const skip = (app: ReturnType<typeof createApp>, id: string) => request(app).post(`/api/practice/steps/${id}/skip`).set(H);
const attempt = (app: ReturnType<typeof createApp>, id: string, value: string) => request(app).post(`/api/practice/steps/${id}/attempt`).set(H).send({ value, confidence: "sure" });
const stepOf = (problem: PracticeProblemView, label: string) => problem.steps.find((step) => step.label.startsWith(label))!;
const evidence = (ctx: AppContext) => ctx.db.prepare("SELECT * FROM evidence ORDER BY id").all();
const attempts = (ctx: AppContext) => ctx.db.prepare("SELECT * FROM practice_attempts ORDER BY id").all();

describe("skipping practice steps", () => {
  it("moves past an unanswered step without an answer, evidence, key reveal or AI call; repeat requests are idempotent", async () => {
    const ctx = testContext();
    const { app, set, problem } = await readySet(ctx);
    const first = (await problem(0)).steps[0];
    const before = { evidence: evidence(ctx), attempts: attempts(ctx), calls: ctx.mock.calls.length };
    const events: LiveEvent[] = [];
    ctx.bus.subscribe((event) => event.type === "practice" && events.push(event));

    const response = await skip(app, first.id);
    expect(response.status).toBe(200);
    const skipped = response.body as PracticeStepView;
    expect(skipped).toMatchObject({ status: "skipped", attempts: [], misses: 0, coaching: [], followUp: null });
    expect(skipped.reveal).toBeUndefined();
    expect(JSON.stringify(skipped)).not.toMatch(/"(key|cells|modelAnswer|keyIdeas|accepted|solution|expected)"/);
    expect((await skip(app, first.id)).body).toEqual(skipped);
    expect(evidence(ctx)).toEqual(before.evidence);
    expect(attempts(ctx)).toEqual(before.attempts);
    expect(ctx.mock.calls).toHaveLength(before.calls);
    expect(events).toEqual([expect.objectContaining({ stepId: first.id, status: "skipped" }), expect.objectContaining({ stepId: first.id, status: "skipped" })]);

    const refreshed = await problem(0);
    expect(refreshed.steps[0]).toEqual(skipped);
    expect(refreshed.primer.done).toBe(true);
    expect(stepDone(refreshed.steps[0])).toBe(true);
    expect(currentStepIndex(refreshed.steps)).toBe(1);
    const after = (await request(app).get(`/api/practice/${set.id}`)).body as PracticeSetView;
    expect(after.problems[0]).toMatchObject({ skipped: 1, completed: 1, answered: 0, correct: 0 });
  });

  it("keeps an existing wrong attempt and its evidence; a later retry clears skip without replacing learning history", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    const wrong = (await attempt(app, step.id, "3")).body as PracticeStepView;
    await ctx.practice.idle();
    const before = { evidence: evidence(ctx), attempts: attempts(ctx), calls: ctx.mock.calls.length };
    expect(before.evidence.length).toBeGreaterThan(0);
    const skipped = (await skip(app, step.id)).body as PracticeStepView;
    expect(skipped.status).toBe("skipped");
    expect(skipped.attempts).toEqual(wrong.attempts);
    expect(skipped.misses).toBe(1);
    expect(skipped.reveal).toBeUndefined();
    expect(evidence(ctx)).toEqual(before.evidence);
    expect(attempts(ctx)).toEqual(before.attempts);
    expect(ctx.mock.calls).toHaveLength(before.calls);

    const retry = (await attempt(app, step.id, "2.5")).body as PracticeStepView;
    expect(retry.status).toBe("correct");
    expect(retry.attempts).toHaveLength(2);
    expect(retry.attempts[0]).toEqual(wrong.attempts[0]);
    expect(retry.reveal!.expected).toBe("2.5 bits");
    expect(evidence(ctx)).toEqual(before.evidence); // only the first real answer contributes
    expect(ctx.db.prepare("SELECT skipped FROM practice_steps WHERE id = ?").get(step.id)).toEqual({ skipped: 0 });
  });

  it("the first real answer after a skip still earns mastery evidence, and an invalid retry keeps the skip", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    await skip(app, step.id);
    expect((await attempt(app, step.id, " ")).status).toBe(400);
    expect(stepOf(await problem(1), "(b)")).toMatchObject({ status: "skipped", attempts: [] });

    const correct = (await attempt(app, step.id, "2.5")).body as PracticeStepView;
    expect(correct).toMatchObject({ status: "correct", attempts: [expect.objectContaining({ correct: true, score: 1 })] });
    expect(evidence(ctx)).toEqual(expect.arrayContaining([expect.objectContaining({ attempt_id: correct.attempts[0].id, dimension: "application", delta: 1 })]));
    expect((await skip(app, step.id)).body.status).toBe("correct");
    expect(ctx.db.prepare("SELECT skipped FROM practice_steps WHERE id = ?").get(step.id)).toEqual({ skipped: 0 });
  });

  it("works while the AI is paused, and a pending answer stays skipped when its grade later arrives", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const written = stepOf(await problem(0), "(c)");
    ctx.mock.failNext({ task: "grade_practice", kind: "usage_limit" });
    const pending = ctx.practice.attempt(written.id, { value: "Deleting X_i, inserting Y_j, or matching/substituting the last characters.", confidence: "sure" });
    expect(pending.status).toBe("pending");
    await ctx.practice.processPendingGrades();
    expect(ctx.router.paused).not.toBeNull();
    const calls = ctx.mock.calls.length;
    const before = evidence(ctx);
    const skipped = (await skip(app, written.id)).body as PracticeStepView;
    expect(skipped).toMatchObject({ status: "skipped", attempts: [expect.objectContaining({ gradingStatus: "pending" })] });
    expect(skipped.reveal).toBeUndefined();
    expect(evidence(ctx)).toEqual(before);
    expect(ctx.mock.calls).toHaveLength(calls);
    const unanswered = stepOf(await problem(0), "(b)");
    expect((await skip(app, unanswered.id)).body).toMatchObject({ status: "skipped", attempts: [] });
    expect(ctx.mock.calls).toHaveLength(calls);

    ctx.router.resume();
    expect(await ctx.practice.processPendingGrades()).toBe(1);
    const graded = stepOf(await problem(0), "(c)");
    expect(graded).toMatchObject({ status: "skipped", attempts: [expect.objectContaining({ id: pending.attempts[0].id, gradingStatus: "done", correct: true })] });
    expect(graded.reveal).toBeUndefined();
    expect(stepDone(graded)).toBe(true);
  });

  it("keeps the key hidden if grading fails after a pending answer was skipped; an explicit reveal still works", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const written = stepOf(await problem(0), "(c)");
    for (let i = 0; i < 3; i++) ctx.mock.failNext({ task: "grade_practice", kind: "invalid" });
    const pending = ctx.practice.attempt(written.id, { value: "Deleting, inserting, or substituting.", confidence: "sure" });
    expect(pending.status).toBe("pending");
    expect(ctx.practice.skip(written.id).status).toBe("skipped");
    await ctx.practice.processPendingGrades();
    const failed = stepOf(await problem(0), "(c)");
    expect(failed).toMatchObject({ status: "skipped", attempts: [expect.objectContaining({ id: pending.attempts[0].id, gradingStatus: "failed" })] });
    expect(failed.reveal).toBeUndefined();
    expect(evidence(ctx)).toEqual([]);

    const revealed = (await request(app).post(`/api/practice/steps/${written.id}/reveal`).set(H)).body as PracticeStepView;
    expect(revealed.status).toBe("revealed");
    expect(revealed.reveal!.solution).toBeTruthy();
    expect((await skip(app, written.id)).body.status).toBe("revealed");
  });

  it("persists unanswered and previously wrong skips across a restart", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { app, set, problem } = await readySet(ctx1);
    const first = (await problem(0)).steps[0];
    const wrong = stepOf(await problem(1), "(b)");
    await attempt(app, wrong.id, "3");
    await ctx1.practice.idle();
    const saved = [(await skip(app, first.id)).body, (await skip(app, wrong.id)).body];
    const before = { evidence: evidence(ctx1), attempts: attempts(ctx1) };
    ctx1.db.close();

    const ctx2 = testContext({ dataDir });
    const app2 = createApp(ctx2);
    const p1 = (await request(app2).get(`/api/practice/problems/${set.problems[0].id}`)).body as PracticeProblemView;
    const p2 = (await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body as PracticeProblemView;
    expect(p1.steps[0]).toEqual(saved[0]);
    expect(stepOf(p2, "(b)")).toEqual(saved[1]);
    expect(evidence(ctx2)).toEqual(before.evidence);
    expect(attempts(ctx2)).toEqual(before.attempts);
    expect(ctx2.mock.calls).toHaveLength(0);
    expect(currentStepIndex(p1.steps)).toBe(1);
    ctx2.db.close();
  });

  it("requires the mutation header and rejects unknown steps without changing stored state", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const first = (await problem(0)).steps[0];
    expect((await request(app).post(`/api/practice/steps/${first.id}/skip`)).status).toBe(403);
    expect((await skip(app, "missing-step")).status).toBe(404);
    expect((await problem(0)).steps[0]).toEqual(first);
    expect(attempts(ctx)).toEqual([]);
    expect(evidence(ctx)).toEqual([]);
  });
});

describe("practice skip navigation", () => {
  it("unlocks the next step for saved skips, while wrong and unanswered steps remain active", () => {
    expect(stepDone({ status: "skipped" })).toBe(true);
    expect(currentStepIndex([{ status: "correct" }, { status: "skipped" }, { status: "unanswered" }])).toBe(2);
    expect(currentStepIndex([{ status: "skipped" }, { status: "incorrect" }, { status: "skipped" }])).toBe(1);
    expect(currentStepIndex([{ status: "skipped" }, { status: "skipped" }])).toBe(0); // revisit the first skip once everything else is done
    expect(stepDone({ status: "partial" })).toBe(false);
    expect(stepDone({ status: "dont_know" })).toBe(false);
  });
});

describe("migration 5", () => {
  it("upgrades a version-4 database with default unskipped steps and preserves answers, evidence, keys and coaching", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { app, set, problem } = await readySet(ctx1);
    const wrong = stepOf(await problem(1), "(b)");
    await attempt(app, wrong.id, "3");
    await ctx1.practice.idle();
    const before = { problem: await problem(1), evidence: evidence(ctx1), attempts: attempts(ctx1) };
    const keys = ctx1.db.prepare("SELECT id, key_json, solution FROM practice_steps ORDER BY id").all();
    ctx1.db.exec("ALTER TABLE practice_steps DROP COLUMN skipped; PRAGMA user_version = 4");
    ctx1.db.close();
    const raw = new DB(`${dataDir}/learn.db`);
    expect(raw.pragma("user_version", { simple: true })).toBe(4);
    expect((raw.pragma("table_info(practice_steps)") as { name: string }[]).some((column) => column.name === "skipped")).toBe(false);
    raw.close();

    const ctx2 = testContext({ dataDir });
    expect(ctx2.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(5);
    expect(ctx2.db.prepare("SELECT DISTINCT skipped FROM practice_steps").all()).toEqual([{ skipped: 0 }]);
    expect(ctx2.db.prepare("SELECT id, key_json, solution FROM practice_steps ORDER BY id").all()).toEqual(keys);
    expect(evidence(ctx2)).toEqual(before.evidence);
    expect(attempts(ctx2)).toEqual(before.attempts);
    const app2 = createApp(ctx2);
    expect((await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body).toEqual(before.problem);
    expect((await skip(app2, wrong.id)).body).toMatchObject({ status: "skipped", attempts: before.problem.steps[1].attempts });
    ctx2.db.close();
  });
});

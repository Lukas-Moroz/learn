// Prefetch: the lesson's next explanation or question is prepared in the background (hidden: no
// live events, nothing in the lesson view), revealed by Continue at once, discarded when the
// lesson's state no longer leads to it, cancelled when the learner leaves, and off on request.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { AppContext, ContextOptions } from "../src/server/context.ts";
import type { LiveEvent } from "../src/server/events.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { MARKOV_LECTURE, makePdf, pendingQuestion, testContext } from "./helpers.ts";

const H = { "x-learn": "1" };

async function setup(o: ContextOptions = {}, before?: (ctx: AppContext, app: ReturnType<typeof createApp>) => Promise<unknown>) {
  const ctx = testContext(o);
  const app = createApp(ctx);
  await before?.(ctx, app);
  const course = ctx.repo.createCourse("Probabilistic Models");
  const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const events: LiveEvent[] = [];
  ctx.bus.subscribe((e) => events.push(structuredClone(e)));
  const res = await request(app).post(`/api/lectures/${r.lecture.id}/lesson`).set(H);
  expect(res.status).toBe(200);
  return { ctx, app, lessonId: res.body.lessonId as string, events };
}

const calls = (ctx: AppContext, task: string) => ctx.mock.calls.filter((c) => c.task === task).length;
const jobs = (ctx: AppContext, lessonId: string, task: string) => ctx.repo.jobsForLesson(lessonId).filter((j) => j.task === task);
const lastJson = (ctx: AppContext, lessonId: string, task: string) => JSON.parse(jobs(ctx, lessonId, task).at(-1)!.partial_text);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("prefetch", () => {
  it("prepares the first question while the lesson opens, and Continue reveals it without a new request", async () => {
    const { ctx, app, lessonId, events } = await setup();
    await ctx.engine.prefetch.idle(lessonId);
    expect(ctx.engine.prefetch.pending(lessonId)).toEqual([expect.objectContaining({ task: "question", state: "ready" })]);
    const prepared = lastJson(ctx, lessonId, "question");
    // Hidden: no live event about it, and nothing of it in the lesson view.
    expect(events.filter((e) => e.type === "job" && e.task === "question")).toHaveLength(0);
    const before = await request(app).get(`/api/lessons/${lessonId}`);
    expect(JSON.stringify(before.body)).not.toContain(prepared.stem);

    const n = calls(ctx, "question");
    const t0 = performance.now();
    const res = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(calls(ctx, "question")).toBe(n); // revealed, not regenerated
    const q = pendingQuestion(ctx, lessonId)!;
    expect(q.stem).toBe(prepared.stem);
    expect(ms).toBeLessThan(1000);
    expect(ctx.engine.prefetch.stats.used).toBe(1);
  });

  it("after an answer: prepares the explanation and the question after it; each Continue reveals one, and follow-ups change nothing", async () => {
    const { ctx, app, lessonId } = await setup();
    await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    const q = pendingQuestion(ctx, lessonId)!;
    const answered = await request(app).post(`/api/lessons/${lessonId}/answer`).set(H).send({ questionId: q.id, selected: [], dontKnow: true });
    expect(answered.status).toBe(200);
    await ctx.engine.prefetch.idle(lessonId);
    expect(ctx.engine.prefetch.pending(lessonId).map((p) => `${p.task}:${p.state}`).sort()).toEqual(["explain:ready", "question:ready"]);

    // A follow-up question about the feedback doesn't change what comes next.
    const fb = ctx.repo.listBlocks(lessonId).filter((b) => b.type === "feedback").at(-1)!;
    expect((await request(app).post("/api/follow-ups").set(H).send({ kind: "lesson_block", id: fb.id, question: "Why is that?" })).status).toBe(200);
    await ctx.followUps.idle();

    const [nExplain, nQuestion] = [calls(ctx, "explain"), calls(ctx, "question")];
    const step1 = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    expect(step1.status).toBe(200);
    // The explanation ends the step (its question is revealed by the next Continue).
    const fresh = step1.body.blocks.slice(-1)[0];
    expect(fresh.type).toBe("explanation");
    expect(step1.body.state.pendingQuestionId).toBeNull();
    expect(calls(ctx, "explain")).toBe(nExplain);

    const step2 = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    expect(step2.status).toBe(200);
    expect(step2.body.state.pendingQuestionId).toBeTruthy();
    expect(calls(ctx, "question")).toBe(nQuestion);
    // The prepared question saw the explanation it follows (anti-parroting input).
    const input = ctx.mock.calls.filter((c) => c.task === "question").at(-1)!.input;
    expect(input.recentExplanation).toContain(fresh.payload.body);
  });

  it("discards prepared content when the lesson's state no longer leads to it", async () => {
    const { ctx, app, lessonId } = await setup();
    await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    const q = pendingQuestion(ctx, lessonId)!;
    await request(app).post(`/api/lessons/${lessonId}/answer`).set(H).send({ questionId: q.id, selected: [], dontKnow: true });
    await ctx.engine.prefetch.idle(lessonId);
    const stale = ctx.engine.prefetch.pending(lessonId).map((p) => p.key);
    expect(stale.length).toBeGreaterThan(0);
    const preparedExplanation = lastJson(ctx, lessonId, "explain");

    // The state changes underneath (the lesson moves to the second-order slides).
    const l = ctx.repo.getLesson(lessonId)!;
    const second = ctx.repo.findConceptBySlug("second-order-markov-model")!.id;
    ctx.repo.saveLessonState(l.id, { ...l.state, pathIndex: l.state.path.indexOf(second), conceptId: second }, l.version);

    const n = calls(ctx, "explain");
    const res = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    expect(res.status).toBe(200);
    expect(calls(ctx, "explain")).toBe(n + 1); // generated afresh for the new state
    const block = ctx.repo.listBlocks(lessonId).filter((b) => b.type === "explanation").at(-1)!;
    expect(block.conceptId).toBe(second);
    expect(block.payload.title).not.toBe(preparedExplanation.title);
    for (const key of stale) expect(ctx.engine.prefetch.pending(lessonId).map((p) => p.key)).not.toContain(key);
    expect(ctx.engine.prefetch.stats.discarded).toBeGreaterThanOrEqual(stale.length);
  });

  it("re-runs a prepared question's checks at reveal and regenerates when they now fail", async () => {
    const { ctx, app, lessonId } = await setup();
    await ctx.engine.prefetch.idle(lessonId);
    const prepared = lastJson(ctx, lessonId, "question");
    // Make the prepared question fail the deterministic checks without changing its input:
    // the claimed result is checked again (here: its options are made invalid in the job's promise).
    const claim = ctx.engine.prefetch.claim.bind(ctx.engine.prefetch);
    ctx.engine.prefetch.claim = async (id, key) => {
      const v = (await claim(id, key)) as { options: unknown[] } | null;
      return v && { ...v, options: v.options.slice(0, 1) };
    };
    const n = calls(ctx, "question");
    await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    expect(calls(ctx, "question")).toBe(n + 1);
    const q = pendingQuestion(ctx, lessonId)!;
    expect(q.options.length).toBeGreaterThan(1);
    expect(prepared.stem).toBeTruthy();
  });

  it("never sends prepared content early; revealed while still being written, it streams from then on", async () => {
    const { ctx, app, lessonId, events } = await setup({ mockDelayMs: 15, previewMs: 0 });
    // Wait until the hidden question has written its stem (but is not finished).
    let job = jobs(ctx, lessonId, "question")[0];
    for (let i = 0; i < 200 && !(job?.partial_text ?? "").includes('"kind"'); i++) {
      await wait(10);
      job = jobs(ctx, lessonId, "question")[0];
    }
    expect(job.status).toBe("running");
    const stem = JSON.parse(job.partial_text.slice(0, job.partial_text.indexOf(',"kind"')) + "}").stem as string;
    expect(stem.length).toBeGreaterThan(10);
    expect(events.filter((e) => e.jobId === job.id)).toHaveLength(0);
    expect(JSON.stringify((await request(app).get(`/api/lessons/${lessonId}`)).body)).not.toContain(stem);

    const res = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    expect(res.status).toBe(200);
    const mine = events.filter((e) => e.jobId === job.id);
    expect(mine[0]).toMatchObject({ status: "running", lessonId });
    expect(mine.some((e) => e.preview && e.preview.stem && stem.startsWith(e.preview.stem.slice(0, 10)))).toBe(true);
    expect(mine.at(-1)).toMatchObject({ status: "completed" });
    expect(pendingQuestion(ctx, lessonId)!.stem).toBe(stem);
    expect(ctx.repo.jobsForLesson(lessonId).filter((j) => j.task === "question")).toHaveLength(1);
  });

  it("leaving the lesson cancels what is being prepared", async () => {
    const { ctx, app, lessonId } = await setup({ mockDelayMs: 4 });
    await wait(30);
    expect(ctx.engine.prefetch.pending(lessonId)).toEqual([expect.objectContaining({ state: "running" })]);
    const left = await request(app).post(`/api/lessons/${lessonId}/leave`).set(H);
    expect(left.body.cancelled).toBe(1);
    await wait(30);
    expect(ctx.engine.prefetch.pending(lessonId)).toEqual([]);
    expect(jobs(ctx, lessonId, "question").map((j) => j.status)).toEqual(["cancelled"]);
    // Coming back works as before (the step is generated on Continue).
    const res = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.state.pendingQuestionId).toBeTruthy();
  });

  it("is a setting: off, nothing is prepared and an explanation is followed by its question in the same step", async () => {
    const { ctx, app, lessonId } = await setup({}, async (_ctx, app) => {
      const r = await request(app).patch("/api/settings/generation").set(H).send({ prefetch: false });
      expect(r.body).toEqual({ prefetch: false });
    });
    expect((await request(app).get("/api/status")).body.generation).toEqual({ prefetch: false });
    expect(ctx.engine.prefetch.pending(lessonId)).toEqual([]);
    await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    const q = pendingQuestion(ctx, lessonId)!;
    await request(app).post(`/api/lessons/${lessonId}/answer`).set(H).send({ questionId: q.id, selected: [], dontKnow: true });
    await request(app).post(`/api/lessons/${lessonId}/prefetch`).set(H);
    expect(ctx.engine.prefetch.pending(lessonId)).toEqual([]);
    expect(ctx.engine.prefetch.stats.started).toBe(0);
    const res = await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    const types = res.body.blocks.slice(-2).map((b: { type: string }) => b.type);
    expect(types).toEqual(["explanation", "question"]);

    // Turning it back on resumes preparing.
    await request(app).patch("/api/settings/generation").set(H).send({ prefetch: true });
    const q2 = pendingQuestion(ctx, lessonId)!;
    await request(app).post(`/api/lessons/${lessonId}/answer`).set(H).send({ questionId: q2.id, selected: [q2.options[0].value], confidence: "sure" });
    expect(ctx.engine.prefetch.stats.started).toBeGreaterThan(0);
  });

  it("doesn't prepare a step while the lesson is being advanced (no duplicate of the step in progress)", async () => {
    const { ctx, app, lessonId } = await setup({ mockDelayMs: 3 }, async (_c, app) => {
      await request(app).patch("/api/settings/generation").set(H).send({ prefetch: false });
    });
    await request(app).patch("/api/settings/generation").set(H).send({ prefetch: true });
    const advancing = request(app).post(`/api/lessons/${lessonId}/advance`).set(H).then((r) => r);
    await wait(20);
    expect(ctx.engine.isBusy(lessonId)).toBe(true);
    await request(app).post(`/api/lessons/${lessonId}/prefetch`).set(H);
    expect(ctx.engine.prefetch.pending(lessonId)).toEqual([]);
    expect((await advancing).status).toBe(200);
    expect(jobs(ctx, lessonId, "question")).toHaveLength(1);
  });

  it("never runs more than two hidden generations per lesson", async () => {
    const { ctx, lessonId } = await setup({ mockDelayMs: 2 });
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      peak = Math.max(peak, ctx.engine.prefetch.pending(lessonId).filter((p) => p.state === "running").length);
      ctx.engine.prefetch.schedule(lessonId);
      await wait(5);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(jobs(ctx, lessonId, "question").length).toBe(1); // scheduling again doesn't duplicate work
  });
});

describe("question stem streaming", () => {
  it("previews only the stem of a lesson question as it is written; options arrive with the validated question", async () => {
    const { ctx, app, lessonId, events } = await setup({ mockDelayMs: 1, previewMs: 0 }, async (_c, app) => {
      await request(app).patch("/api/settings/generation").set(H).send({ prefetch: false });
    });
    await request(app).post(`/api/lessons/${lessonId}/advance`).set(H);
    const q = pendingQuestion(ctx, lessonId)!;
    const previews = events.filter((e) => e.type === "job" && e.task === "question" && e.preview).map((e) => e.preview!);
    expect(previews.length).toBeGreaterThan(2);
    for (const p of previews) expect(Object.keys(p)).toEqual(["stem"]);
    for (let i = 1; i < previews.length; i++) expect(previews[i].stem.startsWith(previews[i - 1].stem)).toBe(true);
    expect(q.stem.startsWith(previews.at(-1)!.stem)).toBe(true);
    const shown = JSON.stringify(previews);
    for (const o of q.options) expect(shown).not.toContain(o.label);
    expect(events.find((e) => e.task === "question" && e.preview)!.conceptId).toBe(q.conceptId);
  });
});

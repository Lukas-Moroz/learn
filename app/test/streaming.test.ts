// Live previews of text being written: SSE "job" events carry the response's text fields as they
// stream (in order, growing), practice previews are leak-checked before they are published, and
// coaching is committed (and shown) before its check question is written.
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { AppContext } from "../src/server/context.ts";
import type { LiveEvent } from "../src/server/events.ts";
import { importFile } from "../src/server/ingest/import.ts";
import type { PracticeProblemView, PracticeSetView, PracticeStepView } from "../src/shared/practice.ts";
import { ALIGNMENT_LECTURE, MARKOV_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf, pendingQuestion, testContext } from "./helpers.ts";

const H = { "x-learn": "1" };

/** Read the SSE stream of a running server into a list of events. */
async function sse(base: string) {
  const events: LiveEvent[] = [];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

async function listen(ctx: AppContext) {
  const server = createApp(ctx).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("live explanation previews (lesson)", () => {
  it("streams the explanation's text over SSE in order, commits it, and shows it before its question is written", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const course = ctx.repo.createCourse("Probabilistic Models");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    const { server, base } = await listen(ctx);
    const stream = await sse(base);
    try {
      // Advance (answering "I don't know") until an advance writes an explanation.
      let explained = false;
      for (let i = 0; i < 12 && !explained; i++) {
        const q = pendingQuestion(ctx, lesson.id);
        if (q) await ctx.engine.answer(lesson.id, q.id, { selected: [], dontKnow: true });
        else explained = (await ctx.engine.advance(lesson.id)).created.some((b) => b.type === "explanation");
      }
      expect(explained).toBe(true);
      await flush();
    } finally {
      await stream.close();
      server.close();
    }

    const explain = stream.events.filter((e) => e.type === "job" && e.task === "explain");
    const jobId = explain.find((e) => e.status === "completed")!.jobId;
    const previews = explain.filter((e) => e.jobId === jobId && e.preview).map((e) => e.preview!);
    expect(previews.length).toBeGreaterThan(3);
    expect(explain.find((e) => e.jobId === jobId && e.preview)!.conceptId).toBeTruthy();
    // In order: every preview extends the previous one, field by field.
    for (let i = 1; i < previews.length; i++) {
      for (const [k, v] of Object.entries(previews[i - 1])) expect(previews[i][k]?.startsWith(v), `preview ${i} field ${k}`).toBe(true);
    }
    // The committed block holds the full text the previews were growing towards.
    const block = ctx.repo.listBlocks(lesson.id).filter((b) => b.type === "explanation").at(-1)!;
    const last = previews.at(-1)!;
    expect(block.payload.body.startsWith(last.body)).toBe(true);
    expect(last.body.length).toBeGreaterThan(block.payload.body.length / 2);
    expect(last.title).toBe(block.payload.title);

    // The explanation was committed and announced ("lesson" event) before its question was written.
    const order = stream.events.map((e) => (e.type === "lesson" ? "lesson" : e.type === "job" && e.status === "running" && !e.preview ? `start:${e.task}` : e.type === "job" ? `${e.status}:${e.task}` : e.type));
    const done = order.indexOf("completed:explain");
    const lessonAfter = order.indexOf("lesson", done);
    const questionStart = order.indexOf("start:question", done);
    expect(lessonAfter).toBeGreaterThan(done);
    if (questionStart >= 0) expect(lessonAfter).toBeLessThan(questionStart);
  });
});

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
  return { app, set, problem };
}

const stepOf = (p: PracticeProblemView, label: string) => p.steps.find((s) => s.label.startsWith(label))!;

function collect(ctx: AppContext) {
  const events: LiveEvent[] = [];
  const off = ctx.bus.subscribe((e) => events.push(structuredClone(e)));
  return { events, off };
}

describe("live coaching previews (practice)", () => {
  it("streams the coaching explanation, commits it, then writes the check question", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    // When the check question starts, the coaching is already committed (and shown) without it.
    let atCheckStart: ReturnType<typeof ctx.practice.store.coachingForStep>[number] | null = null;
    const offCheck = ctx.bus.subscribe((e) => {
      if (e.type === "job" && e.task === "practice_coach_check" && e.status === "running" && !atCheckStart) atCheckStart = ctx.practice.store.coachingForStep(step.id)[0];
    });
    const { events, off } = collect(ctx);
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    off();
    offCheck();

    const coachJobs = events.filter((e) => e.type === "job" && e.task === "practice_coach");
    const previews = coachJobs.filter((e) => e.preview);
    expect(previews.length).toBeGreaterThan(3);
    expect(previews[0]).toMatchObject({ stepId: step.id, problemId: expect.any(String), setId: expect.any(String), coachingId: expect.any(String) });
    for (let i = 1; i < previews.length; i++) {
      for (const [k, v] of Object.entries(previews[i - 1].preview!)) expect(previews[i].preview![k]?.startsWith(v)).toBe(true);
    }
    expect(Object.keys(previews.at(-1)!.preview!).sort()).toEqual(["diagnosis", "example", "explanation", "summary"]);
    // Nothing the learner saw carries the key (2.5 bits).
    expect(JSON.stringify(previews)).not.toMatch(/2\.5/);

    // Order: coaching completed → committed ("coached") → check question written → committed again.
    const order = events.map((e) => (e.type === "practice" ? `practice:${e.status}` : `${e.task}:${e.status}`)).filter((x, i, a) => x !== a[i - 1]);
    const coachDone = order.indexOf("practice_coach:completed");
    const committed = order.indexOf("practice:coached", coachDone);
    const checkStart = order.indexOf("practice_coach_check:running", coachDone);
    expect(coachDone).toBeGreaterThanOrEqual(0);
    expect(committed).toBeGreaterThan(coachDone);
    expect(checkStart).toBeGreaterThan(committed);
    expect(order.indexOf("practice:coached", checkStart)).toBeGreaterThan(checkStart);
    expect(atCheckStart!.status).toBe("ready");
    expect(atCheckStart!.content).toMatchObject({ check: null, checkStatus: "pending", explanation: expect.stringMatching(/Entropy/) });

    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c).toMatchObject({ status: "ready", checkStatus: "ready", checkError: null });
    expect(c.check!.stem).toMatch(/fair coin/);
    const checkInput = ctx.mock.calls.find((x) => x.task === "practice_coach_check")!.input;
    expect(checkInput.coaching.explanation).toBe(c.explanation);
    expect(checkInput).not.toHaveProperty("key");
  });

  it("a preview that would give the key away is never published: previews stop and the client is told it's revising", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    // The leak sits early in the explanation, with plenty of text after it.
    ctx.mock.failNext({ task: "practice_coach", kind: "mutate", mutate: (o) => ({ ...o, explanation: `So $H(X) = 2.5$ bits here. ${o.explanation}` }) });
    const { events, off } = collect(ctx);
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    off();

    const jobs = [...new Set(events.filter((e) => e.task === "practice_coach").map((e) => e.jobId))];
    expect(jobs).toHaveLength(2); // the leaking attempt, then the repaired one
    const first = events.filter((e) => e.jobId === jobs[0]);
    expect(JSON.stringify(first)).not.toMatch(/2\.5/);
    const withheld = first.findIndex((e) => e.preview === null && e.revising);
    expect(withheld).toBeGreaterThan(0);
    expect(first.slice(withheld + 1).some((e) => e.preview)).toBe(false); // no more previews for that job
    expect(first.at(-1)).toMatchObject({ status: "failed", revising: true });
    // The repaired attempt streams normally, and the committed coaching is clean.
    expect(events.some((e) => e.jobId === jobs[1] && e.preview)).toBe(true);
    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c.status).toBe("ready");
    expect(JSON.stringify(c)).not.toMatch(/2\.5/);
  });
});

describe("coaching check question (separate generation)", () => {
  it("streams the check question's stem (leak-checked first), never its options", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    const { events, off } = collect(ctx);
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    off();
    const previews = events.filter((e) => e.task === "practice_coach_check" && e.preview).map((e) => e.preview!);
    expect(previews.length).toBeGreaterThan(1);
    for (const p of previews) expect(Object.keys(p)).toEqual(["check.stem"]);
    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c.check!.stem.startsWith(previews.at(-1)!["check.stem"])).toBe(true);
    for (const o of c.check!.options) expect(JSON.stringify(previews)).not.toContain(o.label);
  });

  it("a check stem that would give the key away is withheld while it streams", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    ctx.mock.failNext({ task: "practice_coach_check", kind: "mutate", mutate: (o) => ({ check: { ...o.check, stem: `The source's entropy is 2.5 bits. ${o.check.stem}` } }) });
    const { events, off } = collect(ctx);
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    off();
    const check = events.filter((e) => e.task === "practice_coach_check");
    expect(JSON.stringify(check)).not.toMatch(/2\.5/);
    expect(check.some((e) => e.preview === null && e.revising)).toBe(true);
    expect(stepOf(await problem(1), "(b)").coaching[0]).toMatchObject({ checkStatus: "ready" });
  });

  it("a check that fails its checks leaves the coaching shown, marks the check failed, and retry writes it", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    // Three leaking drafts in a row (first try + two repairs): the check fails, the coaching stays.
    for (let i = 0; i < 3; i++) ctx.mock.failNext({ task: "practice_coach_check", kind: "mutate", mutate: (o) => ({ check: { ...o.check, stem: `${o.check.stem} (Hint: the source's entropy is 2.5 bits.)` } }) });
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    const failed = stepOf(await problem(1), "(b)").coaching[0];
    expect(failed).toMatchObject({ status: "ready", check: null, checkStatus: "failed", checkError: expect.any(String) });
    expect(failed.explanation).toMatch(/Entropy/);
    expect((await request(app).post(`/api/practice/coaching/${failed.id}/check`).set(H).send({ selected: ["x"], confidence: "sure" })).status).toBe(409);

    await request(app).post(`/api/practice/steps/${step.id}/coach`).set(H);
    await ctx.practice.idle();
    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c).toMatchObject({ status: "ready", checkStatus: "ready" });
    expect(c.check!.stem).not.toMatch(/2\.5/);
    expect(ctx.mock.calls.filter((x) => x.task === "practice_coach")).toHaveLength(1); // the explanation wasn't rewritten
  });

  it("paused while writing the check: it waits, and resuming writes it", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    ctx.mock.failNext({ task: "practice_coach_check", kind: "usage_limit" });
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    expect(stepOf(await problem(1), "(b)").coaching[0]).toMatchObject({ status: "ready", check: null, checkStatus: "waiting" });
    await request(app).post("/api/providers/resume").set(H);
    await ctx.practice.idle();
    expect(stepOf(await problem(1), "(b)").coaching[0]).toMatchObject({ status: "ready", checkStatus: "ready" });
  });

  it("coaching stored before the split (check inside the explanation's content) still renders and can be answered", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    const row = ctx.practice.store.coachingForStep(step.id)[0];
    // The old shape: no checkStatus / checkError fields.
    const { checkStatus: _s, checkError: _e, ...legacy } = row.content!;
    ctx.repo.db.prepare("UPDATE practice_coaching SET content_json = ? WHERE id = ?").run(JSON.stringify(legacy), row.id);
    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c).toMatchObject({ status: "ready", checkStatus: "ready", checkError: null });
    const right = c.check!.options.find((o) => o.label.startsWith("One bit"))!.value;
    const answered = (await request(app).post(`/api/practice/coaching/${c.id}/check`).set(H).send({ selected: [right], confidence: "sure" })).body as PracticeStepView;
    expect(answered.coaching[0].check!.attempt).toMatchObject({ correct: true });
  });

  it("a check cut off by a restart waits for a retry", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    await request(app).post(`/api/practice/steps/${step.id}/attempt`).set(H).send({ value: "3", confidence: "sure" });
    await ctx.practice.idle();
    const row = ctx.practice.store.coachingForStep(step.id)[0];
    ctx.repo.db.prepare("UPDATE practice_coaching SET content_json = ? WHERE id = ?").run(JSON.stringify({ ...row.content, check: null, checkStatus: "pending" }), row.id);
    expect(ctx.practice.recoverAtBoot()).toBeGreaterThanOrEqual(0);
    expect(stepOf(await problem(1), "(b)").coaching[0]).toMatchObject({ status: "ready", check: null, checkStatus: "waiting", checkError: expect.stringMatching(/closed/) });
  });
});

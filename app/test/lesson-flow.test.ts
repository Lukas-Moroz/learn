import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { lessonView } from "../src/server/teaching/view.ts";
import type { AppContext } from "../src/server/context.ts";
import { MARKOV_LECTURE, makePdf, pendingQuestion, runLesson, simulateAnswer, testContext, tmpDir, type LearnerModel } from "./helpers.ts";

const SECOND_ORDER_CONFUSIONS = [
  "thinks 'second order' means predicting two steps ahead",
  "thinks the model uses future context",
  "describes a first-order model",
  "drops the second state (first-order thinking)",
];

/** Learner who understands foundations, but reads "second-order" as first-order until shown contrasting cases. */
const confusedLearner: LearnerModel = {
  misconceptions: { "second-order-markov-model": SECOND_ORDER_CONFUSIONS },
  fixedBy: { "second-order-markov-model": { strategies: ["contrasting_cases"] } },
};

/** A Markov lecture lesson, positioned at the second-order slides with prerequisites never verified. */
async function lessonAtSecondOrder(ctx: AppContext) {
  const course = ctx.repo.createCourse("Probabilistic Models");
  const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
  await ctx.engine.advance(lesson.id); // overview (+ first probe)
  // Jump to slide 9, as if earlier slides were covered elsewhere: the lesson must not assume them.
  const l = ctx.repo.getLesson(lesson.id)!;
  const second = ctx.repo.findConceptBySlug("second-order-markov-model")!.id;
  const idx = l.state.path.indexOf(second);
  ctx.repo.saveLessonState(l.id, { ...l.state, pathIndex: idx, conceptId: second, pendingQuestionId: null, sourcePosition: { sourceId: r.source.id, page: 9 } }, l.version);
  return { lessonId: lesson.id, second, course, lecture: r.lecture, source: r.source };
}

const blocksOf = (ctx: AppContext, lessonId: string, conceptId?: string) =>
  ctx.repo.listBlocks(lessonId).filter((b) => !conceptId || b.conceptId === conceptId);

describe("adaptive remediation", () => {
  it("SCENARIO 3: two wrong answers branch into a prerequisite, then a different explanation and a non-repeated question", async () => {
    const ctx = testContext();
    const { lessonId, second } = await lessonAtSecondOrder(ctx);
    await runLesson(ctx, lessonId, confusedLearner, { stop: (c) => c.repo.getLesson(lessonId)!.state.detours.length > 0 });

    const firstOrder = ctx.repo.findConceptBySlug("first-order-markov-model")!.id;
    const detour = blocksOf(ctx, lessonId).find((b) => b.type === "detour_start")!;
    expect(detour).toBeDefined();
    expect(ctx.repo.prerequisitesOf(second)).toContain(detour.conceptId);
    expect(detour.payload.reason).toMatch(/Two misses in a row/);
    expect(detour.payload.returnLabel).toBe("Lecture 4, page 9");
    const misses = ctx.repo.attemptsForConcept(second).filter((a) => a.correct === false);
    expect(misses.length).toBeGreaterThanOrEqual(2);

    // Finish the detour and come back.
    await runLesson(ctx, lessonId, confusedLearner, { stop: (c) => blocksOf(c, lessonId).some((b) => b.type === "detour_end") && blocksOf(c, lessonId, second).filter((b) => b.type === "question").length > misses.length + 1 });
    const end = blocksOf(ctx, lessonId).find((b) => b.type === "detour_end")!;
    expect(end.payload.returningTo).toBe("Second-order Markov model");
    expect([firstOrder, ctx.repo.findConceptBySlug("conditional-probability")!.id]).toContain(end.conceptId);

    const explanations = blocksOf(ctx, lessonId, second).filter((b) => b.type === "explanation");
    const afterReturn = explanations.find((b) => b.seq > end.seq)!;
    expect(afterReturn.payload.purpose).toBe("return");
    const before = explanations.filter((b) => b.seq < end.seq).map((b) => b.payload.strategy);
    expect(before).not.toContain(afterReturn.payload.strategy);
    expect(new Set(explanations.map((b) => b.payload.strategy)).size).toBe(explanations.length);

    const qs = ctx.repo.questionsForConcept(second);
    expect(new Set(qs.map((q) => q.stem)).size).toBe(qs.length);
    expect(new Set(qs.map((q) => q.scenario)).size).toBe(qs.length);

    // Misconceptions were recorded as structured records, with a confident repeat marked "likely".
    const m = ctx.repo.misconceptions(second);
    expect(m.length).toBeGreaterThan(0);
    expect(m.some((x) => x.status === "likely" || x.status === "resolved")).toBe(true);
  });

  it("an honest “I don't know” is taught as a gap, not diagnosed as a misconception", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    await ctx.engine.advance(lesson.id);
    const q = pendingQuestion(ctx, lesson.id)!;
    await ctx.engine.answer(lesson.id, q.id, { dontKnow: true });
    const fb = blocksOf(ctx, lesson.id).at(-1)!;
    expect(fb.payload.correct).toBeNull();
    expect(fb.payload.message).toMatch(/gap/);
    expect(ctx.repo.misconceptions(q.conceptId)).toHaveLength(0);
    await ctx.engine.advance(lesson.id);
    const expl = blocksOf(ctx, lesson.id, q.conceptId).find((b) => b.type === "explanation")!;
    expect(expl.payload.purpose).toBe("introduce");
  });
});

describe("persistence and recovery", () => {
  it("SCENARIO 4: closing mid-detour and restarting restores the exact position and return destination", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { lessonId } = await lessonAtSecondOrder(ctx1);
    // Run until inside the detour with a question pending (halfway through).
    await runLesson(ctx1, lessonId, confusedLearner, {
      stop: (c) => {
        const s = c.repo.getLesson(lessonId)!.state;
        return s.detours.length > 0 && Boolean(s.pendingQuestionId);
      },
    });
    const before = lessonView(ctx1.engine, ctx1.repo.getLesson(lessonId)!);
    const draftBlocks = ctx1.repo.listBlocks(lessonId).length;
    ctx1.db.close(); // abrupt: no "end lesson" step exists or is needed

    const ctx2 = testContext({ dataDir });
    const after = lessonView(ctx2.engine, ctx2.repo.getLesson(lessonId)!);
    expect(after.nav.activity).toEqual(before.nav.activity);
    expect(after.nav.activity.kind).toBe("detour");
    expect((after.nav.activity as { returnTo: string }).returnTo).toBe("Second-order Markov model (Lecture 4, page 9)");
    expect(after.nav.sourcePosition).toEqual(before.nav.sourcePosition);
    expect(after.state.pendingQuestionId).toBe(before.state.pendingQuestionId);
    expect(after.blocks.length).toBe(draftBlocks);
    expect(after.recap!.lines.join(" ")).toMatch(/detour/);
    expect(after.recap!.next).toBe("Answer the open question");

    // And the lesson simply continues.
    const q = pendingQuestion(ctx2, lessonId)!;
    await ctx2.engine.answer(lessonId, q.id, simulateAnswer(confusedLearner, ctx2.repo.getConcept(q.conceptId)!.name, q, []));
    expect(ctx2.repo.getLesson(lessonId)!.state.pendingQuestionId).toBeNull();
  });

  it("a retried answer submission is recorded once", async () => {
    const ctx = testContext();
    const { lessonId } = await lessonAtSecondOrder(ctx);
    await ctx.engine.advance(lessonId);
    const q = pendingQuestion(ctx, lessonId)!;
    const ans = { selected: [q.options[0].value], confidence: "sure" };
    const [a, b] = await Promise.all([ctx.engine.answer(lessonId, q.id, ans), ctx.engine.answer(lessonId, q.id, ans)]);
    expect(b.reused || a.reused).toBe(true);
    expect(ctx.repo.attemptsForQuestion(q.id)).toHaveLength(1);
  });

  it("SCENARIO 8: a stream failure commits nothing; no checkpoint is falsely recorded", async () => {
    const ctx = testContext();
    const { lessonId } = await lessonAtSecondOrder(ctx);
    const before = ctx.repo.listBlocks(lessonId).length;
    const version = ctx.repo.getLesson(lessonId)!.version;
    ctx.mock.failNext({ task: "explain", kind: "interrupt", afterChars: 300 });
    await expect(ctx.engine.advance(lessonId)).rejects.toMatchObject({ code: "interrupted" });
    expect(ctx.repo.listBlocks(lessonId).length).toBe(before);
    expect(ctx.repo.getLesson(lessonId)!.version).toBe(version);
    const failed = ctx.repo.jobsForLesson(lessonId).filter((j) => j.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].partial_text.length).toBeGreaterThan(0); // kept for diagnosis, never shown as content

    // The same step succeeds on retry.
    await ctx.engine.advance(lessonId);
    expect(ctx.repo.listBlocks(lessonId).some((b) => b.type === "explanation")).toBe(true);

    // Interrupt the question generation that follows a completed concept: the checkpoint
    // reflects only recorded evidence, and is created exactly once.
    await runLesson(ctx, lessonId, { misconceptions: {}, fixedBy: {} }, { stop: (c) => blocksOf(c, lessonId).some((b) => b.type === "checkpoint") });
    const cps = blocksOf(ctx, lessonId).filter((b) => b.type === "checkpoint");
    expect(cps).toHaveLength(1);
    for (const l of cps[0].payload.learned) {
      const c = cps[0].payload.concepts.find((x: { name: string }) => x.name === l.name);
      expect(c.status).toBe("demonstrated");
    }
    expect(ctx.repo.events(lessonId).filter((e) => e.type === "checkpoint")).toHaveLength(1);
  });

  it("malformed output is repaired, and a restart marks running jobs as interrupted", async () => {
    const dataDir = tmpDir();
    const ctx = testContext({ dataDir });
    const { lessonId } = await lessonAtSecondOrder(ctx);
    ctx.mock.failNext({ task: "explain", kind: "invalid" });
    await ctx.engine.advance(lessonId);
    const jobs = ctx.repo.jobsForLesson(lessonId).filter((j) => j.task === "explain");
    expect(jobs.map((j) => j.status)).toEqual(["failed", "completed"]);
    ctx.repo.createJob(lessonId, "explain", "mock"); // simulates a process killed mid-stream
    ctx.db.close();
    const ctx2 = testContext({ dataDir });
    expect(ctx2.interruptedJobsAtBoot).toBe(1);
    expect(ctx2.repo.jobsForLesson(lessonId).some((j) => j.status === "running")).toBe(false);
  });
});

describe("providers and offline use", () => {
  it("SCENARIO 9: a usage limit pauses generation and preserves all state", async () => {
    const ctx = testContext();
    const { lessonId } = await lessonAtSecondOrder(ctx);
    const blocks = ctx.repo.listBlocks(lessonId).length;
    const state = ctx.repo.getLesson(lessonId)!.state;
    ctx.mock.failNext({ kind: "usage_limit" });
    const app = createApp(ctx);
    const res = await request(app).post(`/api/lessons/${lessonId}/advance`).set("x-learn", "1");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("usage_limit");
    expect(res.body.paused.code).toBe("usage_limit");
    expect(ctx.repo.listBlocks(lessonId).length).toBe(blocks);
    expect(ctx.repo.getLesson(lessonId)!.state).toEqual(state);
    const view = await request(app).get(`/api/lessons/${lessonId}`);
    expect(view.status).toBe(200);
    expect(view.body.paused.code).toBe("usage_limit");
  });

  it("SCENARIO 10: saved lessons and review questions work with no AI provider", async () => {
    const ctx = testContext({ forceProvider: null });
    ctx.router.updateSettings({ primary: "mock" });
    const { lessonId } = await lessonAtSecondOrder(ctx);
    await runLesson(ctx, lessonId, { misconceptions: {}, fixedBy: {} }, { stop: (c) => c.repo.listBlocks(lessonId).filter((b) => b.type === "feedback").length >= 3 && Boolean(c.repo.getLesson(lessonId)!.state.pendingQuestionId) });

    // Go "offline": the selected provider (ChatGPT) is not available at all.
    ctx.router.updateSettings({ primary: "openai" });
    const app = createApp(ctx);
    const view = await request(app).get(`/api/lessons/${lessonId}`);
    expect(view.status).toBe(200);
    expect(view.body.blocks.length).toBeGreaterThan(3);

    // A pending question can still be answered; written reasoning waits for a provider.
    const q = pendingQuestion(ctx, lessonId)!;
    const ans = await request(app).post(`/api/lessons/${lessonId}/answer`).set("x-learn", "1").send({ questionId: q.id, selected: [q.options[0].value], confidence: "unsure", note: "it uses the previous two states" });
    expect(ans.status).toBe(200);
    const fb = ans.body.blocks.at(-1);
    expect(fb.type).toBe("feedback");
    expect(fb.payload.reasoningStatus).toBe("pending");

    // Review queue (spaced retrieval) is fully offline.
    const queue = await request(app).get("/api/review");
    expect(queue.status).toBe(200);
    expect(queue.body.length).toBeGreaterThan(0);
    const item = queue.body[0];
    expect(item.question.attempt).toBeUndefined(); // answer not revealed before answering
    const rev = await request(app).post(`/api/review/${item.question.id}/answer`).set("x-learn", "1").send({ selected: [item.question.options[0].value], confidence: "sure" });
    expect(rev.status).toBe(200);
    expect(rev.body.attempt.correctValues.length).toBeGreaterThan(0);

    // Generating new content is refused (paused), never routed elsewhere.
    const adv = await request(app).post(`/api/lessons/${lessonId}/advance`).set("x-learn", "1");
    expect(adv.status).toBe(503);
    expect(adv.body.error.code).toBe("not_installed");

    // Back online: the deferred reasoning is evaluated.
    ctx.router.updateSettings({ primary: "mock" });
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    expect(ctx.repo.pendingReasoning()).toHaveLength(0);
  });
});

describe("source-driven lessons", () => {
  it("SCENARIO 5: a lesson section's slide reference resolves to the right source location", async () => {
    const ctx = testContext();
    const { lessonId, source } = await lessonAtSecondOrder(ctx);
    await ctx.engine.advance(lessonId);
    const expl = ctx.repo.listBlocks(lessonId).find((b) => b.type === "explanation")!;
    expect(expl.provenance).toBe("source");
    const ref = expl.refs[0];
    expect(ref.sourceId).toBe(source.id);
    expect(ref.label).toBe(`Lecture 4, page ${ref.page}`);
    const app = createApp(ctx);
    const page = await request(app).get(`/api/sources/${ref.sourceId}/pages/${ref.page}`);
    expect(page.status).toBe(200);
    expect(page.body.text).toMatch(/Second-order/);
    if (ref.quote) expect(page.body.text.replace(/\s+/g, " ")).toContain(ref.quote);
    const file = await request(app).get(`/api/sources/${ref.sourceId}/file`);
    expect(file.headers["content-type"]).toMatch(/pdf/);
    // Navigation shows both positions independently.
    const v = lessonView(ctx.engine, ctx.repo.getLesson(lessonId)!);
    expect(v.nav.sourcePosition!.label).toBe("Lecture 4, page 9");
    expect(v.nav.concept).toBe("Second-order Markov model");
    expect(v.nav.conceptRoleLabel).toBe("Central to the source");
  });

  it("the overview identifies structure and the learning path with source references", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    await ctx.engine.advance(lesson.id);
    const ov = ctx.repo.listBlocks(lesson.id)[0];
    expect(ov.type).toBe("overview");
    expect(ov.payload.path.map((p: { name: string }) => p.name)).toContain("Second-order Markov model");
    expect(ov.payload.path.find((p: { name: string }) => p.name === "Probability").ref).toBeNull(); // background, not in the source
    expect(ov.payload.path.find((p: { name: string }) => p.name === "Second-order Markov model").ref.label).toBe("Lecture 4, pages 9–10");
    // The first question probes a foundation rather than assuming it.
    const first = ctx.repo.listBlocks(lesson.id).find((b) => b.type === "question")!;
    expect(ctx.repo.getQuestion(first.payload.questionId)!.purpose).toBe("probe");
    expect(ctx.repo.getConcept(first.conceptId!)!.name).toBe("Probability");
  });

  it("SCENARIO 6: lectures in order share prerequisite concepts, which are reused and later revisited", async () => {
    let now = new Date("2026-03-01T10:00:00Z");
    const ctx = testContext({ now: () => now });
    const course = ctx.repo.createCourse("Probabilistic Models");
    const lecture3 = [
      ["Lecture 3: Conditional Probability"],
      ["Probability", "A probability is the share of outcomes an event covers."],
      ["Conditional probability", "Restrict to outcomes where B occurred, then renormalise: the share of B's outcomes also in A."],
      ["Chain rule of probability", "Any joint probability is a product of conditionals."],
    ];
    const l3 = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(lecture3), filename: "Lecture 3.pdf" });
    const l4 = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    expect(ctx.repo.listLectures(course.id).map((l) => l.title)).toEqual(["Lecture 3", "Lecture 4"]);

    const lesson3 = await ctx.engine.startLectureLesson(l3.lecture.id);
    await runLesson(ctx, lesson3.id, { misconceptions: {}, fixedBy: {} });
    expect(ctx.repo.getLesson(lesson3.id)!.state.complete).toBe(true);
    const cp = ctx.repo.findConceptBySlug("conditional-probability")!;
    expect(ctx.engine.mastery(cp.id, "central").status).toBe("demonstrated");

    // Lecture 4 the next day: the shared concept is the same record, not a duplicate…
    now = new Date("2026-03-02T09:00:00Z");
    const lesson4 = await ctx.engine.startLectureLesson(l4.lecture.id);
    expect(ctx.repo.listConcepts().filter((c) => c.slug === "conditional-probability")).toHaveLength(1);
    expect(ctx.repo.listConcepts().filter((c) => c.name === "Conditional probability")).toHaveLength(1);
    // …and demonstrated prerequisites are not re-taught.
    await runLesson(ctx, lesson4.id, { misconceptions: {}, fixedBy: {} }, { stop: (c) => c.repo.getLesson(lesson4.id)!.state.conceptId === c.repo.findConceptBySlug("markov-assumption")!.id });
    expect(blocksOf(ctx, lesson4.id, cp.id).filter((b) => b.type === "explanation" || b.type === "question")).toHaveLength(0);

    // Weeks later, a new lecture that relies on it opens with a short cumulative review.
    now = new Date("2026-03-20T09:00:00Z");
    const l5 = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf([["Lecture 5: Hidden Markov models"], ["Second-order Markov models revisited", "Conditional probability of hidden states."]]), filename: "Lecture 5.pdf" });
    const lesson5 = await ctx.engine.startLectureLesson(l5.lecture.id);
    expect(lesson5.state.reviewQueue).toContain(cp.id);
    const callsBefore = ctx.mock.calls.length;
    await ctx.engine.advance(lesson5.id); // overview, then the first review question
    const review = blocksOf(ctx, lesson5.id).filter((b) => b.type === "question").map((b) => ctx.repo.getQuestion(b.payload.questionId)!);
    expect(review[0].purpose).toBe("review");
    expect(ctx.mock.calls.slice(callsBefore).filter((c) => c.task === "question")).toHaveLength(0); // stored question, no AI
    expect(blocksOf(ctx, lesson5.id).some((b) => b.type === "review")).toBe(true);
    await ctx.engine.skipReview(lesson5.id); // never forced
    expect(ctx.repo.getLesson(lesson5.id)!.state.reviewQueue).toEqual([]);
  });

  it("exports a lesson as md-log compatible Markdown", async () => {
    const ctx = testContext();
    const { lessonId } = await lessonAtSecondOrder(ctx);
    await runLesson(ctx, lessonId, confusedLearner, { maxSteps: 12 });
    const res = await request(createApp(ctx)).get(`/api/lessons/${lessonId}/export.md`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/> \[!question\] Quiz/);
    expect(res.text).toMatch(/> \[!(success|failure)\] Quiz — (correct ✓|incorrect ✗)/);
    expect(res.text).toMatch(/\$\$/);
    expect(res.headers["x-export-path"]).toContain(join(ctx.dataDir, "exports"));
  });
});

describe("local server guards", () => {
  it("rejects cross-site mutations and foreign Host headers", async () => {
    const app = createApp(testContext());
    expect((await request(app).post("/api/courses").send({ title: "x" })).status).toBe(403);
    expect((await request(app).post("/api/courses").set("x-learn", "1").send({ title: "x" })).status).toBe(200);
    expect((await request(app).get("/api/courses").set("Host", "evil.example:4317")).status).toBe(403);
  });
});

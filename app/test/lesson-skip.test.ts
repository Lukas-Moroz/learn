import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { lessonView } from "../src/server/teaching/view.ts";
import { initialLessonState } from "../src/shared/schemas.ts";
import { MARKOV_LECTURE, makePdf, pendingQuestion, testContext } from "./helpers.ts";

async function lessonFixture() {
  const ctx = testContext();
  ctx.repo.setSetting("generation", { prefetch: false });
  const course = ctx.repo.createCourse("Probability");
  const imported = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const lesson = await ctx.engine.startLectureLesson(imported.lecture.id);
  await ctx.engine.advance(lesson.id);
  return { ctx, lesson, course, imported };
}

describe("lesson: choose to move on", () => {
  it("skips a pending question and continues to the next concept without inventing an answer", async () => {
    const { ctx, lesson } = await lessonFixture();
    const q = pendingQuestion(ctx, lesson.id)!;
    const nextConcept = ctx.repo.getLesson(lesson.id)!.state.path[1];
    const app = createApp(ctx);
    const moved = await request(app).post(`/api/lessons/${lesson.id}/skip`).set("x-learn", "1").send({ conceptId: q.conceptId });
    expect(moved.status).toBe(200);
    expect(moved.body.state.conceptId).toBe(nextConcept);
    expect(moved.body.blocks.find((b: any) => b.question?.id === q.id).question).toMatchObject({ skipped: true });
    expect(moved.body.blocks.find((b: any) => b.question?.id === q.id).question.attempt).toBeUndefined();
    expect(moved.body.concepts.find((c: any) => c.conceptId === q.conceptId).status).toBe("deferred");
    expect(ctx.repo.attemptsForQuestion(q.id)).toHaveLength(0);
    expect(ctx.repo.evidenceFor(q.conceptId)).toHaveLength(0);
    expect(ctx.engine.mastery(q.conceptId, "background").status).toBe("not_assessed");
    expect(pendingQuestion(ctx, lesson.id)?.conceptId).toBe(nextConcept);

    // A second click from an old tab cannot skip the following concept.
    const stale = await request(app).post(`/api/lessons/${lesson.id}/skip`).set("x-learn", "1").send({ conceptId: q.conceptId });
    expect(stale.status).toBe(409);
    expect(ctx.repo.getLesson(lesson.id)!.state.pathIndex).toBe(1);
    await expect(ctx.engine.answer(lesson.id, q.id, { selected: [], dontKnow: true })).rejects.toThrow("no longer awaiting");

    const dataDir = ctx.dataDir;
    ctx.db.close();
    const resumed = testContext({ dataDir });
    const restored = lessonView(resumed.engine, resumed.repo.getLesson(lesson.id)!);
    expect(restored.blocks.find((b) => b.question?.id === q.id)?.question?.skipped).toBe(true);
    expect(restored.state.conceptId).toBe(nextConcept);
    resumed.db.close();
  });

  it("keeps a wrong answer and its evidence when the learner skips the remediation", async () => {
    const { ctx, lesson } = await lessonFixture();
    const q = pendingQuestion(ctx, lesson.id)!;
    const stored = ctx.repo.getQuestion(q.id)!;
    const wrong = stored.options.find((o) => !stored.correct.includes(o.value))!;
    await ctx.engine.answer(lesson.id, q.id, { selected: [wrong.value], confidence: "sure" });
    const evidence = ctx.repo.evidenceFor(q.conceptId);
    const misconceptions = ctx.repo.activeMisconceptions(q.conceptId);
    const before = ctx.repo.getLesson(lesson.id)!.state.pathIndex;
    expect(ctx.engine.nextAction(lesson.id).type).toBe("explain");
    await ctx.engine.skipConcept(lesson.id, q.conceptId);
    expect(ctx.repo.getLesson(lesson.id)!.state.pathIndex).toBe(before + 1);
    expect(ctx.repo.attemptsForQuestion(q.id)).toHaveLength(1);
    expect(ctx.repo.evidenceFor(q.conceptId)).toEqual(evidence);
    expect(ctx.repo.activeMisconceptions(q.conceptId)).toEqual(misconceptions);
    expect(lessonView(ctx.engine, ctx.repo.getLesson(lesson.id)!).concepts.find((c) => c.conceptId === q.conceptId)?.status).toBe("deferred");
    ctx.db.close();
  });

  it("skips a prerequisite detour and returns to the original concept and source position", async () => {
    const { ctx, lesson, imported } = await lessonFixture();
    const second = ctx.repo.findConceptBySlug("second-order-markov-model")!.id;
    const current = ctx.repo.getLesson(lesson.id)!;
    ctx.repo.saveLessonState(lesson.id, { ...current.state, pathIndex: current.state.path.indexOf(second), conceptId: second, pendingQuestionId: null, sourcePosition: { sourceId: imported.source.id, page: 9 } }, current.version);
    for (let round = 0; round < 2; round++) {
      await ctx.engine.advance(lesson.id);
      const q = pendingQuestion(ctx, lesson.id)!;
      const stored = ctx.repo.getQuestion(q.id)!;
      await ctx.engine.answer(lesson.id, q.id, { selected: [stored.options.find((o) => !stored.correct.includes(o.value))!.value], confidence: "sure" });
    }
    await ctx.engine.advance(lesson.id);
    const inside = ctx.repo.getLesson(lesson.id)!;
    const detour = inside.state.detours.at(-1)!;
    expect(detour.fromConceptId).toBe(second);
    const pending = inside.state.pendingQuestionId!;
    await ctx.engine.skipConcept(lesson.id, detour.conceptId);
    const returned = ctx.repo.getLesson(lesson.id)!;
    expect(returned.state.detours).toHaveLength(0);
    expect(returned.state.conceptId).toBe(second);
    expect(returned.state.sourcePosition?.page).toBe(9);
    expect(returned.state.deferred).toContain(detour.conceptId);
    expect(returned.state.deferred).not.toContain(second);
    expect(ctx.repo.attemptsForQuestion(pending)).toHaveLength(0);
    expect(ctx.engine.nextAction(lesson.id)).toMatchObject({ type: "explain", conceptId: second, purpose: "return" });
    ctx.db.close();
  });

  it.each(["skipConcept", "skipReview"] as const)("optional review can be skipped with %s while its last question is open", async (method) => {
    const { ctx, lesson, course } = await lessonFixture();
    const priorQuestion = pendingQuestion(ctx, lesson.id)!;
    const nextConcept = ctx.repo.getLesson(lesson.id)!.state.path[1];
    const state = initialLessonState([nextConcept], null);
    state.overviewShown = true;
    state.reviewQueue = [priorQuestion.conceptId];
    const withReview = ctx.repo.createLesson({ courseId: course.id, lectureId: null, sourceId: null, objective: "Review then continue", title: "Review then continue", state });
    await ctx.engine.advance(withReview.id);
    const reviewQuestion = pendingQuestion(ctx, withReview.id)!;
    expect(reviewQuestion.purpose).toBe("review");
    expect(ctx.repo.getLesson(withReview.id)!.state.reviewQueue).toHaveLength(0);
    if (method === "skipConcept") await ctx.engine.skipConcept(withReview.id, reviewQuestion.conceptId);
    else await ctx.engine.skipReview(withReview.id);
    expect(ctx.repo.getLesson(withReview.id)!.state.pendingQuestionId).toBeNull();
    expect(ctx.repo.attemptsForQuestion(reviewQuestion.id)).toHaveLength(0);
    expect(lessonView(ctx.engine, ctx.repo.getLesson(withReview.id)!).blocks.find((b) => b.question?.id === reviewQuestion.id)?.question?.skipped).toBe(true);
    await ctx.engine.advance(withReview.id);
    expect(pendingQuestion(ctx, withReview.id)?.conceptId).toBe(nextConcept);
    ctx.db.close();
  });
});

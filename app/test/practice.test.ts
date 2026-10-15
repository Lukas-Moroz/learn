import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { AppContext } from "../src/server/context.ts";
import type { LiveEvent } from "../src/server/events.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { buildLectureIndex, rankTaughtIn } from "../src/server/practice/taught-in.ts";
import type { PracticeProblemView, PracticeSetView, PracticeStepView } from "../src/shared/practice.ts";
import { ALIGNMENT_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf, testContext, tmpDir } from "./helpers.ts";

const H = { "x-learn": "1" };

async function practiceCourse(ctx: AppContext, opts: { lecture?: boolean } = {}) {
  const course = ctx.repo.createCourse("Computational Genomics");
  const add = async (pages: string[][], filename: string) => importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(pages), filename });
  const lecture = opts.lecture === false ? null : await add(ALIGNMENT_LECTURE, "Lecture 5 - Alignment.pdf");
  const guide = await add(PRACTICE_GUIDE, "Exam 2 Study Guide.pdf");
  const solutions = await add(PRACTICE_SOLUTIONS, "Exam 2 Study Guide Solutions.pdf");
  return { course, lecture, guide, solutions };
}

/** A course with a practice set, extracted to completion. */
async function readySet(ctx: AppContext, opts: { lecture?: boolean; solutions?: boolean } = {}) {
  const docs = await practiceCourse(ctx, opts);
  const app = createApp(ctx);
  const res = await request(app)
    .post(`/api/courses/${docs.course.id}/practice`)
    .set(H)
    .send({ problemSourceId: docs.guide.source.id, solutionSourceId: opts.solutions === false ? null : docs.solutions.source.id });
  expect(res.status).toBe(200);
  await ctx.practice.extraction(res.body.id);
  const set = (await request(app).get(`/api/practice/${res.body.id}`)).body as PracticeSetView;
  const problem = async (n: number) => (await request(app).get(`/api/practice/problems/${set.problems[n].id}`)).body as PracticeProblemView;
  return { ...docs, app, set, problem, created: res.body as PracticeSetView };
}

const stepOf = (p: PracticeProblemView, label: string) => p.steps.find((s) => s.label.startsWith(label))!;
const attempt = (app: ReturnType<typeof createApp>, stepId: string, body: object) => request(app).post(`/api/practice/steps/${stepId}/attempt`).set(H).send(body);
const evidenceOf = (ctx: AppContext, attemptId: string) =>
  ctx.repo.db.prepare("SELECT concept_id, dimension, delta FROM evidence WHERE attempt_id = ? ORDER BY id").all(attemptId) as { concept_id: string; dimension: string; delta: number }[];
const EDIT_MATRIX = [["", "1", "2", "3"], ["1", "0", "1", "2"], ["2", "1", "1", "1"], ["3", "2", "1", "2"]];

describe("practice extraction", () => {
  it("turns a study guide and its solutions into problems, publishing progress as each one lands", async () => {
    const ctx = testContext();
    const events: LiveEvent[] = [];
    ctx.bus.subscribe((e) => e.type === "practice" && events.push(e));
    const { set, created, guide, solutions } = await readySet(ctx);

    expect(created.status).toBe("extracting");
    expect(created.progress).toEqual({ done: 0, total: null });
    expect(set.status).toBe("ready");
    expect(set.keySource).toBe("solutions");
    expect(set.title).toBe("Exam 2 Study Guide");
    expect([set.problemTitle, set.solutionTitle]).toEqual(["Exam 2 Study Guide", "Exam 2 Study Guide Solutions"]);
    expect(set.progress).toEqual({ done: 2, total: 2 });
    expect(set.problems.map((p) => [p.number, p.title, p.stepCount])).toEqual([["1", "Edit distance", 3], ["2", "Entropy", 4]]);
    expect(events.map((e) => [e.status, e.done, e.total])).toEqual([
      ["extracting", 0, undefined],
      ["extracting", 0, 2],
      ["extracting", 1, 2],
      ["extracting", 2, 2],
      ["ready", 2, 2],
    ]);
    expect(events[2].problemId).toBe(set.problems[0].id);

    // One outline call, then one call per problem with only that problem's pages.
    const calls = ctx.mock.calls.filter((c) => c.task.startsWith("practice_"));
    expect(calls.map((c) => c.task)).toEqual(["practice_outline", "practice_problem", "practice_problem"]);
    expect(calls[1].input.problemPages.map((p: { page: number }) => p.page)).toEqual([2]);
    expect(calls[1].input.solutionPages.map((p: { page: number }) => p.page)).toEqual([2]);
    expect(calls[2].input.problemPages[0].text).toMatch(/Problem 2: Entropy/);
    expect(guide.source.id).not.toBe(solutions.source.id);
  });

  it("never sends a key before an attempt, and links the problem to where it is taught", async () => {
    const ctx = testContext();
    const { problem } = await readySet(ctx);
    const p1 = await problem(0);
    const text = JSON.stringify(p1);
    expect(text).not.toMatch(/"(key|reveal|cells|modelAnswer|keyIdeas|accepted|correct|solution)"/);
    expect(text).not.toMatch(/bottom-right cell/);
    expect(p1.steps.map((s) => [s.label, s.kind, s.status])).toEqual([
      ["(a) matrix", "table", "unanswered"],
      ["(b) distance", "number", "unanswered"],
      ["(c) recurrence", "free", "unanswered"],
    ]);
    expect(p1.steps[0].input.table).toEqual({ rowLabels: ["ε", "G", "C", "A"], colLabels: ["ε", "G", "A", "C"], given: [["0", null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]] });
    expect(p1.concepts.map((c) => c.name)).toEqual(["Edit distance", "Dynamic programming"]);
    expect(p1.steps.map((s) => s.concepts.map((c) => c.name))).toEqual([["Edit distance", "Dynamic programming"], ["Edit distance"], ["Edit distance", "Dynamic programming"]]);
    expect(p1.steps[1].concepts[0].id).toBe(p1.concepts[0].id);
    expect(p1.taughtIn[0]).toMatchObject({ page: 2, pageEnd: 3, label: "Lecture 5 - Alignment, pages 2–3", verified: true });
    expect(p1.problemRefs).toEqual([expect.objectContaining({ page: 2, label: "Exam 2 Study Guide, page 2" })]);

    const p2 = await problem(1);
    expect(stepOf(p2, "(d)").input.choice).toEqual({ options: [{ value: "uniform", label: "The uniform source" }, { value: "skewed", label: "The first source" }, { value: "equal", label: "Both have the same entropy" }], multiSelect: false });
    expect(stepOf(p2, "(b)").input.unit).toBe("bits");
    expect(p2.taughtIn[0].label).toBe("Lecture 5 - Alignment, pages 4–5");
    // The concepts joined the shared graph with this course's context.
    const entropy = ctx.repo.findConceptBySlug("entropy")!;
    expect(ctx.repo.contextsFor(entropy.id).map((c) => c.course_title)).toEqual(["Computational Genomics"]);
  });

  it("keeps lectures imported later in sync, tolerating broken ligatures", async () => {
    const ctx = testContext();
    const { problem, course, app } = await readySet(ctx, { lecture: false });
    expect((await problem(0)).taughtIn).toEqual([]);
    const lecture = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(ALIGNMENT_LECTURE), filename: "Lecture 5 - Alignment.pdf" });
    expect((await problem(0)).taughtIn[0].label).toBe("Lecture 5 - Alignment, pages 2–3");
    // "Suf x arrays" on page 6 is what a dropped "fi" ligature looks like.
    const refs = rankTaughtIn(ctx.repo, buildLectureIndex(ctx.repo, course.id), { keywords: ["suffix array"], concepts: ["Suffix arrays"] });
    expect(refs[0]).toMatchObject({ sourceId: lecture.source.id, page: 6 });
    expect((await request(app).get(`/api/courses`)).body[0].lectures.map((l: { title: string }) => l.title)).toEqual(["Lecture 5 - Alignment"]);
  });

  it("ranks the pages that teach a topic above title, outline, summary, sibling-topic and review pages", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const banner = "(c) Prof 2026 - This content is protected and may not be shared";
    const deck = (pages: string[][]) => makePdf(pages.map((p) => [banner, ...p]));
    const nine = await importFile(ctx.repo, ctx.dataDir, {
      courseId: course.id,
      filename: "Lecture 9.pdf",
      data: await deck([
        ["Lecture 9: Local alignment", "Smith-Waterman and friends"],
        ["Outline", "Edit distance", "Global alignment", "Local alignment", "Smith-Waterman"],
        ["Edit distance vs global vs local alignment", "Levenshtein minimises cost; local alignment finds islands."],
        ["Local alignment", "Find the best-scoring pair of substrings: a local alignment."],
        ["The Smith-Waterman recurrence", "A zero candidate lets a local alignment restart."],
        ["Smith-Waterman traceback", "Start at the maximum cell; stop at the first zero."],
        ["Summary and what's next", "Edit distance, global alignment and local alignment (Smith-Waterman)."],
      ]),
    });
    await importFile(ctx.repo, ctx.dataDir, {
      courseId: course.id,
      filename: "Lecture 10.pdf",
      data: await deck([["Lecture 10: Probability"], ["Local alignment", "Find the best-scoring pair of substrings: a local alignment."], ["Conditional probability", "P(A|B) = P(A,B)/P(B)"]]),
    });
    const index = buildLectureIndex(ctx.repo, course.id);
    const refs = rankTaughtIn(ctx.repo, index, { keywords: ["local alignment", "Smith-Waterman", "traceback"], concepts: ["Local alignment"], contrast: ["Edit distance", "Global alignment", "Levenshtein"] });
    expect(refs[0]).toMatchObject({ sourceId: nine.source.id, page: 4, pageEnd: 6, label: "Lecture 9, pages 4–6" });
    expect(refs.filter((r) => r.sourceId === nine.source.id).every((r) => r.page >= 4 && (r.pageEnd ?? r.page) <= 6)).toBe(true);
    // The repeated banner is not content.
    expect(rankTaughtIn(ctx.repo, index, { keywords: ["content is protected"] })).toEqual([]);
  });

  it("re-creating the same pair returns the existing set without new AI calls", async () => {
    const ctx = testContext();
    const { app, course, guide, solutions, set } = await readySet(ctx);
    const calls = ctx.mock.calls.length;
    const again = await request(app).post(`/api/courses/${course.id}/practice`).set(H).send({ problemSourceId: guide.source.id, solutionSourceId: solutions.source.id, title: "Other" });
    expect(again.body.id).toBe(set.id);
    expect(again.body.status).toBe("ready");
    expect(ctx.mock.calls.length).toBe(calls);
    expect((await request(app).get(`/api/courses/${course.id}/practice`)).body).toHaveLength(1);
    // Documents from another course are refused clearly.
    const other = ctx.repo.createCourse("Other");
    const foreign = await request(app).post(`/api/courses/${other.id}/practice`).set(H).send({ problemSourceId: guide.source.id });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.message).toMatch(/isn't part of this course/);
    expect((await request(app).post(`/api/courses/${course.id}/practice`).send({ problemSourceId: guide.source.id })).status).toBe(403);
  });

  it("repairs malformed AI output (a table that doesn't match its labels) before storing anything", async () => {
    const ctx = testContext();
    ctx.mock.failNext({
      task: "practice_problem",
      kind: "mutate",
      mutate: (p) => {
        p.steps[0].key.cells.pop();
        return p;
      },
    });
    const { problem } = await readySet(ctx);
    expect(ctx.mock.calls.filter((c) => c.task === "practice_problem")).toHaveLength(3);
    const failed = ctx.repo.db.prepare("SELECT error_json FROM ai_jobs WHERE task = 'practice_problem' AND status = 'failed'").all() as { error_json: string }[];
    expect(failed).toHaveLength(1);
    expect(failed[0].error_json).toMatch(/3 rows but there are 4 row labels/);
    const key = ctx.repo.db.prepare("SELECT key_json FROM practice_steps WHERE label = '(a) matrix'").get() as { key_json: string };
    expect(JSON.parse(key.key_json).cells).toHaveLength(4);
    expect((await problem(0)).steps).toHaveLength(3);
  });

  it("one PDF can hold both the problems and their solutions", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const both = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf([...PRACTICE_GUIDE, ["Solutions"], ...PRACTICE_SOLUTIONS.slice(1)]), filename: "Practice Exam with Answers.pdf" });
    const app = createApp(ctx);
    const created = await request(app).post(`/api/courses/${course.id}/practice`).set(H).send({ problemSourceId: both.source.id, solutionSourceId: both.source.id });
    expect(created.status).toBe(200);
    await ctx.practice.extraction(created.body.id);
    const set = (await request(app).get(`/api/practice/${created.body.id}`)).body as PracticeSetView;
    expect(set).toMatchObject({ status: "ready", keySource: "solutions", problemTitle: "Practice Exam with Answers", solutionTitle: "Practice Exam with Answers" });
    expect(ctx.repo.db.prepare("SELECT outline_json FROM practice_sets").get()).toMatchObject({ outline_json: expect.stringContaining('"solutionPages":[5]') });
    const outlineCall = ctx.mock.calls.find((c) => c.task === "practice_outline")!;
    expect(outlineCall.input.solutionDocument).toEqual({ sameAsProblemDocument: true, filename: "Practice Exam with Answers.pdf", pageCount: 6 });
    const p = (await request(app).get(`/api/practice/problems/${set.problems[0].id}`)).body as PracticeProblemView;
    const step = (await attempt(app, stepOf(p, "(b)").id, { value: "2", confidence: "sure" })).body as PracticeStepView;
    expect(step.reveal!.solutionRefs[0]).toMatchObject({ sourceId: both.source.id, page: 5, label: "Practice Exam with Answers, page 5" });
    expect((await request(app).get("/api/courses")).body[0].lectures).toEqual([]);
  });

  it("without a solution document the AI solves it, and every solution says so", async () => {
    const ctx = testContext();
    const { set, problem } = await readySet(ctx, { solutions: false });
    expect(set.keySource).toBe("generated");
    expect(set.status).toBe("ready");
    const p = await problem(0);
    const step = (await attempt(createApp(ctx), p.steps[1].id, { value: "2", confidence: "sure" })).body as PracticeStepView;
    expect(step.reveal!.solution).toMatch(/^\*?AI-generated key/);
    expect(step.reveal!.solutionRefs).toEqual([]);
  });
});

describe("answering practice steps", () => {
  it("grades tables, numbers, sequences and choices deterministically", async () => {
    const ctx = testContext();
    const { app, problem, set } = await readySet(ctx);
    const p1 = await problem(0);

    const rows = EDIT_MATRIX.map((r) => [...r]);
    rows[1][3] = "3";
    const table = (await attempt(app, stepOf(p1, "(a)").id, { value: rows, confidence: "sure" })).body as PracticeStepView;
    expect(table.status).toBe("partial");
    const a = table.attempts[0];
    expect(a.score).toBeCloseTo(14 / 15);
    expect(a.correct).toBe(false);
    expect(a.cellResults![0][0]).toBeNull();
    expect(a.cellResults![1][3]).toBe(false);
    expect(a.feedback).toBe("14 of 15 cells are correct.");
    // Guided practice: a wrong answer keeps the key hidden (coaching follows instead).
    expect(table.reveal).toBeUndefined();

    const again = (await attempt(app, stepOf(p1, "(a)").id, { value: EDIT_MATRIX, confidence: "sure" })).body as PracticeStepView;
    expect(again.status).toBe("correct");
    expect(again.attempts).toHaveLength(2);
    expect(again.reveal!.expected).toEqual([["0", "1", "2", "3"], ["1", "0", "1", "2"], ["2", "1", "1", "1"], ["3", "2", "1", "2"]]);
    expect(again.reveal!.solutionRefs[0]).toMatchObject({ page: 2, label: "Exam 2 Study Guide Solutions, page 2", quote: expect.stringMatching(/matrix/) });
    expect((await attempt(app, stepOf(p1, "(b)").id, { value: "2", confidence: "sure" })).body.status).toBe("correct");

    const p2 = await problem(1);
    expect((await attempt(app, stepOf(p2, "(a)").id, { value: "(2, 2, 3, 3, 3, 3)", confidence: "sure" })).body.status).toBe("correct");
    expect((await attempt(app, stepOf(p2, "(b)").id, { value: "2.50 bits", confidence: "unsure" })).body.status).toBe("correct");
    const coarse = (await attempt(app, stepOf(p2, "(c)").id, { value: "2.6", confidence: "sure" })).body as PracticeStepView;
    expect(coarse.status).toBe("incorrect");
    expect(coarse.attempts[0].feedback).toMatch(/two decimal places/);
    expect(coarse.reveal).toBeUndefined();
    const fine = (await attempt(app, stepOf(p2, "(c)").id, { value: "2.585", confidence: "sure" })).body as PracticeStepView;
    expect(fine.status).toBe("correct");
    expect(fine.reveal!.expected).toBe("log2(6) ≈ 2.585 bits");
    const choice = (await attempt(app, stepOf(p2, "(d)").id, { value: ["uniform"], confidence: "sure" })).body as PracticeStepView;
    expect(choice.status).toBe("correct");
    expect(choice.reveal!.expected).toBe("The uniform source");

    const after = (await request(app).get(`/api/practice/${set.id}`)).body as PracticeSetView;
    expect(after.problems.map((p) => [p.answered, p.correct])).toEqual([[2, 2], [4, 4]]);

    // Evidence: computed steps are application evidence, and only first attempts count.
    const edit = ctx.repo.findConceptBySlug("edit-distance")!.id;
    const first = evidenceOf(ctx, a.id).filter((e) => e.concept_id === edit);
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ dimension: "application", delta: -1 }), expect.objectContaining({ dimension: "calibration", delta: -1 })]));
    expect(evidenceOf(ctx, again.attempts[1].id)).toEqual([]);
  });

  it("checks the answer's shape against the step's kind", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const p1 = await problem(0);
    const p2 = await problem(1);
    const bad = async (stepId: string, body: object, message: RegExp) => {
      const res = await attempt(app, stepId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(message);
    };
    await bad(stepOf(p1, "(a)").id, { value: "0 1 2 3", confidence: "sure" }, /list of rows/);
    await bad(stepOf(p1, "(a)").id, { value: [["", ""]], confidence: "sure" }, /at least one cell/);
    await bad(stepOf(p2, "(d)").id, { value: "uniform", confidence: "sure" }, /list of selected option values/);
    await bad(stepOf(p2, "(d)").id, { value: ["both"], confidence: "sure" }, /not one of this step's options/);
    await bad(stepOf(p1, "(b)").id, { value: [["2"]], confidence: "sure" }, /expects a text answer/);
    await bad(stepOf(p1, "(b)").id, { value: "  ", confidence: "sure" }, /Enter an answer/);
    await bad(stepOf(p1, "(b)").id, { value: "2" }, /confident/);
    expect((await request(app).post(`/api/practice/steps/${stepOf(p1, "(b)").id}/attempt`).send({ value: "2", confidence: "sure" })).status).toBe(403);
    expect((await attempt(app, "nope", { value: "2", confidence: "sure" })).status).toBe(404);
    expect((await problem(0)).steps.every((s) => s.attempts.length === 0)).toBe(true);
  });

  it("revealing shows the key and earns no positive evidence; “I don't know” keeps it hidden", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(0), "(b)");
    const revealed = (await request(app).post(`/api/practice/steps/${step.id}/reveal`).set(H)).body as PracticeStepView;
    expect(revealed.status).toBe("revealed");
    expect(revealed.attempts[0]).toMatchObject({ dontKnow: true, value: null, correct: null, gradingStatus: "done" });
    expect(revealed.reveal).toMatchObject({ expected: "2", solution: expect.stringMatching(/D\(3, 3\) = 2/) });
    const items = evidenceOf(ctx, revealed.attempts[0].id);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e) => e.delta <= 0)).toBe(true);
    // Answering after seeing the key is recorded but proves nothing.
    const copied = (await attempt(app, step.id, { value: "2", confidence: "sure" })).body as PracticeStepView;
    expect(copied.status).toBe("correct");
    expect(evidenceOf(ctx, copied.attempts[1].id)).toEqual([]);
    const idk = (await attempt(app, stepOf(await problem(1), "(b)").id, { dontKnow: true })).body as PracticeStepView;
    expect(idk.status).toBe("dont_know");
    expect(idk.reveal).toBeUndefined();
    expect(idk.attempts[0]).toMatchObject({ dontKnow: true, value: null });
    expect(evidenceOf(ctx, idk.attempts[0].id).every((e) => e.delta <= 0)).toBe(true);
    await ctx.practice.idle();
  });

  it("“Count as correct” overrides the grade and converts its evidence", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(0), "(b)");
    const wrong = (await attempt(app, step.id, { value: "3", confidence: "sure" })).body as PracticeStepView;
    expect(wrong.status).toBe("incorrect");
    const id = wrong.attempts[0].id;
    expect(evidenceOf(ctx, id).some((e) => e.delta < 0)).toBe(true);
    const fixed = (await request(app).post(`/api/practice/attempts/${id}/override`).set(H)).body as PracticeStepView;
    expect(fixed.status).toBe("correct");
    expect(fixed.attempts[0]).toMatchObject({ overridden: true, correct: false });
    const items = evidenceOf(ctx, id);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ dimension: "application", delta: 1 })]));
    expect(items.every((e) => e.delta >= 0)).toBe(true);
    const revealed = (await request(app).post(`/api/practice/steps/${stepOf(await problem(1), "(a)").id}/reveal`).set(H)).body as PracticeStepView;
    expect((await request(app).post(`/api/practice/attempts/${revealed.attempts[0].id}/override`).set(H)).status).toBe(400);
  });

  it("written explanations are graded later by the AI; misconceptions are recorded", async () => {
    const ctx = testContext();
    const graded: LiveEvent[] = [];
    ctx.bus.subscribe((e) => e.type === "practice" && e.status === "graded" && graded.push(e));
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(0), "(c)");
    const pending = (await attempt(app, step.id, { value: "One candidate swaps two letters as a transposition; another deletes X_i.", confidence: "sure" })).body as PracticeStepView;
    expect(pending.status).toBe("pending");
    expect(pending.attempts[0]).toMatchObject({ gradingStatus: "pending", correct: null, score: null });
    expect(pending.reveal).toBeUndefined(); // the key appears once the step is completed

    await ctx.practice.processPendingGrades();
    const done = stepOf(await problem(0), "(c)");
    expect(done.status).toBe("partial");
    expect(done.attempts[0]).toMatchObject({ gradingStatus: "done", correct: false });
    expect(done.attempts[0].feedback).toMatch(/1 of 3 key points/);
    expect(graded).toEqual([expect.objectContaining({ stepId: step.id, problemId: step.problemId })]);
    const edit = ctx.repo.findConceptBySlug("edit-distance")!.id;
    expect(ctx.repo.misconceptions(edit).map((m) => m.label)).toEqual(["counts a transposition as one edit"]);
    expect(evidenceOf(ctx, done.attempts[0].id)).toEqual(expect.arrayContaining([expect.objectContaining({ dimension: "explanation", delta: 0.3 })]));

    await attempt(app, step.id, { value: "Deleting X_i, inserting Y_j, or matching/substituting the last characters.", confidence: "sure" });
    await ctx.practice.processPendingGrades();
    expect(stepOf(await problem(0), "(c)").status).toBe("correct");
  });
});

describe("pauses, restarts and the course list", () => {
  it("a usage limit stops extraction; retry resumes without redoing finished problems, and answering keeps working", async () => {
    const ctx = testContext();
    let injected = false;
    ctx.bus.subscribe((e) => {
      if (e.type === "practice" && e.done === 1 && !injected) {
        injected = true;
        ctx.mock.failNext({ task: "practice_problem", kind: "usage_limit" });
      }
    });
    const { app, set, problem } = await readySet(ctx);
    expect(set.status).toBe("failed");
    expect(set.progress).toEqual({ done: 1, total: 2 });
    expect(set.error).toMatch(/usage limit.*1 of 2 problems are saved; retry/);

    // Stored problems stay usable while paused: deterministic grading needs no AI.
    const p1 = await problem(0);
    expect((await attempt(app, stepOf(p1, "(b)").id, { value: "2", confidence: "sure" })).body.status).toBe("correct");
    const written = (await attempt(app, stepOf(p1, "(c)").id, { value: "It deletes, inserts or substitutes.", confidence: "unsure" })).body as PracticeStepView;
    expect(written.status).toBe("pending");
    expect(await ctx.practice.processPendingGrades()).toBe(0);
    expect(stepOf(await problem(0), "(c)").status).toBe("pending");

    ctx.router.resume(); // the limit reset
    const retried = await request(app).post(`/api/practice/${set.id}/retry`).set(H);
    expect(retried.body.status).toBe("extracting");
    await ctx.practice.extraction(set.id);
    const after = (await request(app).get(`/api/practice/${set.id}`)).body as PracticeSetView;
    expect(after.status).toBe("ready");
    expect(after.error).toBeNull();
    expect(after.problems[0].id).toBe(set.problems[0].id);
    const problemCalls = ctx.mock.calls.filter((c) => c.task === "practice_problem").map((c) => c.input.problem.number);
    expect(problemCalls).toEqual(["1", "2", "2"]);
    expect(ctx.mock.calls.filter((c) => c.task === "practice_outline")).toHaveLength(1);
    expect(await ctx.practice.processPendingGrades()).toBe(1);
  });

  it("everything survives a restart; an extraction cut off by shutdown can be retried", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { set, problem, app } = await readySet(ctx1);
    const step = stepOf(await problem(0), "(a)");
    await attempt(app, step.id, { value: EDIT_MATRIX, confidence: "sure" });
    ctx1.repo.db.prepare("UPDATE practice_sets SET status = 'extracting' WHERE id = ?").run(set.id); // as if mid-run
    ctx1.db.close();

    const ctx2 = testContext({ dataDir });
    expect(ctx2.interruptedPracticeAtBoot).toBe(1);
    const app2 = createApp(ctx2);
    const stopped = (await request(app2).get(`/api/practice/${set.id}`)).body as PracticeSetView;
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toMatch(/retry/);
    const p = (await request(app2).get(`/api/practice/problems/${set.problems[0].id}`)).body as PracticeProblemView;
    expect(stepOf(p, "(a)")).toMatchObject({ status: "correct", attempts: [expect.objectContaining({ score: 1 })] });
    await request(app2).post(`/api/practice/${set.id}/retry`).set(H);
    await ctx2.practice.extraction(set.id);
    expect((await request(app2).get(`/api/practice/${set.id}`)).body.status).toBe("ready");
    expect(ctx2.mock.calls).toHaveLength(0); // nothing left to extract
  });

  it("practice documents leave the lecture list, the course shows a summary, and delete restores them", async () => {
    const ctx = testContext();
    const { app, course, set, problem } = await readySet(ctx);
    await attempt(app, stepOf(await problem(0), "(b)").id, { value: "2", confidence: "sure" });
    const courses = (await request(app).get("/api/courses")).body;
    expect(courses[0].lectures.map((l: { title: string }) => l.title)).toEqual(["Lecture 5 - Alignment"]);
    expect(courses[0].practice).toEqual([
      expect.objectContaining({ id: set.id, title: "Exam 2 Study Guide", status: "ready", problemCount: 2, stepCount: 7, answered: 1, correct: 1, progress: { done: 2, total: 2 } }),
    ]);
    expect(courses[0].practice[0].problems).toBeUndefined();

    const cand = (await request(app).get(`/api/courses/${course.id}/practice/candidates`)).body;
    expect(cand.sources.filter((s: { inPractice: boolean }) => s.inPractice).map((s: { title: string }) => s.title)).toEqual(["Exam 2 Study Guide", "Exam 2 Study Guide Solutions"]);
    expect(cand.suggested).toEqual([]);

    expect((await request(app).delete(`/api/practice/${set.id}`)).status).toBe(403);
    expect((await request(app).delete(`/api/practice/${set.id}`).set(H)).body).toEqual({ ok: true });
    expect((await request(app).get(`/api/practice/${set.id}`)).status).toBe(404);
    const back = (await request(app).get("/api/courses")).body[0];
    expect(back.lectures.map((l: { title: string }) => l.title)).toEqual(["Lecture 5 - Alignment", "Exam 2 Study Guide", "Exam 2 Study Guide Solutions"]);
    expect(back.practice).toEqual([]);
  });

  it("suggests study guides paired with their solutions", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const ids: Record<string, string> = {};
    for (const f of ["ICS691G_Exam_2_Study_Guide.pdf", "ICS691G_Exam_2_Study_Guide_Solutions.pdf", "ICS691G_Exam1_StudyGuide.pdf", "HW3.pdf", "HW3 - Answers.pdf", "ICS691G_Lec10_09292026_Annotated.pdf"]) {
      ids[f] = (await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf([[f]]), filename: f })).source.id;
    }
    const cand = (await request(createApp(ctx)).get(`/api/courses/${course.id}/practice/candidates`)).body;
    expect(cand.sources).toHaveLength(6);
    expect(cand.suggested).toEqual([
      { problemSourceId: ids["ICS691G_Exam_2_Study_Guide.pdf"], solutionSourceId: ids["ICS691G_Exam_2_Study_Guide_Solutions.pdf"], title: "ICS691G Exam 2 Study Guide" },
      { problemSourceId: ids["ICS691G_Exam1_StudyGuide.pdf"], solutionSourceId: null, title: "ICS691G Exam1 StudyGuide" },
      { problemSourceId: ids["HW3.pdf"], solutionSourceId: ids["HW3 - Answers.pdf"], title: "HW3" },
    ]);
  });

  it("“Learn this concept” starts a focused lesson on the weakest concept the problem needs", async () => {
    const ctx = testContext();
    const { app, problem, set, course } = await readySet(ctx);
    const p1 = await problem(0);
    await attempt(app, stepOf(p1, "(b)").id, { value: "3", confidence: "sure" }); // Edit distance: confidently wrong
    const res = await request(app).post(`/api/practice/problems/${p1.id}/learn`).set(H).send({});
    expect(res.status).toBe(200);
    const lesson = ctx.repo.getLesson(res.body.lessonId)!;
    expect(lesson.course_id).toBe(course.id);
    expect(lesson.objective).toBe(`Edit distance, as needed for problem 1 (Edit distance) of ${set.title}`);
    expect((await request(app).post(`/api/practice/problems/${p1.id}/learn`).set(H).send({})).body.lessonId).toBe(lesson.id);
    const dp = p1.concepts.find((c) => c.name === "Dynamic programming")!;
    const other = await request(app).post(`/api/practice/problems/${p1.id}/learn`).set(H).send({ conceptId: dp.id });
    expect(ctx.repo.getLesson(other.body.lessonId)!.objective).toMatch(/^Dynamic programming, as needed for problem 1/);
    expect((await request(app).post(`/api/practice/problems/${p1.id}/learn`).set(H).send({ conceptId: "nope" })).status).toBe(400);
  });
});

describe("review regressions: key provenance and misconception accounting", () => {
  const dropSolutionPages = (o: any) => {
    o.problems[0].solutionPages = [];
    return o;
  };

  it("keys backed by a verified solution quote are marked verified", async () => {
    const ctx = testContext();
    const { set, problem } = await readySet(ctx);
    expect(set.unverifiedSteps).toBe(0);
    expect((await problem(0)).steps.every((s) => s.keyVerified && s.keySource === "solutions")).toBe(true);
    const generated = await readySet(testContext(), { solutions: false });
    expect(generated.set.unverifiedSteps).toBe(7);
    expect((await generated.problem(0)).steps.every((s) => !s.keyVerified && s.keySource === "generated")).toBe(true);
  });

  it("an outline that maps a problem to no solution pages is repaired", async () => {
    const ctx = testContext();
    ctx.mock.failNext({ task: "practice_outline", kind: "mutate", mutate: dropSolutionPages });
    const { set, problem } = await readySet(ctx);
    expect(ctx.mock.calls.filter((c) => c.task === "practice_outline")).toHaveLength(2);
    const failed = ctx.repo.db.prepare("SELECT error_json FROM ai_jobs WHERE task = 'practice_outline' AND status = 'failed'").get() as { error_json: string };
    expect(failed.error_json).toMatch(/problem 1: solutionPages is empty/);
    expect(set.unverifiedSteps).toBe(0);
    expect((await problem(0)).steps.every((s) => s.keyVerified)).toBe(true);
  });

  it("if the outline still has no solution pages, those steps are marked unverified, not presented as from the solutions", async () => {
    const ctx = testContext();
    for (let i = 0; i < 3; i++) ctx.mock.failNext({ task: "practice_outline", kind: "mutate", mutate: dropSolutionPages });
    const { set, problem, app } = await readySet(ctx);
    expect(ctx.mock.calls.filter((c) => c.task === "practice_outline")).toHaveLength(3);
    expect(set.status).toBe("ready");
    expect(set.keySource).toBe("solutions");
    expect(set.unverifiedSteps).toBe(3);
    expect(set.problems.map((p) => p.unverifiedSteps)).toEqual([3, 0]);
    const p1 = await problem(0);
    expect(p1.steps.map((s) => s.keyVerified)).toEqual([false, false, false]);
    const step = (await attempt(app, stepOf(p1, "(b)").id, { value: "2", confidence: "sure" })).body as PracticeStepView;
    expect(step.reveal!.solutionRefs).toEqual([]);
    expect((await problem(1)).steps.every((s) => s.keyVerified)).toBe(true);
    const summary = (await request(app).get("/api/courses")).body[0].practice[0];
    expect(summary.unverifiedSteps).toBe(3);
  });

  it("an accepted outline with missing solution pages is reused from the cache by another course", async () => {
    const ctx = testContext();
    for (let i = 0; i < 3; i++) ctx.mock.failNext({ task: "practice_outline", kind: "mutate", mutate: dropSolutionPages });
    await readySet(ctx);
    expect(ctx.mock.calls.filter((c) => c.task === "practice_outline")).toHaveLength(3);
    const before = ctx.mock.calls.length;
    const second = await readySet(ctx);
    expect(second.set.status).toBe("ready");
    expect(ctx.mock.calls.slice(before).filter((c) => c.task === "practice_outline")).toHaveLength(0);
  });

  it("a step whose solution quote doesn't verify is marked unverified", async () => {
    const ctx = testContext();
    ctx.mock.failNext({
      task: "practice_problem",
      kind: "mutate",
      mutate: (p) => {
        p.steps[1].solutionRefs = p.steps[1].solutionRefs.map((r: any) => ({ ...r, quote: "a quote that appears nowhere in the solutions" }));
        return p;
      },
    });
    const { set, problem } = await readySet(ctx);
    expect((await problem(0)).steps.map((s) => s.keyVerified)).toEqual([true, false, true]);
    expect(set.unverifiedSteps).toBe(1);
  });

  it("a later attempt's misconception does not change mastery", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(0), "(c)");
    await attempt(app, step.id, { value: "Deleting X_i, inserting Y_j, or matching/substituting the last characters.", confidence: "sure" });
    await ctx.practice.processPendingGrades();
    await attempt(app, step.id, { value: "One candidate swaps two letters as a transposition.", confidence: "sure" });
    await ctx.practice.processPendingGrades();
    const done = stepOf(await problem(0), "(c)");
    expect(done.attempts.map((a) => a.gradingStatus)).toEqual(["done", "done"]);
    expect(done.attempts[1].correct).toBe(false);
    expect(ctx.repo.misconceptions()).toEqual([]);
    expect(evidenceOf(ctx, done.attempts[1].id)).toEqual([]);
  });

  /** Answer the explanation step with a misconception, then override before or after the AI grade lands. */
  async function overrideRace(order: "grade-first" | "override-first", existing = false) {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const edit = ctx.repo.findConceptBySlug("edit-distance")!.id;
    if (existing) ctx.repo.recordMisconception(edit, "counts a transposition as one edit", "seen elsewhere", null);
    const before = ctx.repo.misconceptions(edit).map((m) => ({ ...m }));
    const step = stepOf(await problem(0), "(c)");
    // Called directly: the grade starts in the background and can't land within this tick.
    const pending = ctx.practice.attempt(step.id, { value: "One candidate swaps two letters as a transposition; another deletes X_i.", confidence: "sure" });
    const id = pending.attempts[0].id;
    expect(pending.attempts[0].gradingStatus).toBe("pending");
    if (order === "grade-first") {
      await ctx.practice.processPendingGrades();
      expect(ctx.repo.misconceptions(edit).find((m) => m.label.includes("transposition"))!.occurrences).toBe(existing ? 2 : 1);
      ctx.practice.override(id);
    } else {
      ctx.practice.override(id); // before the grade lands
      await ctx.practice.processPendingGrades();
    }
    const final = stepOf(await problem(0), "(c)");
    expect(final.attempts[0]).toMatchObject({ overridden: true, gradingStatus: "done" });
    return {
      status: final.status,
      misconceptions: ctx.repo.misconceptions(edit),
      before,
      evidence: evidenceOf(ctx, id).map(({ dimension, delta }) => ({ dimension, delta })),
    };
  }

  it("a late grade records at the attempt's time, so it never reopens a resolution made after the answer", async () => {
    const ctx = testContext();
    const { problem } = await readySet(ctx);
    const edit = ctx.repo.findConceptBySlug("edit-distance")!.id;
    const label = "counts a transposition as one edit";
    ctx.repo.recordMisconception(edit, label, "seen earlier", "unsure", { kind: "other", id: null }, "2000-01-01T00:00:00.000Z");
    const step = stepOf(await problem(0), "(c)");
    const pending = ctx.practice.attempt(step.id, { value: "One candidate swaps two letters as a transposition; another deletes X_i.", confidence: "sure" });
    const answeredAt = (ctx.repo.db.prepare("SELECT created_at FROM practice_attempts WHERE id = ?").get(pending.attempts[0].id) as { created_at: string }).created_at;
    // A later lesson answer resolves it before the old answer is graded.
    const resolvedAt = new Date(Date.parse(answeredAt) + 1).toISOString();
    ctx.repo.resolveMisconception(edit, label, resolvedAt);
    await new Promise((r) => setTimeout(r, 10));
    await ctx.practice.processPendingGrades();
    expect(ctx.repo.misconceptions(edit).find((m) => m.label === label)).toMatchObject({ status: "resolved", resolved_at: resolvedAt, occurrences: 2 });
  });

  it("“Count as correct” retracts the attempt's misconception whether the AI grade lands before or after", async () => {
    const a = await overrideRace("grade-first");
    const b = await overrideRace("override-first");
    expect(a.status).toBe("correct");
    expect(a.misconceptions).toEqual([]);
    expect(b).toEqual(a);
    expect(a.evidence.every((e) => e.delta >= 0) && a.evidence.length > 0).toBe(true);
  });

  it("retracting restores a misconception that existed before the attempt exactly", async () => {
    const a = await overrideRace("grade-first", true);
    const b = await overrideRace("override-first", true);
    expect(a.misconceptions).toEqual(a.before);
    expect(b.misconceptions).toEqual(b.before);
    expect(a.misconceptions.map((m) => [m.label, m.occurrences, m.status, m.description])).toEqual(b.misconceptions.map((m) => [m.label, m.occurrences, m.status, m.description]));
  });
});

describe("deleting a practice set keeps its misconception contributions", () => {
  it("overriding another set's attempt afterwards leaves the deleted set's occurrence in place", async () => {
    const ctx = testContext();
    const edit = () => ctx.repo.findConceptBySlug("edit-distance")!.id;
    const value = { value: "One candidate swaps two letters as a transposition; another deletes X_i.", confidence: "sure" as const };
    const first = await readySet(ctx);
    ctx.practice.attempt(stepOf(await first.problem(0), "(c)").id, value);
    await ctx.practice.processPendingGrades();
    const second = await readySet(ctx);
    const b = ctx.practice.attempt(stepOf(await second.problem(0), "(c)").id, value).attempts[0].id;
    await ctx.practice.processPendingGrades();
    const label = ctx.repo.misconceptions(edit())[0].label;
    expect(ctx.repo.misconceptions(edit()).map((m) => m.occurrences)).toEqual([2]);
    ctx.practice.delete(first.set.id);
    ctx.practice.override(b);
    const left = ctx.repo.misconceptions(edit());
    expect(left.map((m) => [m.label, m.occurrences, m.status])).toEqual([[label, 1, "likely"]]);
  });
});

describe("misconception retraction recomputes from surviving contributions", () => {
  it("baseline guess, two practice attempts, both overridden: the row returns to its original state", async () => {
    const { PracticeRepo } = await import("../src/server/practice/repo.ts");
    const ctx = testContext();
    const c = ctx.repo.createConcept("bayes-rule", "Bayes rule", null, "Inverting conditional probabilities.");
    const baseline = ctx.repo.recordMisconception(c.id, "M", "baseline description", "guess");
    expect([baseline.status, baseline.strongest_confidence]).toEqual(["suspected", "guess"]);
    const store = new PracticeRepo(ctx.repo);
    store.recordAttemptMisconception("att-1", c.id, "M", "first attempt description", "sure");
    store.recordAttemptMisconception("att-2", c.id, "M", "second attempt description", "unsure");
    const mid = ctx.repo.misconceptions(c.id)[0];
    expect([mid.occurrences, mid.status, mid.strongest_confidence, mid.description]).toEqual([3, "likely", "sure", "second attempt description"]);
    // Overriding the first leaves the second's contribution: still a repeat, but no longer sure.
    store.retractAttemptMisconceptions("att-1");
    const one = ctx.repo.misconceptions(c.id)[0];
    expect([one.occurrences, one.status, one.strongest_confidence, one.description]).toEqual([2, "likely", "guess", "second attempt description"]);
    store.retractAttemptMisconceptions("att-2");
    expect(ctx.repo.misconceptions(c.id)).toEqual([baseline]);
  });

  it("a row created by practice alone goes when its attempts are overridden, and the other order works too", async () => {
    const { PracticeRepo } = await import("../src/server/practice/repo.ts");
    const ctx = testContext();
    const c = ctx.repo.createConcept("bayes-rule", "Bayes rule", null, "Inverting conditional probabilities.");
    const store = new PracticeRepo(ctx.repo);
    store.recordAttemptMisconception("att-1", c.id, "M", "first", "guess");
    store.recordAttemptMisconception("att-2", c.id, "M", "second", "sure");
    store.retractAttemptMisconceptions("att-2");
    const left = ctx.repo.misconceptions(c.id)[0];
    expect([left.occurrences, left.status, left.strongest_confidence, left.description]).toEqual([1, "suspected", "guess", "first"]);
    store.retractAttemptMisconceptions("att-1");
    expect(ctx.repo.misconceptions(c.id)).toEqual([]);
  });
});

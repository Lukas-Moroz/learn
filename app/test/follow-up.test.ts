// Follow-up questions: threads on practice steps, coaching rounds and lesson blocks; streamed
// answers; persistence across restarts; pauses; leak safety before a step is finished (and the
// open question's correct option in a lesson); compact coaching data; and migration 4.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "../src/server/ai/prompts.ts";
import { createApp } from "../src/server/app.ts";
import type { AppContext } from "../src/server/context.ts";
import { DB, MIGRATIONS } from "../src/server/db/database.ts";
import type { LiveEvent } from "../src/server/events.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { sentenceCount } from "../src/server/practice/guide.ts";
import { lessonView } from "../src/server/teaching/view.ts";
import type { FollowUpThreadView } from "../src/shared/followup.ts";
import { followUpLeaks, namesVerbatim } from "../src/shared/practice-leak.ts";
import type { PracticeProblemView, PracticeSetView, PracticeStepView } from "../src/shared/practice.ts";
import { ALIGNMENT_LECTURE, MARKOV_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf, pendingQuestion, testContext, tmpDir } from "./helpers.ts";

const H = { "x-learn": "1" };
type App = ReturnType<typeof createApp>;

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
  const problem = async (n: number, a: App = app) => (await request(a).get(`/api/practice/problems/${set.problems[n].id}`)).body as PracticeProblemView;
  return { app, set, problem };
}

const stepOf = (p: PracticeProblemView, label: string) => p.steps.find((s) => s.label.startsWith(label))!;
const attempt = async (app: App, stepId: string, body: object) => (await request(app).post(`/api/practice/steps/${stepId}/attempt`).set(H).send(body)).body as PracticeStepView;
const ask = (app: App, kind: string, id: string, question: string) => request(app).post("/api/follow-ups").set(H).send({ kind, id, question });
const followUpCalls = (ctx: AppContext) => ctx.mock.calls.filter((c) => c.task === "follow_up");
async function settle(ctx: AppContext) {
  await ctx.practice.idle();
  await ctx.followUps.idle();
}
function collect(ctx: AppContext) {
  const events: LiveEvent[] = [];
  const off = ctx.bus.subscribe((e) => events.push(structuredClone(e)));
  return { events, off };
}

describe("follow-ups on practice steps", () => {
  it("after a correct answer: answered with the key open, cited, multiple turns, persisted across a restart", async () => {
    const dataDir = tmpDir();
    const ctx = testContext({ dataDir });
    const { app, problem, set } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    // Asking before any attempt is refused: there is nothing to follow up on yet.
    expect((await ask(app, "practice_step", step.id, "Why?")).status).toBe(409);

    const right = await attempt(app, step.id, { value: "2.5", confidence: "sure" });
    expect(right).toMatchObject({ status: "correct", followUp: null });
    const first = await ask(app, "practice_step", step.id, "Why do the rare symbols count for more?");
    expect(first.status).toBe(200);
    expect((first.body as FollowUpThreadView).turns).toEqual([expect.objectContaining({ question: "Why do the rare symbols count for more?", status: "pending", answer: null })]);
    await settle(ctx);

    const input = followUpCalls(ctx)[0].input;
    expect(input).toMatchObject({ keyStatus: "open", key: { expected: "2.5 bits" }, question: "Why do the rare symbols count for more?", thread: [] });
    expect(input).not.toHaveProperty("hiddenKey");
    expect(input.about.step.label).toMatch(/^\(b\)/);
    expect(input.learner.attempts).toEqual([expect.objectContaining({ answer: "2.5", confidence: "sure" })]);
    expect(input.lecture.excerpts.length).toBeGreaterThan(0);
    expect(input.concepts.map((c: { name: string }) => c.name)).toContain("Entropy");

    let s = stepOf(await problem(1), "(b)");
    const t1 = s.followUp!.turns[0];
    expect(t1).toMatchObject({ status: "ready", error: null, answer: expect.stringMatching(/Entropy/) });
    expect(t1.answer).toMatch(/2\.5 bits/); // the step is finished: the answer may discuss the key
    expect(t1.refs[0]).toMatchObject({ verified: true, quote: expect.any(String) });
    expect(t1.provenance).toBe("source");

    // A second turn carries the first as context.
    await ask(app, "practice_step", step.id, "And for a uniform source?");
    await settle(ctx);
    expect(followUpCalls(ctx)[1].input.thread).toEqual([{ question: "Why do the rare symbols count for more?", answer: t1.answer }]);
    s = stepOf(await problem(1), "(b)");
    expect(s.followUp!.turns.map((t) => [t.question, t.status])).toEqual([
      ["Why do the rare symbols count for more?", "ready"],
      ["And for a uniform source?", "ready"],
    ]);
    // Follow-ups record no evidence and change no attempt.
    expect(s.attempts).toHaveLength(1);

    // A third question cut off by a shutdown waits after restart, and a retry answers it.
    await ask(app, "practice_step", step.id, "One more?");
    await settle(ctx);
    const third = s.followUp!.id;
    ctx.repo.db.prepare("UPDATE follow_up_turns SET status = 'pending', answer = NULL WHERE question = 'One more?'").run();
    ctx.db.close();

    const ctx2 = testContext({ dataDir });
    expect(ctx2.interruptedFollowUpsAtBoot).toBe(1);
    const app2 = createApp(ctx2);
    const after = stepOf((await request(app2).get(`/api/practice/problems/${set.problems[1].id}`)).body, "(b)");
    expect(after.followUp!.id).toBe(third);
    expect(after.followUp!.turns.slice(0, 2)).toEqual(s.followUp!.turns);
    expect(after.followUp!.turns[2]).toMatchObject({ status: "waiting", error: expect.stringMatching(/closed/), answer: null });
    expect(ctx2.mock.calls).toHaveLength(0);
    const retried = await request(app2).post(`/api/follow-ups/turns/${after.followUp!.turns[2].id}/retry`).set(H);
    expect(retried.body.turns[2].status).toBe("pending");
    await settle(ctx2);
    expect((await request(app2).get(`/api/follow-ups/${third}`)).body.turns[2].status).toBe("ready");
  });

  it("streams the answer live (field \"answer\"), in order, then announces it ready", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    await attempt(app, step.id, { value: "2.5", confidence: "sure" });
    const { events, off } = collect(ctx);
    const thread = (await ask(app, "practice_step", step.id, "Why log base 2?")).body as FollowUpThreadView;
    await settle(ctx);
    off();
    const jobs = events.filter((e) => e.type === "job" && e.task === "follow_up");
    const previews = jobs.filter((e) => e.preview).map((e) => e.preview!);
    expect(previews.length).toBeGreaterThan(3);
    expect(jobs.find((e) => e.preview)).toMatchObject({ threadId: thread.id, followUpId: thread.turns[0].id });
    for (let i = 1; i < previews.length; i++) expect(previews[i].answer.startsWith(previews[i - 1].answer)).toBe(true);
    expect(Object.keys(previews[0])).toEqual(["answer"]);
    const done = events.findIndex((e) => e.type === "followup" && e.status === "ready");
    expect(done).toBeGreaterThan(events.findIndex((e) => e.type === "job" && e.task === "follow_up" && e.status === "completed"));
    const final = stepOf(await problem(1), "(b)").followUp!.turns[0].answer!;
    expect(final.startsWith(previews.at(-1)!.answer)).toBe(true);
  });

  it("before the step is finished the key is forbidden context: a leaking preview is withheld and the answer repaired; after, it's open", async () => {
    const ctx = testContext({ mockDelayMs: 1, previewMs: 0 });
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    const wrong = await attempt(app, step.id, { value: "3", confidence: "sure" });
    expect(wrong.status).toBe("incorrect");
    await settle(ctx);
    const coaching = stepOf(await problem(1), "(b)").coaching[0];

    ctx.mock.failNext({ task: "follow_up", kind: "mutate", mutate: (o) => ({ ...o, answer: `It is $H(X) = 2.5$ bits, since ${o.answer}` }) });
    const { events, off } = collect(ctx);
    await ask(app, "practice_coaching", coaching.id, "Is it 2.5?");
    await settle(ctx);
    off();
    const input = followUpCalls(ctx)[0].input;
    expect(input).toMatchObject({ keyStatus: "hidden", hiddenKey: { expected: "2.5 bits", forbiddenValues: ["2.5"] } });
    expect(input).not.toHaveProperty("key");
    expect(input.shown.coaching).toMatchObject({ diagnosis: coaching.diagnosis, summary: coaching.summary });

    const jobs = [...new Set(events.filter((e) => e.task === "follow_up").map((e) => e.jobId))];
    expect(jobs).toHaveLength(2); // rejected, then repaired
    expect(JSON.stringify(events.filter((e) => e.jobId === jobs[0]))).not.toMatch(/2\.5/);
    expect(events.some((e) => e.jobId === jobs[0] && e.preview === null && e.revising)).toBe(true);
    const thread = stepOf(await problem(1), "(b)").coaching[0].followUp!;
    expect(thread.turns[0]).toMatchObject({ status: "ready", question: "Is it 2.5?" });
    expect(thread.turns[0].answer).not.toMatch(/2\.5/);
    expect(thread.turns[0].answer).toMatch(/won't give the step's answer away/);

    // A model that keeps leaking fails the turn (retry offered); nothing leaked is stored or shown.
    for (let i = 0; i < 3; i++) ctx.mock.failNext({ task: "follow_up", kind: "mutate", mutate: (o) => ({ ...o, answer: `The answer is 2.5 bits. ${o.answer}` }) });
    await ask(app, "practice_coaching", coaching.id, "Just tell me");
    await settle(ctx);
    const failed = stepOf(await problem(1), "(b)").coaching[0].followUp!.turns[1];
    expect(failed).toMatchObject({ status: "failed", answer: null, error: expect.stringMatching(/didn't pass the checks/) });
    // (The learner's own question may say "2.5"; nothing the app wrote does.)
    const shown = stepOf(await problem(1), "(b)");
    const authored = [
      shown.prompt, shown.hint, ...shown.attempts.map((a) => a.feedback),
      ...shown.coaching.flatMap((c) => [
        c.diagnosis, c.summary, c.explanation, c.example, c.nextHint,
        c.check?.stem, ...(c.check?.options.map((o) => o.label) ?? []),
        ...c.refs.map((r) => r.quote),
        ...(c.followUp?.turns.flatMap((t) => [t.answer, t.error, ...t.refs.map((r) => r.quote)]) ?? []),
      ]),
    ];
    // Timestamps such as 12:32.500 and IDs carry no authored answer content.
    expect(JSON.stringify(authored)).not.toMatch(/2\.5/);

    // Once the step is finished the same thread may discuss the answer freely.
    await attempt(app, step.id, { value: "2.5", confidence: "sure" });
    await request(app).post(`/api/follow-ups/turns/${failed.id}/retry`).set(H);
    await settle(ctx);
    expect(followUpCalls(ctx).at(-1)!.input).toMatchObject({ keyStatus: "open", key: { expected: "2.5 bits" } });
    expect(stepOf(await problem(1), "(b)").followUp).toBeNull(); // the coaching thread is its own thread
    const open = (await request(app).get(`/api/follow-ups/${thread.id}`)).body as FollowUpThreadView;
    expect(open.turns[1]).toMatchObject({ status: "ready", answer: expect.stringMatching(/2\.5 bits/) });
  });

  it("while paused a question waits (one at a time) and is answered on resume", async () => {
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(c)");
    await request(app).post(`/api/practice/steps/${step.id}/reveal`).set(H);
    ctx.mock.failNext({ task: "follow_up", kind: "usage_limit" });
    await ask(app, "practice_step", step.id, "Why is the uniform source larger?");
    await settle(ctx);
    expect(ctx.router.paused).not.toBeNull();
    const waiting = stepOf(await problem(1), "(c)").followUp!.turns[0];
    expect(waiting).toMatchObject({ status: "waiting", answer: null, error: expect.stringMatching(/usage limit/i) });
    const second = await ask(app, "practice_step", step.id, "Another?");
    expect(second.status).toBe(409);
    await request(app).post("/api/providers/resume").set(H);
    await settle(ctx);
    expect(stepOf(await problem(1), "(c)").followUp!.turns[0].status).toBe("ready");
  });

  it("validates input: empty questions, unknown targets, non-follow-up lesson blocks", async () => {
    const ctx = testContext();
    const { app } = await readySet(ctx);
    expect((await ask(app, "practice_step", "nope", "Why?")).status).toBe(404);
    expect((await ask(app, "practice_step", "nope", "   ")).body.error.message).toMatch(/Type a question/);
    expect((await ask(app, "elsewhere", "x", "Why?")).status).toBe(400);
  });
});

describe("compact coaching", () => {
  it("coaching carries a ≤ 2-sentence summary; older rows fall back to the explanation's first paragraph", async () => {
    expect(PROMPT_VERSION.practice_coach).toBe("practice-coach-v3");
    const ctx = testContext();
    const { app, problem } = await readySet(ctx);
    const step = stepOf(await problem(1), "(b)");
    // A summary that runs long is sent back for a revision.
    ctx.mock.failNext({ task: "practice_coach", kind: "mutate", mutate: (o) => ({ ...o, summary: "One. Two. Three sentences here." }) });
    await attempt(app, step.id, { value: "3", confidence: "sure" });
    await settle(ctx);
    const c = stepOf(await problem(1), "(b)").coaching[0];
    expect(c.status).toBe("ready");
    expect(c.summary).toMatch(/Entropy/);
    expect(sentenceCount(c.summary)).toBeLessThanOrEqual(2);
    expect(ctx.mock.calls.filter((x) => x.task === "practice_coach")).toHaveLength(2);
    expect(c.followUp).toBeNull();

    // A row stored before summaries existed.
    const row = ctx.practice.store.getCoaching(c.id)!;
    const { summary: _s, ...old } = row.content!;
    ctx.practice.store.setCoaching(c.id, { status: "ready", content: { ...old, explanation: "First paragraph of the idea.\n\nSecond paragraph." } });
    expect(stepOf(await problem(1), "(b)").coaching[0].summary).toBe("First paragraph of the idea.");
  });

  it("counts sentences without tripping on decimals, abbreviations or math", () => {
    expect(sentenceCount("Entropy is 2.5 bits on average, e.g. for this source. It is an average.")).toBe(2);
    expect(sentenceCount("Use $p = 0.5$. Then sum.")).toBe(2);
    expect(sentenceCount("A. B. C.")).toBe(3);
  });
});

describe("follow-ups in a lesson", () => {
  async function lessonWithOpenQuestion() {
    const ctx = testContext();
    const course = ctx.repo.createCourse("Probabilistic Models");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    // Advance (answering "I don't know") until an explanation is followed by an open question.
    for (let i = 0; i < 20; i++) {
      const q = pendingQuestion(ctx, lesson.id);
      const explained = ctx.repo.listBlocks(lesson.id).some((b) => b.type === "explanation");
      if (q && explained) break;
      if (q) await ctx.engine.answer(lesson.id, q.id, { selected: [], dontKnow: true });
      else await ctx.engine.advance(lesson.id);
    }
    const explanation = ctx.repo.listBlocks(lesson.id).filter((b) => b.type === "explanation").at(-1)!;
    const q = pendingQuestion(ctx, lesson.id)!;
    expect(q).toBeTruthy();
    return { ctx, app: createApp(ctx), lesson, explanation, q };
  }

  it("an unanswered question's correct option is never named; answering it opens the answer; no lesson state or evidence changes", async () => {
    const { ctx, app, lesson, explanation, q } = await lessonWithOpenQuestion();
    const row = ctx.repo.getQuestion(q.id)!;
    const correctLabel = row.options.find((o) => o.value === row.correct[0])!.label;
    const stateBefore = JSON.stringify(ctx.repo.getLesson(lesson.id)!.state);
    const evidenceBefore = ctx.repo.db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number };

    ctx.mock.failNext({ task: "follow_up", kind: "mutate", mutate: (o) => ({ ...o, answer: `${o.answer}\n\nSo the answer to your question is: ${correctLabel}` }) });
    const res = await ask(app, "lesson_block", explanation.id, "Can you say that more simply?");
    expect(res.status).toBe(200);
    await settle(ctx);
    const input = followUpCalls(ctx)[0].input;
    expect(input.openQuestion).toMatchObject({ stem: row.stem, doNotSay: [correctLabel] });
    expect(input.about.explanation.title).toBe(explanation.payload.title);
    expect(followUpCalls(ctx)).toHaveLength(2); // the leaking answer was rejected and repaired
    let view = lessonView(ctx.engine, ctx.repo.getLesson(lesson.id)!);
    const turn = view.blocks.find((b) => b.id === explanation.id)!.followUp!.turns[0];
    expect(turn.status).toBe("ready");
    expect(namesVerbatim(turn.answer!, correctLabel)).toBe(false);

    // Nothing about the lesson moved; one event was recorded.
    expect(JSON.stringify(ctx.repo.getLesson(lesson.id)!.state)).toBe(stateBefore);
    expect((ctx.repo.db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as { n: number }).n).toBe(evidenceBefore.n);
    expect(ctx.repo.events(lesson.id).filter((e) => e.type === "follow_up")).toHaveLength(1);

    // After answering, a follow-up on the feedback is about the answered question, with nothing withheld.
    await ctx.engine.answer(lesson.id, q.id, { selected: [row.correct[0]], dontKnow: false, confidence: "unsure" });
    view = lessonView(ctx.engine, ctx.repo.getLesson(lesson.id)!);
    const fb = view.blocks.find((b) => b.type === "feedback" && b.payload.questionId === q.id)!;
    expect(fb.followUp).toBeNull();
    await ask(app, "lesson_block", fb.id, "Why is that right?");
    await settle(ctx);
    const fbInput = followUpCalls(ctx).at(-1)!.input;
    expect(fbInput).not.toHaveProperty("openQuestion");
    expect(fbInput.about.question).toMatchObject({ stem: row.stem, correct: [correctLabel] });
    expect(fbInput.learner).toMatchObject({ chose: [correctLabel], correct: true, confidence: "unsure" });
    view = lessonView(ctx.engine, ctx.repo.getLesson(lesson.id)!);
    expect(view.blocks.find((b) => b.id === fb.id)!.followUp!.turns[0].status).toBe("ready");

    // Only explanations and answers take follow-ups.
    const other = ctx.repo.listBlocks(lesson.id).find((b) => b.type === "question")!;
    expect((await ask(app, "lesson_block", other.id, "Hm?")).status).toBe(400);
  });

  it("the deterministic option check matches whole phrases only", () => {
    expect(namesVerbatim("It is **the present screens off the past**.", "The present screens off the past")).toBe(true);
    expect(namesVerbatim("presently", "present")).toBe(false);
    expect(namesVerbatim("anything", "ab")).toBe(false);
  });

  it("choice and short-text keys count as leaks only when written out and not already in the problem", () => {
    const choice = { kind: "choice" as const, options: [{ value: "a", label: "The uniform source" }, { value: "b", label: "The skewed source" }], correct: "a", multiSelect: false };
    expect(followUpLeaks(choice, "Clearly the uniform source wins.", "")).toEqual(["The uniform source"]);
    expect(followUpLeaks(choice, "Compare how spread out each one is.", "")).toEqual([]);
    expect(followUpLeaks(choice, "the uniform source", "Which is larger: the uniform source or the skewed source?")).toEqual([]);
    const text = { kind: "text" as const, accepted: ["AC-T"], caseSensitive: false };
    expect(followUpLeaks(text, "The row reads AC-T.", "")).toEqual(["AC-T"]);
  });
});

describe("migration 4", () => {
  it("upgrades a version-3 database: follow-up tables appear and existing practice data is intact", async () => {
    const dataDir = tmpDir();
    const ctx1 = testContext({ dataDir });
    const { app, problem, set } = await readySet(ctx1);
    const p = await problem(1);
    await attempt(app, stepOf(p, "(b)").id, { value: "3", confidence: "sure" });
    await settle(ctx1);
    const before = stepOf(await problem(1), "(b)");
    ctx1.repo.db.exec("ALTER TABLE practice_steps DROP COLUMN skipped; DROP TABLE follow_up_turns; DROP TABLE follow_up_threads; PRAGMA user_version = 3");
    ctx1.db.close();
    const raw = new DB(`${dataDir}/learn.db`);
    expect(raw.pragma("user_version", { simple: true })).toBe(3);
    raw.close();

    const ctx2 = testContext({ dataDir });
    expect(ctx2.repo.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(5);
    const app2 = createApp(ctx2);
    const after = stepOf(await problem(1, app2), "(b)");
    expect(after.attempts).toEqual(before.attempts);
    expect(after.coaching.map(({ followUp: _f, ...c }) => c)).toEqual(before.coaching.map(({ followUp: _f, ...c }) => c));
    expect(after.followUp).toBeNull();
    await ask(app2, "practice_coaching", after.coaching[0].id, "Where do I start?");
    await settle(ctx2);
    expect(stepOf(await problem(1, app2), "(b)").coaching[0].followUp!.turns[0].status).toBe("ready");

    // Deleting the set removes its threads too.
    await request(app2).delete(`/api/practice/${set.id}`).set(H);
    expect((ctx2.repo.db.prepare("SELECT COUNT(*) AS n FROM follow_up_turns").get() as { n: number }).n).toBe(0);
  });
});

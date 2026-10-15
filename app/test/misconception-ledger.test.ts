// The misconception ledger: every occurrence is a contribution keyed by its source, and a
// misconceptions row is derived purely from the active ones. Regression tests for the findings
// that the earlier snapshot/cutoff retraction kept getting wrong.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MIGRATION_STEPS, openDatabase } from "../src/server/db/database.ts";
import { Repo } from "../src/server/db/repo.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { PracticeRepo } from "../src/server/practice/repo.ts";
import { MARKOV_LECTURE, makePdf, testContext, tmpDir } from "./helpers.ts";

/** A lesson answer on a distractor whose written reasoning is deferred (no provider at the time). */
async function deferredWrongAnswer(confidence: "sure" | "unsure" = "unsure") {
  const ctx = testContext();
  const course = ctx.repo.createCourse("C");
  const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
  await ctx.engine.advance(lesson.id);
  const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
  const distractor = q.options.find((o) => o.misconception)!;
  ctx.mock.failNext({ task: "evaluate_reasoning", kind: "interrupt", afterChars: 5 });
  await ctx.engine.answer(lesson.id, q.id, { selected: [distractor.value], confidence, note: "because it seemed right" });
  const pending = ctx.repo.pendingReasoning();
  expect(pending).toHaveLength(1);
  const diagnose = (label: string, description = `${label} from reasoning`) => {
    (ctx.engine as any).evaluateReasoning = async () => ({ verdict: "flawed", summary: "x", issues: [], misconception: { label, description } });
    return ctx.engine.processPendingReasoning();
  };
  return { ctx, q, D: distractor.misconception!, attemptId: pending[0].id, store: new PracticeRepo(ctx.repo), diagnose };
}
const rows = (ctx: ReturnType<typeof testContext>, conceptId: string) =>
  Object.fromEntries(ctx.repo.misconceptions(conceptId).map((m) => [m.label, [m.occurrences, m.status]]));

describe("practice overrides never erase or resurrect lesson diagnoses", () => {
  it("(a) an earlier lesson answer diagnosed after practice created M survives overriding the practice attempt", async () => {
    const { ctx, q, D, store, diagnose } = await deferredWrongAnswer();
    store.recordAttemptMisconception("practice-1", q.concept_id, "M", "from practice", "unsure");
    expect(await diagnose("M")).toBe(1);
    expect(rows(ctx, q.concept_id)).toEqual({ M: [2, "likely"] });
    store.retractAttemptMisconceptions("practice-1");
    expect(rows(ctx, q.concept_id)).toEqual({ M: [1, "suspected"] });
    expect(ctx.repo.misconceptions(q.concept_id)[0].description).toBe("M from reasoning");
    expect(D).not.toBe("M");
  });

  it("(b) a pending diagnosis M replaced by R is not resurrected when the practice attempt is overridden", async () => {
    const { ctx, q, D, store, diagnose } = await deferredWrongAnswer();
    store.recordAttemptMisconception("practice-1", q.concept_id, D, "from practice", "unsure");
    expect(rows(ctx, q.concept_id)).toEqual({ [D]: [2, "likely"] });
    expect(await diagnose("R")).toBe(1);
    expect(rows(ctx, q.concept_id)).toEqual({ [D]: [1, "suspected"], R: [1, "suspected"] });
    store.retractAttemptMisconceptions("practice-1");
    expect(rows(ctx, q.concept_id)).toEqual({ R: [1, "suspected"] });
  });
});

describe("deferred replacement retracts the attempt's distractor even when its row was resolved", () => {
  it("pending M resolved by later correct answers, then replaced by R: M has no contributor and goes", async () => {
    const { ctx, q, D, diagnose } = await deferredWrongAnswer();
    ctx.repo.resolveMisconceptions(q.concept_id);
    expect(ctx.repo.misconceptions(q.concept_id)[0]).toMatchObject({ label: D, status: "resolved", occurrences: 1 });
    expect(await diagnose("R")).toBe(1);
    expect(rows(ctx, q.concept_id)).toEqual({ R: [1, "suspected"] });
  });

  it("a resolved row keeps its resolution when an older contribution is retracted", () => {
    const ctx = testContext();
    const c = ctx.repo.createConcept("bayes-rule", "Bayes rule", null, "x");
    ctx.repo.recordMisconception(c.id, "M", null, "guess", { kind: "lesson", id: "l-1" }, "2026-01-01T00:00:00.000Z");
    ctx.repo.recordMisconception(c.id, "M", null, "guess", { kind: "lesson", id: "l-2" }, "2026-01-02T00:00:00.000Z");
    ctx.repo.resolveMisconception(c.id, "M", "2026-01-03T00:00:00.000Z");
    ctx.repo.retractMisconceptions("lesson", "l-1");
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ occurrences: 1, status: "resolved", resolved_at: "2026-01-03T00:00:00.000Z" });
    // A new occurrence after the resolution reopens it.
    ctx.repo.recordMisconception(c.id, "M", null, "guess", { kind: "lesson", id: "l-3" }, "2026-01-04T00:00:00.000Z");
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ occurrences: 2, status: "likely", resolved_at: null });
  });
});

describe("migration backfills the ledger from existing v1 rows", () => {
  it("rebuilding every backfilled row reproduces it exactly", () => {
    const file = join(tmpDir(), "v1.db");
    const raw = new DatabaseSync(file);
    raw.exec(MIGRATIONS[0]);
    raw.exec("PRAGMA user_version = 1");
    const ins = raw.prepare("INSERT INTO misconceptions VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("m1", "single guess", null, "suspected", 1, "guess", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
    ins.run("m2", "repeat", "desc", "likely", 3, "sure", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z", null);
    ins.run("m3", "resolved", "d3", "resolved", 2, null, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    ins.run("m4", "single sure", null, "likely", 1, "sure", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null);
    raw.close();
    const repo = new Repo(openDatabase(file));
    const before = repo.misconceptions().map((m) => ({ ...m }));
    expect(before).toHaveLength(4);
    expect((repo.db.prepare("SELECT COUNT(*) AS n FROM misconception_contributions").get() as { n: number }).n).toBe(7);
    for (const m of before) repo.rebuildMisconception(m.concept_id, m.label);
    expect(repo.misconceptions()).toEqual(before);
  });
});

describe("migration attributes pending v1 answers to their attempts", () => {
  /** Downgrade ctx's DB to v1 with the given rows and attempt edits, then re-run migration 2's ledger part. */
  function remigrate(ctx: ReturnType<typeof testContext>, setup: () => void) {
    const db = ctx.repo.db;
    db.exec("DELETE FROM misconception_contributions; DELETE FROM misconception_resolutions; DELETE FROM misconceptions;");
    setup();
    db.exec("DROP TABLE misconception_contributions; DROP TABLE misconception_resolutions; PRAGMA user_version = 1");
    db.exec(MIGRATIONS[1].slice(MIGRATIONS[1].indexOf("-- The misconception ledger")));
    MIGRATION_STEPS[2](db);
    db.pragma("user_version = 2");
  }
  const v1 = (ctx: ReturnType<typeof testContext>) => ctx.repo.db.prepare("INSERT INTO misconceptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

  it("a v1 pending multi-select listing M twice counts once (the double count is dropped); deferred R removes M", async () => {
    const { ctx, q, attemptId, diagnose } = await deferredWrongAnswer();
    const at = ctx.repo.getAttempt(attemptId)!.created_at;
    remigrate(ctx, () => {
      ctx.repo.db.prepare(`UPDATE attempts SET misconceptions_json = '["M","M"]' WHERE id = ?`).run(attemptId);
      v1(ctx).run("v1m", q.concept_id, "M", null, "likely", 2, "unsure", at, at, null);
    });
    expect(ctx.repo.db.prepare("SELECT source_kind, source_id FROM misconception_contributions WHERE label = 'M'").all()).toEqual([{ source_kind: "lesson", source_id: attemptId }]);
    expect(await diagnose("R")).toBe(1);
    expect(rows(ctx, q.concept_id)).toEqual({ R: [1, "suspected"] });
  });

  it("an earlier guess M and a later pending sure M keep their own confidences: replacing the later one leaves M suspected/guess", async () => {
    const { ctx, q, D, attemptId, diagnose } = await deferredWrongAnswer("sure");
    const late = ctx.repo.getAttempt(attemptId)!.created_at;
    const early = "2000-01-01T00:00:00.000Z";
    remigrate(ctx, () => {
      ctx.repo.db
        .prepare(
          `INSERT INTO attempts SELECT 'early', question_id, lesson_id, selected_json, dont_know, 'guess', note, correct, misconceptions_json, 'done', NULL, ?
             FROM attempts WHERE id = ?`,
        )
        .run(early, attemptId);
      v1(ctx).run("v1d", q.concept_id, D, null, "likely", 2, "sure", early, late, null);
    });
    expect(ctx.repo.db.prepare("SELECT COUNT(*) AS n FROM misconception_contributions WHERE source_kind = 'other'").get()).toEqual({ n: 0 });
    expect(await diagnose("R")).toBe(1);
    expect(ctx.repo.misconceptions(q.concept_id).find((m) => m.label === D)).toMatchObject({ status: "suspected", strongest_confidence: "guess", occurrences: 1, first_seen: early });
  });

  it("backfills lesson contributions from v1 attempts and reproduces every row; deferred reasoning retracts by attempt", async () => {
    // A real v1 lesson answer with pending reasoning, then the DB downgraded to its v1 shape.
    const { ctx, q, D, attemptId } = await deferredWrongAnswer();
    const v1Row = { ...ctx.repo.misconceptions(q.concept_id)[0] };
    const db = ctx.repo.db;
    db.exec("DELETE FROM misconception_contributions; DELETE FROM misconception_resolutions;");
    // Extra v1 rows: one with more occurrences than attempts, one resolved.
    const ins = db.prepare("INSERT INTO misconceptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("x2", q.concept_id, "repeat", "desc", "likely", 3, "sure", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z", null);
    ins.run("x3", q.concept_id, "old", "d3", "resolved", 2, null, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    db.exec("DROP TABLE misconception_contributions; DROP TABLE misconception_resolutions; PRAGMA user_version = 1");
    const before = ctx.repo.misconceptions().map((m) => ({ ...m }));
    // Re-run migration 2's ledger part (the rest of it is unrelated and already applied).
    db.exec(MIGRATIONS[1].slice(MIGRATIONS[1].indexOf("-- The misconception ledger")));
    MIGRATION_STEPS[2](db);
    db.pragma("user_version = 2");
    const own = ctx.repo.misconceptionContributions("lesson", attemptId);
    expect(own.map((c) => c.label)).toEqual([D]);
    for (const m of before) ctx.repo.rebuildMisconception(m.concept_id, m.label);
    expect(ctx.repo.misconceptions()).toEqual(before);
    expect(ctx.repo.misconceptions(q.concept_id).find((m) => m.label === D)).toEqual(v1Row);
    // Deferred diagnosis R after the upgrade replaces the attempt's D.
    (ctx.engine as any).evaluateReasoning = async () => ({ verdict: "flawed", summary: "x", issues: [], misconception: { label: "R", description: "r" } });
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    const after = rows(ctx, q.concept_id);
    expect(after[D]).toBeUndefined();
    expect(after.R).toEqual([1, "suspected"]);
  });
});

describe("a pending answer never keeps a resolution its own flawed reasoning contradicts", () => {
  it("a correct sure answer resolves M while its reasoning is pending; the deferred reasoning expresses M: M is active again", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    await ctx.engine.advance(lesson.id);
    const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
    const M = q.options.find((o) => o.misconception)!.misconception!;
    ctx.repo.recordMisconception(q.concept_id, M, "earlier", "unsure", { kind: "other", id: null }, "2000-01-01T00:00:00.000Z");
    ctx.mock.failNext({ task: "evaluate_reasoning", kind: "interrupt", afterChars: 5 });
    await ctx.engine.answer(lesson.id, q.id, { selected: q.correct, confidence: "sure", note: "because" });
    expect(ctx.repo.pendingReasoning()).toHaveLength(1);
    expect(ctx.repo.misconceptions(q.concept_id).find((m) => m.label === M)!.status).toBe("resolved");
    (ctx.engine as any).evaluateReasoning = async () => ({ verdict: "flawed", summary: "x", issues: [], misconception: { label: M, description: "from reasoning" } });
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    expect(ctx.repo.misconceptions(q.concept_id).find((m) => m.label === M)).toMatchObject({ status: "likely", occurrences: 2, resolved_at: null });
  });

  it("only that attempt's resolutions are retracted: an older one by another source stands (strict-newer rule)", () => {
    const ctx = testContext();
    const c = ctx.repo.createConcept("bayes-rule", "Bayes rule", null, "x");
    ctx.repo.recordMisconception(c.id, "M", null, "unsure", { kind: "lesson", id: "l-1" }, "2026-01-01T00:00:00.000Z");
    ctx.repo.resolveMisconception(c.id, "M", "2026-01-02T00:00:00.000Z", "l-other");
    ctx.repo.resolveMisconception(c.id, "M", "2026-01-03T00:00:00.000Z", "l-2");
    ctx.repo.retractResolutionsBy("l-2");
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ status: "resolved", resolved_at: "2026-01-02T00:00:00.000Z" });
  });
});

describe("overrides restore a prior resolution", () => {
  it("M resolved, reopened by a practice mistake, then the mistake overridden: M is resolved again", () => {
    const ctx = testContext();
    const c = ctx.repo.createConcept("bayes-rule", "Bayes rule", null, "x");
    const store = new PracticeRepo(ctx.repo);
    ctx.repo.recordMisconception(c.id, "M", null, "unsure", { kind: "lesson", id: "l-1" }, "2026-01-01T00:00:00.000Z");
    ctx.repo.resolveMisconceptions(c.id, "2026-01-02T00:00:00.000Z");
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ status: "resolved", resolved_at: "2026-01-02T00:00:00.000Z" });
    store.recordAttemptMisconception("practice-1", c.id, "M", "p", "unsure", "2026-01-04T00:00:00.000Z");
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ status: "likely", resolved_at: null, occurrences: 2 });
    store.retractAttemptMisconceptions("practice-1");
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ status: "resolved", resolved_at: "2026-01-02T00:00:00.000Z", occurrences: 1 });
  });
});

describe("one attempt counts a misconception once", () => {
  it("duplicate labels from one source are one contribution; the unique index enforces it", () => {
    const ctx = testContext();
    const c = ctx.repo.createConcept("bayes-rule", "Bayes rule", null, "x");
    ctx.repo.recordMisconception(c.id, "M", null, "unsure", { kind: "lesson", id: "a-1" });
    ctx.repo.recordMisconception(c.id, "M", "richer", "unsure", { kind: "lesson", id: "a-1" });
    expect(ctx.repo.misconceptions(c.id)[0]).toMatchObject({ occurrences: 1, status: "suspected", description: "richer" });
    expect(() =>
      ctx.repo.db.prepare("INSERT INTO misconception_contributions (concept_id, label, source_kind, source_id, created_at) VALUES (?, 'M', 'lesson', 'a-1', 'x')").run(c.id),
    ).toThrow(/UNIQUE/);
    // Anonymous contributions are not constrained.
    ctx.repo.recordMisconception(c.id, "M", null, "unsure");
    ctx.repo.recordMisconception(c.id, "M", null, "unsure");
    expect(ctx.repo.misconceptions(c.id)[0].occurrences).toBe(3);
  });

  it("a multi-select answer with two distractors sharing a label records it once", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    await ctx.engine.advance(lesson.id);
    const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
    const wrong = q.options.filter((o) => !q.correct.includes(o.value)).slice(0, 2);
    expect(wrong).toHaveLength(2);
    const opts = q.options.map((o) => (wrong.includes(o) ? { ...o, misconception: "shared" } : o));
    ctx.repo.db.prepare("UPDATE questions SET options_json = ?, multi_select = 1 WHERE id = ?").run(JSON.stringify(opts), q.id);
    await ctx.engine.answer(lesson.id, q.id, { selected: wrong.map((o) => o.value), confidence: "unsure" });
    expect(ctx.repo.misconceptions(q.concept_id).find((m) => m.label === "shared")).toMatchObject({ occurrences: 1 });
  });
});

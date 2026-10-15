// Regression tests for code-review findings in deferred reasoning and the concept graph:
// concurrent deferred grading, homonyms merging across explicit senses, doubled misconceptions.
import { describe, expect, it } from "vitest";
import { conceptSlug, definitionsAgree, sameIdea, upsertConcepts } from "../src/server/graph/concepts.ts";
import { importFile } from "../src/server/ingest/import.ts";
import type { AnalysisConcept } from "../src/shared/schemas.ts";
import { MARKOV_LECTURE, makePdf, testContext } from "./helpers.ts";

const concept = (c: Partial<AnalysisConcept> & { name: string; definition: string }): AnalysisConcept => ({ role: "central", pages: [], prerequisites: [], ...c });

async function deferredWrongAnswer(confidence: "sure" | "unsure" = "sure") {
  const ctx = testContext();
  const course = ctx.repo.createCourse("C");
  const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
  const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
  await ctx.engine.advance(lesson.id);
  const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
  const distractor = q.options.find((o) => o.misconception)!;
  ctx.mock.failNext({ task: "evaluate_reasoning", kind: "interrupt", afterChars: 5 });
  await ctx.engine.answer(lesson.id, q.id, { selected: [distractor.value], confidence, note: "because it seemed right" });
  expect(ctx.repo.pendingReasoning()).toHaveLength(1);
  return { ctx, lessonId: lesson.id, q, M: distractor.misconception! };
}
const misconceptionsOf = (ctx: ReturnType<typeof testContext>, conceptId: string) =>
  Object.fromEntries(ctx.repo.activeMisconceptions(conceptId).map((m) => [m.label, m.occurrences]));

describe("concurrent deferred grading claims each pending attempt once", () => {
  it("two concurrent evaluations of the same pending attempt apply it once and keep the earlier history", async () => {
    const { ctx, q, M } = await deferredWrongAnswer();
    // M was seen once before on another attempt: two occurrences in all.
    ctx.repo.recordMisconception(q.concept_id, M, null, "unsure");
    expect(misconceptionsOf(ctx, q.concept_id)).toEqual({ [M]: 2 });
    // Both requests read the pending list before either claims it.
    const snapshot = ctx.repo.pendingReasoning();
    ctx.repo.pendingReasoning = () => snapshot;
    const flawed = { verdict: "flawed", summary: "Confused.", issues: [], misconception: { label: "R", description: "reasoning-level" } };
    (ctx.engine as any).evaluateReasoning = async () => flawed;
    const counts = await Promise.all([ctx.engine.processPendingReasoning(), ctx.engine.processPendingReasoning()]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
    // One occurrence of M (this attempt's) is replaced by R; the earlier occurrence survives.
    expect(misconceptionsOf(ctx, q.concept_id)).toEqual({ [M]: 1, R: 1 });
    expect(ctx.repo.db.prepare("SELECT reasoning_status FROM attempts WHERE id = ?").get(snapshot[0].id)).toEqual({ reasoning_status: "done" });
  });

  it("a claimed attempt is not re-applied once done, and a failed evaluation releases the claim", async () => {
    const { ctx } = await deferredWrongAnswer();
    const id = ctx.repo.pendingReasoning()[0].id;
    ctx.mock.failNext({ task: "evaluate_reasoning", kind: "interrupt", afterChars: 5 });
    expect(await ctx.engine.processPendingReasoning()).toBe(0);
    expect(ctx.repo.pendingReasoning().map((a) => a.id)).toEqual([id]);
    expect(ctx.repo.claimPendingReasoning(id)).toBe(true);
    expect(ctx.repo.claimPendingReasoning(id)).toBe(false);
    ctx.repo.releaseReasoningClaim(id);
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    expect(await ctx.engine.processPendingReasoning()).toBe(0);
  });
});

describe("deferred reasoning with the same label as the distractor counts the attempt once", () => {
  it("enriches the existing misconception instead of incrementing it", async () => {
    const { ctx, q, M } = await deferredWrongAnswer("unsure");
    const before = ctx.repo.activeMisconceptions(q.concept_id).find((m) => m.label === M)!;
    expect(before.occurrences).toBe(1);
    expect(before.status).toBe("suspected");
    ctx.mock.failNext({ task: "evaluate_reasoning", kind: "mutate", mutate: () => ({ verdict: "flawed", summary: "Same idea.", issues: [], misconception: { label: M, description: "richer description from the reasoning" } }) });
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    const after = ctx.repo.activeMisconceptions(q.concept_id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ label: M, occurrences: 1, status: "suspected", description: "richer description from the reasoning" });
  });
});

describe("homonyms with explicitly different senses never merge on vocabulary", () => {
  const algebra = concept({ name: "Kernel", sense: "linear algebra", definition: "The kernel of a linear map is the set of input vectors mapped to the zero vector; it is a subspace of the input space whose dimension is the nullity." });
  const ml = concept({ name: "Kernel", sense: "machine learning", definition: "A kernel is a function computing an inner product of input vectors mapped into a feature space, a space where linear methods become non-linear." });

  it("algebra vs ML kernel stay separate concepts even though definitions share stems", () => {
    expect(sameIdea("Kernel", algebra, ml)).toBe(false);
    const ctx = testContext();
    const a = upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [algebra], learningPath: ["Kernel"] })[0].conceptId;
    const b = upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [ml], learningPath: ["Kernel"] })[0].conceptId;
    expect(a).not.toBe(b);
    // The same sense again still reuses by exact slug.
    expect(upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [{ ...ml, definition: "different words" }], learningPath: ["Kernel"] })[0].conceptId).toBe(b);
  });

  it("a sense-less mention needs clear overlap to reuse a sensed concept", () => {
    const vague = { definition: "A kernel maps input vectors somewhere." };
    expect(sameIdea("Kernel", vague, ml)).toBe(false);
    const close = { definition: "A kernel computes the inner product of input vectors after mapping them into a feature space." };
    expect(sameIdea("Kernel", close, ml)).toBe(true);
  });
});

describe("unlabelled homonyms need definition agreement even on an exact slug hit", () => {
  const os = concept({ name: "Kernel", definition: "The kernel is the core program of an operating system that manages memory, processes and hardware access, running in privileged mode." });
  const ml = concept({ name: "Kernel", sense: "machine learning", definition: "A kernel is a function computing an inner product of input vectors mapped into a feature space, a space where linear methods become non-linear." });
  const img = concept({ name: "Kernel", definition: "A small matrix of weights convolved with an image to blur, sharpen or detect edges in pictures." });
  const up = (ctx: ReturnType<typeof testContext>, c: AnalysisConcept) => upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [c], learningPath: ["Kernel"] })[0].conceptId;

  it("OS, sensed ML, then unlabelled image kernel: three concepts, stable on re-analysis", () => {
    const ctx = testContext();
    const [a, b, c] = [up(ctx, os), up(ctx, ml), up(ctx, img)];
    expect(new Set([a, b, c]).size).toBe(3);
    const row = ctx.repo.getConcept(c)!;
    expect(row.slug).not.toBe(conceptSlug(img));
    expect(ctx.repo.findConceptBySlug(row.slug)!.id).toBe(c);
    // The same mentions later resolve to the same concepts, in any order.
    expect([up(ctx, img), up(ctx, os), up(ctx, ml)]).toEqual([c, a, b]);
    // The disambiguated slug is derived from the definition alone: same in a fresh database.
    const fresh = testContext();
    up(fresh, os);
    expect(fresh.repo.getConcept(up(fresh, img))!.slug).toBe(row.slug);
  });

  it("same name with identical definition text always reuses", () => {
    const ctx = testContext();
    const a = up(ctx, img);
    expect(up(ctx, { ...img })).toBe(a);
  });
});

describe("deferred reasoning replacement recomputes the replaced misconception", () => {
  it("removing a sure attempt's occurrence drops status and strongest confidence it alone caused", async () => {
    const { ctx, q, M } = await deferredWrongAnswer("sure");
    ctx.repo.recordMisconception(q.concept_id, M, "earlier description", "guess");
    const before = ctx.repo.activeMisconceptions(q.concept_id).find((m) => m.label === M)!;
    expect([before.occurrences, before.status, before.strongest_confidence]).toEqual([2, "likely", "sure"]);
    (ctx.engine as any).evaluateReasoning = async () => ({ verdict: "flawed", summary: "x", issues: [], misconception: { label: "R", description: "reasoning-level" } });
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    const after = ctx.repo.activeMisconceptions(q.concept_id).find((m) => m.label === M)!;
    expect([after.occurrences, after.status, after.description]).toEqual([1, "suspected", "earlier description"]);
    expect(after.strongest_confidence).not.toBe("sure");
  });
});

describe("short unlabelled definitions need positive agreement to merge (review P1)", () => {
  it("two one-line glosses of 'Kernel' from different fields stay separate", () => {
    const ctx = testContext();
    const os = concept({ name: "Kernel", definition: "The operating system core." });
    const ml = concept({ name: "Kernel", definition: "A convolution matrix." });
    expect(definitionsAgree("Kernel", os, ml)).toBe(false);
    const up = (c: AnalysisConcept) => upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [c], learningPath: ["Kernel"] })[0].conceptId;
    const a = up(os);
    const b = up(ml);
    expect(b).not.toBe(a);
    expect(ctx.repo.getConcept(b)!.slug).not.toBe("kernel");
    // Identical text, or a short gloss sharing most of its words, still reuses the record.
    expect(up({ ...os, definition: "the operating  system core" })).toBe(a);
    expect(up({ ...ml, definition: "A small convolution matrix." })).toBe(b);
  });

  it("short glosses sharing most content words agree; disjoint or empty ones do not", () => {
    const d = (definition: string) => ({ definition });
    expect(definitionsAgree("Kernel", d("Core of the operating system."), d("The operating system's core program."))).toBe(true);
    expect(definitionsAgree("Kernel", d("Kernel."), d("A kernel."))).toBe(false);
    expect(definitionsAgree("Kernel", d("Core of the operating system."), d("Matrix used in image convolution."))).toBe(false);
  });
});

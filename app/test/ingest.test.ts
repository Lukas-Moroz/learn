import JSZip from "jszip";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateRefs } from "../src/server/alignment/refs.ts";
import { extractionStats, extractPptx } from "../src/server/ingest/extract.ts";
import { importFile, importFolder, orderLectureFiles } from "../src/server/ingest/import.ts";
import { MARKOV_LECTURE, makePdf, testContext, tmpDir } from "./helpers.ts";

describe("PDF ingestion", () => {
  it("extracts text per page", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("Probabilistic Models");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 04 - Markov.pdf" });
    expect(r.status).toBe("new");
    expect(r.source.page_count).toBe(12);
    expect(ctx.repo.getPage(r.source.id, 9)).toMatch(/Second-order Markov models/);
    expect(r.lecture.title).toBe("Lecture 04 - Markov");
  });

  it("SCENARIO 7: importing the same PDF twice does not repeat extraction or analysis", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const pdf = await makePdf(MARKOV_LECTURE);
    const before = extractionStats.pdf;
    const a = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: pdf, filename: "lecture4.pdf" });
    const analyzed = await ctx.engine.analyzeLecture(a.lecture.id);
    const callsAfterFirst = ctx.mock.calls.filter((c) => c.task === "analyze_source").length;

    const b = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: pdf, filename: "lecture4.pdf" });
    await ctx.engine.analyzeLecture(b.lecture.id);
    expect(b.status).toBe("unchanged");
    expect(b.source.id).toBe(a.source.id);
    expect(b.lecture.id).toBe(a.lecture.id);
    expect(extractionStats.pdf - before).toBe(1);
    expect(ctx.mock.calls.filter((c) => c.task === "analyze_source").length).toBe(callsAfterFirst);
    expect(analyzed.planned.length).toBeGreaterThan(3);

    // Same bytes under another name in another course: extraction reused, not repeated.
    const other = ctx.repo.createCourse("Other");
    const c = await importFile(ctx.repo, ctx.dataDir, { courseId: other.id, data: pdf, filename: "copy.pdf" });
    expect(c.status).toBe("reused-extraction");
    expect(extractionStats.pdf - before).toBe(1);
  });

  it("an updated file becomes a new version of the same document; history is kept", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const v1 = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "lecture4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(v1.lecture.id);
    await ctx.engine.advance(lesson.id);
    const changed = [...MARKOV_LECTURE, ["Appendix", "Smoothing for unseen triples."]];
    const v2 = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(changed), filename: "lecture4.pdf" });
    expect(v2.status).toBe("updated");
    expect(v2.source.version).toBe(2);
    expect(v2.document.id).toBe(v1.document.id);
    expect(v2.lecture.id).toBe(v1.lecture.id);
    expect(ctx.repo.getSource(v1.source.id)!.superseded_by).toBe(v2.source.id);
    // The existing lesson and its blocks still point at version 1 and are untouched.
    expect(ctx.repo.getLesson(lesson.id)!.source_id).toBe(v1.source.id);
    expect(ctx.repo.listBlocks(lesson.id).length).toBeGreaterThan(0);
  });

  it("orders lecture files naturally and imports a folder in that order", async () => {
    expect(orderLectureFiles(["Lecture 10 - RNNs.pdf", "Lecture 2 - Probability.pdf", "Lecture 1 - Intro.pdf", "L03_markov.pdf"])).toEqual([
      "Lecture 1 - Intro.pdf",
      "Lecture 2 - Probability.pdf",
      "L03_markov.pdf",
      "Lecture 10 - RNNs.pdf",
    ]);
    expect(orderLectureFiles(["week2-b.pdf", "week1-a.pdf", "week1-c.pdf"])).toEqual(["week1-a.pdf", "week1-c.pdf", "week2-b.pdf"]);

    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const dir = join(tmpDir(), "course");
    mkdirSync(dir);
    for (const [name, title] of [["Lecture 10.pdf", "Ten"], ["Lecture 2.pdf", "Two"], ["Lecture 1.pdf", "One"]]) {
      writeFileSync(join(dir, name), await makePdf([[title], ["Body of lecture " + title]]));
    }
    await importFolder(ctx.repo, ctx.dataDir, course.id, dir);
    expect(ctx.repo.listLectures(course.id).map((l) => l.title)).toEqual(["Lecture 1", "Lecture 2", "Lecture 10"]);
    // Manual correction persists.
    const ids = ctx.repo.listLectures(course.id).map((l) => l.id);
    ctx.repo.reorderLectures(course.id, [ids[1], ids[0], ids[2]]);
    await importFolder(ctx.repo, ctx.dataDir, course.id, dir);
    expect(ctx.repo.listLectures(course.id).map((l) => l.title)).toEqual(["Lecture 2", "Lecture 1", "Lecture 10"]);
  });

  it("extracts PPTX slide text and speaker notes in slide order", async () => {
    const zip = new JSZip();
    const slide = (t: string[]) => `<p:sld><p:txBody>${t.map((x) => `<a:p><a:r><a:t>${x}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sld>`;
    zip.file("ppt/slides/slide2.xml", slide(["Second slide", "P(A &amp; B)"]));
    zip.file("ppt/slides/slide10.xml", slide(["Tenth slide"]));
    zip.file("ppt/slides/slide1.xml", slide(["Title slide"]));
    zip.file("ppt/notesSlides/notesSlide2.xml", slide(["Remember the denominator"]));
    const pages = await extractPptx(await zip.generateAsync({ type: "uint8array" }));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toBe("Title slide");
    expect(pages[1]).toMatch(/Second slide\nP\(A & B\)\n\nSpeaker notes:\nRemember the denominator/);
    expect(pages[2]).toBe("Tenth slide");
  });
});

describe("source alignment", () => {
  it("drops refs to missing pages and quotes that are not on the cited page", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "l4.pdf" });
    const { refs, dropped } = validateRefs(
      ctx.repo,
      r.source.id,
      [
        { page: 9, quote: "Two symbols of memory." },
        { page: 3, quote: "This sentence is not in the lecture at all." },
        { page: 40 },
        { page: 8, pageEnd: 99 },
      ],
      "Lecture 4",
    );
    expect(dropped).toBe(1);
    expect(refs.map((x) => x.page)).toEqual([9, 3, 8]);
    expect(refs[0].quote).toBe("Two symbols of memory.");
    expect(refs[1].quote).toBeUndefined();
    expect(refs[2].pageEnd).toBeUndefined();
    expect(refs[0].label).toBe("Lecture 4, page 9");
  });
});

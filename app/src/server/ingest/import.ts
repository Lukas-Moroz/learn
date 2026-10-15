// Content-addressed import. A document (stable identity: file key or Drive id) has
// immutable source versions identified by SHA-256. Re-importing an unchanged file is
// a no-op; a changed file becomes a new version and keeps all existing history.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DocumentRow, LectureRow, Repo, SourceRow } from "../db/repo.ts";
import { extractPdf, extractPptx } from "./extract.ts";

export type ImportStatus = "new" | "unchanged" | "updated" | "reused-extraction";

export interface ImportResult {
  document: DocumentRow;
  source: SourceRow;
  lecture: LectureRow;
  status: ImportStatus;
}

export const SUPPORTED = new Set([".pdf", ".pptx"]);

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// 2026-09-03, 20260903, 09-03-2026, 09032026 (US order).
const DATE = /(?<!\d)(?:(20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?([0-3]\d)|(0[1-9]|1[0-2])[-_.]?([0-3]\d)[-_.]?(20\d\d))(?!\d)/;

/**
 * Filename without extension or underscores. A numbered lecture is tidied:
 * "ICS691G_Lec10_09292026_Annotated" → "Lecture 10", "… Lecture 5 09082026 Part 1 Annotated" →
 * "Lecture 5 Part 1". The source keeps the original filename.
 */
export function titleFromFilename(filename: string): string {
  const name = basename(filename, extname(filename)).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  const lec = /(?<![a-z])lec(?:t|ture)?\s*(?=\d)/i.exec(name);
  if (!lec) return name;
  const prefix = name.slice(0, lec.index);
  const tidy = (/^(?:[A-Z0-9]{2,8} )*$/.test(prefix) ? "" : prefix) + "Lecture " + name.slice(lec.index + lec[0].length);
  return (
    tidy
      .replace(new RegExp(DATE.source, "g"), "")
      .replace(/(?<![a-z])annotated(?![a-z])/gi, "")
      .replace(/\(\s*\)|\[\s*\]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[\s,–—-]+$/, "")
      .trim() || name
  );
}

export async function importFile(
  repo: Repo,
  dataDir: string,
  opts: { courseId: string; data: Uint8Array; filename: string; key?: string; title?: string },
): Promise<ImportResult> {
  const ext = extname(opts.filename).toLowerCase();
  if (!SUPPORTED.has(ext)) throw new Error(`Unsupported file type ${ext || "(none)"}. Import PDF or PPTX files.`);
  const hash = sha256(opts.data);
  const key = opts.key ?? `file:${basename(opts.filename).toLowerCase()}`;
  const title = opts.title ?? titleFromFilename(opts.filename);

  const document = repo.findDocument(opts.courseId, key) ?? repo.createDocument(opts.courseId, key, title, ext.slice(1));
  const lectureFor = () => repo.findLectureByDocument(document.id) ?? repo.createLecture(opts.courseId, title, document.id);

  const same = repo.findSourceInDocument(document.id, hash);
  if (same) return { document, source: same, lecture: lectureFor(), status: "unchanged" };

  // Identical bytes imported elsewhere (another course, another filename): reuse the extraction.
  const twin = repo.findSourceBySha(hash);
  const pages = twin ? repo.getPages(twin.id) : ext === ".pdf" ? await extractPdf(opts.data) : await extractPptx(opts.data);
  if (pages.length === 0) throw new Error("No pages could be read from this file.");

  const dir = join(dataDir, "sources");
  mkdirSync(dir, { recursive: true });
  const storedPath = join(dir, `${hash}${ext}`);
  if (!existsSync(storedPath)) writeFileSync(storedPath, opts.data);

  const previous = repo.latestSource(document.id);
  const source = repo.tx(() => {
    const s = repo.createSource({
      document_id: document.id,
      sha256: hash,
      kind: ext.slice(1),
      filename: basename(opts.filename),
      stored_path: storedPath,
      page_count: pages.length,
      unit: ext === ".pptx" ? "slide" : "page",
      version: (previous?.version ?? 0) + 1,
    });
    repo.setPages(s.id, pages);
    if (previous) repo.supersede(previous.id, s.id);
    return s;
  });
  return { document, source, lecture: lectureFor(), status: previous ? "updated" : twin ? "reused-extraction" : "new" };
}

// ── Lecture folders ─────────────────────────────────────────────────────────

/**
 * Natural lecture order from filenames: "Lecture 2" < "Lecture 10", "L03" < "L4",
 * "week1-…" < "week2-…", "Lecture 5 … Part 1" < "Lecture 5 … Part 2". Falls back to
 * dates in names, then natural name order ("Exam1 …" < "Exam 2 …").
 */
export function lectureSortKey(filename: string): (number | string)[] {
  const name = basename(filename, extname(filename)).toLowerCase();
  // Not inside a word ("Fall2026" is no "l2026"); a sub-number is short (an 8-digit date is not one).
  const lect = /(?<![a-z])(?:lecture|lec|lect|l|week|wk|w|session|class|chapter|ch|unit|part|topic)[\s_-]*0*(\d+)(?:[._-](\d{1,3})(?!\d))?/.exec(name);
  const part = lect && /(?<![a-z])part[\s_-]*0*(\d+)/.exec(name.slice(lect.index + lect[0].length));
  const date = DATE.exec(name);
  const lead = /^0*(\d+)/.exec(name);
  const primary = lect
    ? Number(lect[1])
    : date
      ? Number(date[1] ? date[1] + date[2] + date[3] : date[6] + date[4] + date[5])
      : lead
        ? Number(lead[1])
        : Number.MAX_SAFE_INTEGER;
  const natural = name
    .replace(/[\s_.-]+/g, " ")
    .replace(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/g, " ")
    .replace(/\d+/g, (d) => d.padStart(12, "0"));
  return [primary, lect?.[2] ? Number(lect[2]) : 0, part ? Number(part[1]) : 0, natural];
}

export function orderLectureFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const ka = lectureSortKey(a);
    const kb = lectureSortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

/** Import every PDF/PPTX in a local folder, in natural lecture order. */
export async function importFolder(repo: Repo, dataDir: string, courseId: string, folder: string): Promise<ImportResult[]> {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const files = orderLectureFiles(readdirSync(folder).filter((f) => SUPPORTED.has(extname(f).toLowerCase()) && !f.startsWith(".")));
  const results: ImportResult[] = [];
  for (const f of files) {
    const path = join(folder, f);
    results.push(await importFile(repo, dataDir, { courseId, data: readFileSync(path), filename: f, key: `file:${path.toLowerCase()}` }));
  }
  // Apply natural order to newly created lectures, keeping any manual order of existing ones.
  const lectures = repo.listLectures(courseId);
  const fresh = results.filter((r) => r.status !== "unchanged").map((r) => r.lecture.id);
  if (fresh.length) {
    const kept = lectures.filter((l) => !fresh.includes(l.id)).map((l) => l.id);
    repo.reorderLectures(courseId, [...kept, ...results.map((r) => r.lecture.id).filter((id) => fresh.includes(id))]);
  }
  return results;
}

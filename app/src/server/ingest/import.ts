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

export function titleFromFilename(filename: string): string {
  return basename(filename, extname(filename)).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
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
 * "week1-…" < "week2-…". Falls back to dates in names, then alphabetical.
 */
export function lectureSortKey(filename: string): (number | string)[] {
  const name = basename(filename, extname(filename)).toLowerCase();
  const date = /(20\d\d)[-_.](\d\d)[-_.](\d\d)/.exec(name);
  const lect = /(?:lecture|lec|lect|l|week|wk|w|session|class|chapter|ch|unit|part|topic)[\s_-]*0*(\d+)(?:[._-](\d+))?/.exec(name);
  const lead = /^0*(\d+)/.exec(name);
  const primary = lect ? Number(lect[1]) : lead ? Number(lead[1]) : date ? Number(date[1] + date[2] + date[3]) : Number.MAX_SAFE_INTEGER;
  const secondary = lect?.[2] ? Number(lect[2]) : 0;
  return [primary, secondary, name];
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

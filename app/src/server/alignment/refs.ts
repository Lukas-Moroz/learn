// Source alignment: model-written citations are checked against the stored page
// text before they are shown. Refs to pages that don't exist are dropped; quotes
// that don't appear on the cited page are removed. A page number alone proves
// nothing about where content came from, so content is labelled "source" only
// when a quote was found on its page; otherwise it is supplementary, and any
// page-only refs are kept as pointers to related pages.
import type { Repo } from "../db/repo.ts";
import type { Provenance, SourceRef } from "../../shared/schemas.ts";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export function refLabel(lectureTitle: string | null, unit: "page" | "slide", page: number, pageEnd?: number): string {
  const where = pageEnd && pageEnd > page ? `${unit}s ${page}–${pageEnd}` : `${unit} ${page}`;
  return lectureTitle ? `${lectureTitle}, ${where}` : where[0].toUpperCase() + where.slice(1);
}

export function validateRefs(
  repo: Repo,
  sourceId: string | null,
  refs: { page: number; pageEnd?: number; quote?: string }[],
  lectureTitle: string | null,
): { refs: SourceRef[]; dropped: number } {
  if (!sourceId) return { refs: [], dropped: refs.length };
  const source = repo.getSource(sourceId);
  if (!source) return { refs: [], dropped: refs.length };
  const out: SourceRef[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const r of refs) {
    if (!Number.isInteger(r.page) || r.page < 1 || r.page > source.page_count) {
      dropped++;
      continue;
    }
    const pageEnd = r.pageEnd && r.pageEnd > r.page && r.pageEnd <= source.page_count ? r.pageEnd : undefined;
    let quote: string | undefined;
    if (r.quote?.trim()) {
      const needle = norm(r.quote);
      const hay: string[] = [];
      for (let p = r.page; p <= (pageEnd ?? r.page); p++) hay.push(norm(repo.getPage(sourceId, p) ?? ""));
      if (needle.length >= 8 && hay.some((h) => h.includes(needle))) quote = r.quote.trim();
    }
    const key = `${r.page}-${pageEnd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      sourceId,
      page: r.page,
      ...(pageEnd ? { pageEnd } : {}),
      ...(quote ? { quote } : {}),
      verified: true,
      label: refLabel(lectureTitle, source.unit, r.page, pageEnd),
    });
  }
  return { refs: out, dropped };
}

/**
 * "source" needs at least one ref whose quote was found on its page (validateRefs keeps only such
 * quotes). `verified` alone means the page exists, which doesn't show the content came from it.
 */
export function provenanceFor(refs: SourceRef[]): Provenance {
  return refs.some((r) => r.verified && Boolean(r.quote)) ? "source" : "supplementary";
}

/** The first contiguous run of pages: [8,9,10,12] → 8–10. Never implies pages that weren't cited. */
export function pageSpan(pages: number[]): { page: number; pageEnd?: number } | null {
  if (pages.length === 0) return null;
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  let end = sorted[0];
  for (const p of sorted.slice(1)) {
    if (p !== end + 1) break;
    end = p;
  }
  return end > sorted[0] ? { page: sorted[0], pageEnd: end } : { page: sorted[0] };
}

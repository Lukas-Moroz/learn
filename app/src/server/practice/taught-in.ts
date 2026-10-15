// "Taught in": a deterministic keyword search over the course's lecture pages that
// finds where a practice problem's ideas are taught. No AI: pages are ranked by how
// often (and how distinctively) the problem's keywords and concept names occur, with
// pages that only mention a topic in passing (title, outline, summary and review slides,
// repeats and annotation builds) discounted, and consecutive pages grouped into spans.
import { validateRefs } from "../alignment/refs.ts";
import type { Repo } from "../db/repo.ts";
import type { SourceRef } from "../../shared/schemas.ts";

export interface IndexedPage {
  sourceId: string;
  lectureTitle: string;
  page: number;
  /** Lowercase words separated by single spaces, padded: " suffix array ". */
  words: string;
  /** Letters and digits only: tolerant of broken ligatures and odd spacing. */
  compact: string;
  heading: string;
  /** Multiplier below 1 for pages that rarely teach: title, overview/summary, repeats, partial builds. */
  prior: number;
  /** Title, overview, summary or a repeat from elsewhere: mentions topics in passing; never a span's edge. */
  passing: boolean;
}

export interface LectureIndex {
  /** Changes whenever the set of lecture sources changes (new lecture, new version). */
  sig: string;
  pages: IndexedPage[];
}

const words = (s: string) => ` ${s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Lecture sources (role "lecture", latest version) of a course, in lecture order. */
function lectureSources(repo: Repo, courseId: string) {
  return repo
    .listLectures(courseId)
    .map((l) => ({ lecture: l, source: l.document_id ? repo.latestSource(l.document_id) : undefined }))
    .filter((x): x is { lecture: typeof x.lecture; source: NonNullable<typeof x.source> } => Boolean(x.source));
}

export function lectureSignature(repo: Repo, courseId: string): string {
  return lectureSources(repo, courseId)
    .map((x) => `${x.source.id}:${x.lecture.title}`)
    .join("|");
}

// Slide headings of pages that list or recap topics rather than teach them.
const OVERVIEW = /^ (outline|agenda|today|overview|topics|summary|recap|review|roadmap|contents|table of contents|what we did|what we covered|what s next|whats next|learning objectives|learning goals|announcements|plan for today|coming up|next time|next lecture)\b/;
const DISCOUNT = 0.3;
/** A slide whose title names the topic is about it. */
const HEADING_BOOST = 2.5;

function sharedWords(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared;
}

export function buildLectureIndex(repo: Repo, courseId: string): LectureIndex {
  const sources = lectureSources(repo, courseId);
  const pages: IndexedPage[] = [];
  const earlier = new Map<string, string[]>(); // earlier page texts (lecture order), by their first 60 characters
  for (const { lecture, source } of sources) {
    const texts = repo.getPages(source.id);
    // Lines repeated on many pages (copyright notices, course banners) are not content.
    const seen = new Map<string, number>();
    for (const t of texts) for (const l of new Set(t.split("\n").map((x) => x.trim()).filter(Boolean))) seen.set(l, (seen.get(l) ?? 0) + 1);
    const boilerplate = (l: string) => (seen.get(l) ?? 0) >= Math.max(3, texts.length * 0.3);
    let previous = { text: "", vocabulary: new Set<string>() };
    texts.forEach((text, i) => {
      const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !boilerplate(l));
      const body = lines.join("\n");
      const c = compact(body);
      const heading = words(lines[0] ?? "");
      const vocabulary = new Set(words(body).trim().split(" ").filter(Boolean));
      let prior = 1;
      let passing = false;
      if (i === 0 || OVERVIEW.test(heading)) [prior, passing] = [DISCOUNT, true]; // title page; outline, summary, review
      // A repeat of an earlier page or lecture (a review slide) is where the idea was taught
      // before. Of a build (a slide revealed step by step), the complete last step counts.
      const key = c.length >= 40 ? c.slice(0, 60) : null;
      const shared = sharedWords(vocabulary, previous.vocabulary);
      const build = vocabulary.size >= 5 && previous.vocabulary.size >= 5;
      if (key && earlier.get(key)?.some((e) => e !== previous.text && c.startsWith(e))) [prior, passing] = [prior * DISCOUNT, true];
      else if (build && shared >= 0.9 * previous.vocabulary.size && vocabulary.size > previous.vocabulary.size) pages[pages.length - 1].prior *= DISCOUNT;
      else if (build && shared >= 0.9 * vocabulary.size) prior *= DISCOUNT;
      if (key) earlier.set(key, [...(earlier.get(key) ?? []), c]);
      previous = { text: c, vocabulary };
      pages.push({ sourceId: source.id, lectureTitle: lecture.title, page: i + 1, words: words(body), compact: c, heading, prior, passing });
    });
  }
  return { sig: sources.map((x) => `${x.source.id}:${x.lecture.title}`).join("|"), pages };
}

/** Pages without a match that may sit inside one span (image-only slides). */
const MAX_GAP = 3;

// Ligatures that PDF extraction often drops ("Suffix" → "Suf x"): also match without them.
const LIGATURES = ["ffi", "ffl", "fi", "fl", "ff"];

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** How often a term occurs on a page: as whole words, or (for longer terms) ligature-tolerantly. */
function termCount(page: IndexedPage, term: { words: string; variants: string[] }): number {
  const exact = occurrences(page.words, term.words);
  const loose = term.variants.length ? Math.max(...term.variants.map((v) => occurrences(page.compact, v))) : 0;
  return Math.max(exact, loose);
}

function prepareTerm(raw: string) {
  const w = words(raw);
  const c = compact(raw);
  if (c.length < 3) return null;
  // Compact matching ignores word boundaries, so it is only safe for longer terms.
  const variants = c.length >= 6 ? [...new Set([c, ...LIGATURES.filter((l) => c.includes(l)).map((l) => c.split(l).join(""))])] : [];
  return { words: w, variants, weight: 1 + 0.5 * (w.trim().split(" ").length - 1) };
}

export interface TaughtInQuery {
  /** The problem's keywords. */
  keywords: string[];
  /** Its concept names: the core of what is taught, weighted double. */
  concepts?: string[];
  /** Topics of the set's other problems: a page that also names them is an overview, not the place this is taught. */
  contrast?: string[];
}

type Term = NonNullable<ReturnType<typeof prepareTerm>>;

function prepareTerms(raw: string[], factor: number, skip: Set<string>): Term[] {
  const out: Term[] = [];
  for (const r of raw) {
    const t = prepareTerm(r);
    if (!t || skip.has(t.words)) continue;
    skip.add(t.words);
    out.push({ ...t, weight: t.weight * factor });
  }
  return out;
}

/** Relevance of every matching page to a problem, best first. */
export function scorePages(index: LectureIndex, query: TaughtInQuery): { p: IndexedPage; score: number; others: number }[] {
  const seen = new Set<string>();
  const terms = [...prepareTerms(query.concepts ?? [], 2, seen), ...prepareTerms(query.keywords, 1, seen)];
  const contrast = prepareTerms(query.contrast ?? [], 1, seen); // own terms are never contrast
  if (!terms.length || !index.pages.length) return [];

  const counts = index.pages.map((p) => terms.map((t) => termCount(p, t)));
  const n = index.pages.length;
  const idf = terms.map((_, ti) => Math.log(1 + n / (1 + counts.filter((c) => c[ti] > 0).length)));
  return index.pages
    .map((p, pi) => {
      let score = 0;
      terms.forEach((t, ti) => {
        const c = counts[pi][ti];
        if (!c) return;
        const inHeading = termCount({ ...p, words: p.heading, compact: compact(p.heading) }, t) > 0;
        score += t.weight * idf[ti] * (1 + Math.log(c)) * (inHeading ? HEADING_BOOST : 1);
      });
      const others = score > 0 ? contrast.filter((t) => termCount(p, t) > 0).length : 0;
      return { p, score: (score * p.prior) / (1 + 0.5 * others), others };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Rank lecture pages for a problem; group nearby pages into spans; return the top spans as refs. */
export function rankTaughtIn(repo: Repo, index: LectureIndex, query: TaughtInQuery, limit = 4): SourceRef[] {
  const scored = scorePages(index, query);
  if (!scored.length) return [];

  // Pages reasonably close to the best one form spans: slides teaching one idea run over
  // several pages, often with image-only pages between them, so short gaps don't break a
  // span. A span scores its total relevance, so a dedicated section outranks a summary slide.
  const relevant = scored.filter((x) => x.score >= scored[0].score * 0.2);
  const bySource = new Map<string, typeof relevant>();
  for (const x of relevant) bySource.set(x.p.sourceId, [...(bySource.get(x.p.sourceId) ?? []), x]);
  const spans: { sourceId: string; title: string; page: number; pageEnd: number; score: number }[] = [];
  for (const [sourceId, xs] of bySource) {
    const sorted = [...xs].sort((a, b) => a.p.page - b.p.page);
    let run = [sorted[0]];
    const flush = () => {
      // A title, outline, summary or comparison page next to a section doesn't widen it.
      const edge = (r: (typeof run)[number]) => !r.p.passing && r.others < 2;
      let [a, b] = [0, run.length - 1];
      if (run.some(edge)) {
        while (!edge(run[a])) a++;
        while (!edge(run[b])) b--;
      }
      const core = run.slice(a, b + 1);
      spans.push({ sourceId, title: core[0].p.lectureTitle, page: core[0].p.page, pageEnd: core[core.length - 1].p.page, score: core.reduce((n, r) => n + r.score, 0) });
    };
    for (const x of sorted.slice(1)) {
      if (x.p.page - run[run.length - 1].p.page <= MAX_GAP + 1) run.push(x);
      else {
        flush();
        run = [x];
      }
    }
    flush();
  }
  return spans
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .flatMap((s) => validateRefs(repo, s.sourceId, [{ page: s.page, ...(s.pageEnd > s.page ? { pageEnd: s.pageEnd } : {}) }], s.title).refs);
}

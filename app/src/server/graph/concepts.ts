// Shared cross-course concept graph. Identically named concepts are merged only
// when they mean the same thing: an analysis can set `sense` to split a homonym
// ("kernel (operating systems)" vs "kernel (machine learning)"). A shared concept
// keeps one foundational definition; each course stores its own interpretation.
import type { ConceptRow, Repo } from "../db/repo.ts";
import type { AnalysisConcept, ConceptRole } from "../../shared/schemas.ts";
import { tokens } from "../../shared/similarity.ts";
import { slugify } from "../../shared/slug.ts";

export function conceptSlug(c: { name: string; sense?: string | null }): string {
  return slugify(c.sense ? `${c.name} ${c.sense}` : c.name);
}

// Words that say nothing about which field a definition belongs to (compared as 5-letter stems).
const GENERIC = new Set(["defin", "refer", "denot", "descr", "conce", "term", "gener", "speci", "parti", "examp", "usual", "often", "given", "where", "while", "other", "using", "used", "such", "each", "also", "more", "less", "betwe", "throu", "withi", "witho"]);

/** Content-word stems (first five letters) of a text, minus the concept's own name. */
function fieldWords(text: string, name: string): Set<string> {
  const stem = (t: string) => t.slice(0, 5);
  const own = new Set(tokens(name).map(stem));
  return new Set(tokens(text).filter((t) => t.length > 2 && !/^\d+$/.test(t)).map(stem).filter((t) => !own.has(t) && !GENERIC.has(t)));
}

/** Vocabulary overlap of two definitions (+ senses) of a same-named concept: shared stems and overlap coefficient. */
export function definitionOverlap(name: string, a: { sense?: string | null; definition: string }, b: { sense?: string | null; definition: string }) {
  const A = fieldWords(`${a.sense ?? ""} ${a.definition}`, name);
  const B = fieldWords(`${b.sense ?? ""} ${b.definition}`, name);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return { shared, coef: shared / Math.max(1, Math.min(A.size, B.size)) };
}

/**
 * Same name, different (or missing) sense: is it the same idea? Two different non-null senses
 * never merge. When only one side has a sense, a sense that merely describes the idea
 * ("probability (likelihood of an event)") shares vocabulary with the other definition; true
 * homonyms from different fields ("kernel": OS vs ML) share almost none, so they stay separate.
 */
export function sameIdea(name: string, a: { sense?: string | null; definition: string }, b: { sense?: string | null; definition: string }): boolean {
  const sa = (a.sense ?? "").trim().toLowerCase();
  const sb = (b.sense ?? "").trim().toLowerCase();
  if (sa === sb) return true;
  // Two explicit, different senses are a deliberate split (algebra "kernel" vs ML "kernel"):
  // shared definitional vocabulary never overrides it; only an exact slug match reuses.
  if (sa && sb) return false;
  // One side has no sense: reuse only on clear overlap (the 8 live-run duplicates share >= 3 stems, coef >= 0.27).
  const o = definitionOverlap(name, a, b);
  return o.shared >= 3 && o.coef >= 0.25;
}

const normDef = (d: string) => d.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Do a stored concept and a new mention of the same name mean the same thing? Identical
 * definitions always do. With no sense on either side the definitions must overlap as clearly
 * as sameIdea demands of a one-sided sense; a definition too short to tell fields apart
 * must share most of its content words, or the mention is treated as a separate concept.
 */
export function definitionsAgree(name: string, row: { sense?: string | null; definition: string }, c: { sense?: string | null; definition: string }): boolean {
  if (normDef(row.definition) === normDef(c.definition)) return (row.sense ?? "").trim().toLowerCase() === (c.sense ?? "").trim().toLowerCase() || sameIdea(name, row, c);
  if (row.sense || c.sense) return sameIdea(name, row, c);
  const o = definitionOverlap(name, row, c);
  // A short definition (a one-line slide gloss) carries little evidence. Lacking evidence is
  // ambiguity, not agreement ("The operating system core." vs "A convolution matrix."), so a
  // short pair merges only on positive agreement: most of the smaller vocabulary is shared.
  const small = Math.min(fieldWords(row.definition, name).size, fieldWords(c.definition, name).size);
  if (small < 5) return small > 0 && o.shared >= Math.min(3, small) && o.coef >= 0.5;
  return o.shared >= 3 && o.coef >= 0.25;
}

/**
 * Slug for an unlabelled homonym: the name plus its two most distinctive definition stems (not
 * in the clashing concept's definition), in order of first appearance, so the same definition
 * always yields the same slug. A still-taken slug gets a numeric suffix.
 */
export function disambiguatedSlug(repo: Repo, c: { name: string; definition: string }, clash: { definition: string }): string {
  const theirs = fieldWords(clash.definition, c.name);
  const mine = [...fieldWords(c.definition, c.name)].filter((w) => !theirs.has(w));
  const base = slugify(`${c.name} ${mine.slice(0, 2).join(" ") || "alt"}`);
  let slug = base;
  for (let i = 2; repo.findConceptBySlug(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export interface PlannedConcept {
  conceptId: string;
  name: string;
  role: ConceptRole;
  pages: number[];
}

/**
 * Upsert analysed concepts into the graph and link them to a lecture (if any).
 * Returns the learning path as concept ids in teaching order.
 */
export function upsertConcepts(
  repo: Repo,
  opts: { courseId: string | null; lectureId: string | null; concepts: AnalysisConcept[]; learningPath: string[] },
): PlannedConcept[] {
  return repo.tx(() => {
    // Existing concepts by name alone (ignoring sense), so a sense can't silently split the graph.
    const sameName = new Map<string, ConceptRow[]>();
    for (const row of repo.listConcepts()) sameName.set(slugify(row.name), [...(sameName.get(slugify(row.name)) ?? []), row]);
    const byName = new Map<string, { id: string; c: AnalysisConcept }>();
    for (const c of opts.concepts) {
      let slug = conceptSlug(c);
      // A sensed mention reuses its exact slug. Otherwise every same-named candidate (the exact
      // slug hit included) must agree on what it means (see definitionsAgree): a bare exact
      // slug hit is no proof, since two unlabelled homonyms share one slug.
      const exact = repo.findConceptBySlug(slug);
      const named = sameName.get(slugify(c.name)) ?? [];
      const existing =
        exact && c.sense
          ? exact
          : named
              .filter((row) => definitionsAgree(c.name, row, c))
              .sort((x, y) => definitionOverlap(c.name, y, c).coef - definitionOverlap(c.name, x, c).coef)[0];
      // An unlabelled homonym of an existing concept gets its own stable slug (see disambiguatedSlug).
      if (!existing && exact) slug = disambiguatedSlug(repo, c, exact);
      const row = existing ?? repo.createConcept(slug, c.name, c.sense ?? null, c.definition);
      if (!existing) sameName.set(slugify(c.name), [...(sameName.get(slugify(c.name)) ?? []), row]);
      byName.set(c.name.toLowerCase(), { id: row.id, c });
      if (opts.courseId) repo.setContext(row.id, opts.courseId, c.interpretation ?? null);
    }
    const resolve = (name: string): string | undefined => {
      const hit = byName.get(name.toLowerCase())?.id ?? repo.findConceptBySlug(slugify(name))?.id;
      if (hit) return hit;
      const named = sameName.get(slugify(name)) ?? [];
      return named.length === 1 ? named[0].id : undefined;
    };

    for (const { id, c } of byName.values()) {
      for (const p of c.prerequisites) {
        const pid = resolve(p);
        if (pid) repo.addEdge(id, pid, "prerequisite");
      }
    }

    // Path order: the analysis's learning path, then anything it forgot, with
    // prerequisites always placed before the concepts that need them.
    const ordered: string[] = [];
    const names = [...opts.learningPath, ...opts.concepts.map((c) => c.name)];
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (ordered.includes(id) || visiting.has(id)) return;
      visiting.add(id);
      for (const pre of repo.prerequisitesOf(id)) if ([...byName.values()].some((v) => v.id === pre)) visit(pre);
      visiting.delete(id);
      ordered.push(id);
    };
    for (const n of names) {
      const id = resolve(n);
      if (id) visit(id);
    }

    const planned: PlannedConcept[] = ordered.map((id) => {
      const entry = [...byName.values()].find((v) => v.id === id)!;
      return { conceptId: id, name: entry.c.name, role: entry.c.role, pages: entry.c.pages ?? [] };
    });
    if (opts.lectureId) {
      repo.setLectureConcepts(
        opts.lectureId,
        planned.map((p, i) => ({ concept_id: p.conceptId, role: p.role, position: i, pages: p.pages, section: byName.get(p.name.toLowerCase())?.c.section ?? null })),
      );
    }
    return planned;
  });
}

/** Prerequisite closure of a concept, nearest first, with depth. */
export function prerequisiteChain(repo: Repo, conceptId: string, maxDepth = 4): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = [];
  const seen = new Set([conceptId]);
  let frontier = [conceptId];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const p of repo.prerequisitesOf(id)) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ id: p, depth });
        next.push(p);
      }
    }
    frontier = next;
  }
  return out;
}

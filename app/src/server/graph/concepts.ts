// Shared cross-course concept graph. Identically named concepts are merged only
// when they mean the same thing: an analysis can set `sense` to split a homonym
// ("kernel (operating systems)" vs "kernel (machine learning)"). A shared concept
// keeps one foundational definition; each course stores its own interpretation.
import type { Repo } from "../db/repo.ts";
import type { AnalysisConcept, ConceptRole } from "../../shared/schemas.ts";
import { slugify } from "../../shared/slug.ts";

export function conceptSlug(c: { name: string; sense?: string | null }): string {
  return slugify(c.sense ? `${c.name} ${c.sense}` : c.name);
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
    const byName = new Map<string, { id: string; c: AnalysisConcept }>();
    for (const c of opts.concepts) {
      const slug = conceptSlug(c);
      const existing = repo.findConceptBySlug(slug);
      const row = existing ?? repo.createConcept(slug, c.name, c.sense ?? null, c.definition);
      byName.set(c.name.toLowerCase(), { id: row.id, c });
      if (opts.courseId) repo.setContext(row.id, opts.courseId, c.interpretation ?? null);
    }
    const resolve = (name: string): string | undefined =>
      byName.get(name.toLowerCase())?.id ?? repo.findConceptBySlug(slugify(name))?.id;

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

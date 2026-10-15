// Practice extraction: outline both documents, then one AI call per problem with only
// that problem's pages and its solution pages. Each problem is committed as soon as it
// validates, so a pause, failure or restart resumes where it stopped; cached outputs
// (keyed by both documents' SHA-256 and the problem number) are never paid for twice.
import type { Generator } from "../ai/generate.ts";
import { validateRefs } from "../alignment/refs.ts";
import type { Repo, SourceRow } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import { upsertConcepts } from "../graph/concepts.ts";
import { ProviderError } from "../providers/types.ts";
import { answerKeyProblem } from "../../shared/practice-grading.ts";
import type { PracticeOutline, PracticeProblemContent } from "../../shared/practice.ts";
import type { SourceRef } from "../../shared/schemas.ts";
import type { PracticeRepo, PracticeSetRow } from "./repo.ts";
import { buildLectureIndex, lectureSignature, rankTaughtIn, type LectureIndex } from "./taught-in.ts";

const OUTLINE_CHARS = 60_000;
const PAGE_CHARS = 8000;
export const GENERATED_NOTE = "AI-generated key (no official solution was provided).";

export interface ExtractDeps {
  repo: Repo;
  store: PracticeRepo;
  gen: Generator;
  bus: EventBus;
}

/** How a document is named to the learner: its lecture title (renamable), else the document title. */
export function documentTitle(repo: Repo, source: SourceRow): string {
  return repo.findLectureByDocument(source.document_id)?.title ?? repo.getDocument(source.document_id)?.title ?? source.filename;
}

/** All contiguous runs: [3,4,5,8] → 3–5, 8. */
export function pageSpans(pages: number[]): { page: number; pageEnd?: number }[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: { page: number; pageEnd?: number }[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p === (last.pageEnd ?? last.page) + 1) last.pageEnd = p;
    else out.push({ page: p });
  }
  return out;
}

/**
 * Where a problem is taught, and the signature it was computed for: the course's lectures
 * plus the set's other problems (their topics are contrast terms), so a stored result is
 * recomputed when either changes. Pass `index` to reuse one across problems.
 */
export function taughtIn(
  repo: Repo,
  store: PracticeRepo,
  set: PracticeSetRow,
  problem: { position: number; keywords: string[]; concepts: string[] },
  index?: LectureIndex,
): { sig: string; compute: () => SourceRef[] } {
  const others = store.listProblems(set.id).filter((p) => p.position !== problem.position);
  const contrast = [
    ...new Set([...(set.outline?.problems ?? []).filter((_, i) => i !== problem.position).map((p) => p.title), ...others.flatMap((p) => [p.title, ...p.concepts.map((c) => c.name), ...p.keywords])]),
  ];
  const sig = `${index?.sig ?? lectureSignature(repo, set.course_id)}#${contrast.join("|")}`;
  return { sig, compute: () => rankTaughtIn(repo, index ?? buildLectureIndex(repo, set.course_id), { keywords: problem.keywords, concepts: problem.concepts, contrast }) };
}

// ── Deterministic checks (a problem string makes the generator ask for a repair) ──

/**
 * `requireSolutionPages`: with a solution document, every problem must name where it is
 * answered. The last repair attempt relaxes this; such problems' steps are then marked
 * unverified rather than presented as copied from the solutions.
 */
export function outlineProblem(o: PracticeOutline, problemPageCount: number, solutionPageCount: number, requireSolutionPages = solutionPageCount > 0): string | null {
  const numbers = new Set<string>();
  for (const p of o.problems) {
    const n = p.number.trim().toLowerCase();
    if (numbers.has(n)) return `problem number "${p.number}" appears twice; list each problem once`;
    numbers.add(n);
    const badProblem = p.problemPages.find((x) => x > problemPageCount);
    if (badProblem) return `problem ${p.number}: problemPages ${badProblem} is beyond the problem document's ${problemPageCount} pages`;
    const badSolution = p.solutionPages.find((x) => x > solutionPageCount);
    if (badSolution) {
      return solutionPageCount
        ? `problem ${p.number}: solutionPages ${badSolution} is beyond the solution document's ${solutionPageCount} pages`
        : `problem ${p.number}: there is no solution document, so solutionPages must be empty`;
    }
  }
  const unanswered = requireSolutionPages && solutionPageCount > 0 ? o.problems.filter((p) => !p.solutionPages.length) : [];
  if (unanswered.length) {
    return `problem${unanswered.length > 1 ? "s" : ""} ${unanswered.map((p) => p.number).join(", ")}: solutionPages is empty; give the solution document's pages that answer each problem`;
  }
  return null;
}

export function problemContentProblem(p: PracticeProblemContent, solutionPageCount: number): string | null {
  const labels = new Set<string>();
  for (const s of p.steps) {
    const label = s.label.trim().toLowerCase();
    if (labels.has(label)) return `step label "${s.label}" is used twice; labels must be unique`;
    labels.add(label);
    const key = answerKeyProblem(s.key);
    if (key) return `step ${s.label}: ${key}`;
    for (const r of s.solutionRefs) {
      const last = Math.max(r.page, r.pageEnd ?? r.page);
      if (last > solutionPageCount) {
        return solutionPageCount
          ? `step ${s.label}: solutionRefs page ${last} is beyond the solution document's ${solutionPageCount} pages`
          : `step ${s.label}: there is no solution document, so solutionRefs must be empty`;
      }
    }
  }
  return null;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

function pagesOf(repo: Repo, source: SourceRow, pages: number[] | null, perPage: number) {
  const all = repo.getPages(source.id);
  const wanted = pages ? [...new Set(pages)].filter((p) => p >= 1 && p <= all.length).sort((a, b) => a - b) : all.map((_, i) => i + 1);
  return wanted.map((page) => ({ page, text: all[page - 1].slice(0, perPage) }));
}

function knownConcepts(repo: Repo, courseId: string): string[] {
  const all = repo.listConcepts();
  const inCourse = all.filter((c) => repo.contextsFor(c.id).some((x) => x.course_id === courseId));
  return [...new Set([...inCourse, ...all].map((c) => c.name))].slice(0, 80);
}

// ── The run ─────────────────────────────────────────────────────────────────

/** Extract every problem that isn't stored yet. Never throws; failures end up on the set row. */
export async function runExtraction(deps: ExtractDeps, setId: string, signal: AbortSignal): Promise<void> {
  const { repo, store, gen, bus } = deps;
  const initial = store.getSet(setId);
  if (!initial) return;
  const set: PracticeSetRow = initial;
  const alive = () => !signal.aborted && Boolean(store.getSet(setId));
  const progress = () => ({ done: store.problemPositions(setId).size, total: store.getSet(setId)?.progress_total ?? null });
  const publish = (status: string, extra: { problemId?: string } = {}) => {
    const p = progress();
    bus.publish({ type: "practice", setId, status, done: p.done, ...(p.total !== null ? { total: p.total } : {}), ...extra });
  };

  const problemSource = repo.getSource(set.problem_source_id)!;
  const solutionSource = set.solution_source_id ? repo.getSource(set.solution_source_id) ?? null : null;
  const shas = [problemSource.sha256, solutionSource?.sha256 ?? null];
  // One document holding both the problems and their solutions.
  const combined = solutionSource?.id === problemSource.id;

  try {
    let outline = set.outline;
    if (!outline) {
      const docs = [problemSource, ...(solutionSource && !combined ? [solutionSource] : [])];
      const perPage = Math.max(400, Math.min(2500, Math.floor(OUTLINE_CHARS / Math.max(1, docs.reduce((n, d) => n + d.page_count, 0)))));
      const doc = (s: SourceRow) => ({ filename: s.filename, title: documentTitle(repo, s), pageCount: s.page_count, pages: pagesOf(repo, s, null, perPage) });
      // Missing solutionPages are repaired twice; after that the outline is accepted and the
      // affected steps carry no verified solution reference (keyVerified false).
      let checks = 0;
      const raw = await gen.run(
        "practice_outline",
        {
          problemDocument: doc(problemSource),
          solutionDocument: combined ? { sameAsProblemDocument: true, filename: problemSource.filename, pageCount: problemSource.page_count } : solutionSource ? doc(solutionSource) : null,
        },
        { cacheKey: ["practice_outline", ...shas], check: (o) => outlineProblem(o, problemSource.page_count, solutionSource?.page_count ?? 0, checks++ < 2),
          // A stored outline was accepted once; only missing solutionPages may remain (pure, no counter).
          cacheCheck: (o) => outlineProblem(o, problemSource.page_count, solutionSource?.page_count ?? 0, false),
          signal,
        },
      );
      if (!alive()) return;
      outline = { ...raw, problems: raw.problems.map((p) => ({ ...p, solutionPages: solutionSource ? p.solutionPages : [] })) };
      store.updateSet(setId, { outline, progress_total: outline.problems.length });
      publish("extracting");
    }

    const index = buildLectureIndex(repo, set.course_id);
    const course = repo.getCourse(set.course_id);
    const failures: string[] = [];
    for (const [position, op] of outline.problems.entries()) {
      if (!alive()) return;
      if (store.problemPositions(setId).has(position)) continue;
      const solutionPages = solutionSource ? pagesOf(repo, solutionSource, op.solutionPages, PAGE_CHARS) : [];
      let content: PracticeProblemContent;
      try {
        content = await gen.run(
          "practice_problem",
          {
            document: set.title,
            course: course?.title ?? null,
            problem: { number: op.number, title: op.title },
            keySource: set.key_source,
            problemDocument: { filename: problemSource.filename, pageCount: problemSource.page_count },
            problemPages: pagesOf(repo, problemSource, op.problemPages, PAGE_CHARS),
            solutionDocument: solutionSource ? { filename: solutionSource.filename, pageCount: solutionSource.page_count, ...(combined ? { sameAsProblemDocument: true } : {}) } : null,
            solutionPages,
            knownConcepts: knownConcepts(repo, set.course_id),
          },
          {
            cacheKey: ["practice_problem", ...shas, op.number, op.problemPages, op.solutionPages],
            check: (p) => problemContentProblem(p, solutionSource?.page_count ?? 0),
            signal,
          },
        );
      } catch (e) {
        // One problem the model can't produce validly doesn't block the others; a retry tries it again.
        if (e instanceof ProviderError && e.code === "invalid_response") {
          failures.push(`problem ${op.number} (${e.message})`);
          continue;
        }
        throw e;
      }
      if (!alive()) return;
      const row = saveProblem(deps, set, { position, number: op.number, problemPages: op.problemPages, solutionPages: solutionPages.map((p) => p.page) }, content, index, problemSource, solutionSource);
      publish("extracting", { problemId: row.id });
    }

    if (failures.length) {
      store.updateSet(setId, { status: "failed", error: `Couldn't extract ${failures.join("; ")}. The other problems are ready; retry to try again.` });
      publish("failed");
    } else {
      store.updateSet(setId, { status: "ready", error: null });
      publish("ready");
    }
  } catch (e) {
    if (!alive()) return;
    const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message);
    const { done, total } = progress();
    const saved = total ? `${done} of ${total} problems are saved` : "Nothing was extracted yet";
    const what = err.code === "usage_limit" ? `Paused: the AI provider reached its usage limit (${err.message})` : err.message;
    store.updateSet(setId, { status: "failed", error: `${what}. ${saved}; retry to continue where it stopped.` });
    publish("failed");
  }
}

/** Commit one validated problem: concepts into the shared graph, checked refs, then rows. */
function saveProblem(
  deps: ExtractDeps,
  set: PracticeSetRow,
  at: { position: number; number: string; problemPages: number[]; solutionPages: number[] },
  content: PracticeProblemContent,
  index: LectureIndex,
  problemSource: SourceRow,
  solutionSource: SourceRow | null,
) {
  const { repo, store } = deps;
  return repo.tx(() => {
    const planned = upsertConcepts(repo, {
      courseId: set.course_id,
      lectureId: null,
      concepts: content.concepts.map((c) => ({ name: c.name, definition: c.definition, ...(c.sense ? { sense: c.sense } : {}), role: "central" as const, pages: [], prerequisites: [] })),
      learningPath: content.concepts.map((c) => c.name),
    });
    const concepts = planned.map((p) => ({ id: p.conceptId, name: repo.getConcept(p.conceptId)!.name }));
    const byName = new Map(planned.map((p) => [p.name.toLowerCase(), p.conceptId]));
    const where = taughtIn(repo, store, set, { position: at.position, keywords: content.keywords, concepts: concepts.map((c) => c.name) }, index);
    const provided = new Set(at.solutionPages);
    const solutionTitle = solutionSource ? documentTitle(repo, solutionSource) : null;

    const steps = content.steps.map((s) => {
      // Cite only solution pages the model was actually shown, and only quotes found on them.
      // A step is presented as from the solutions only when one of these quotes verified
      // (see keyVerified in view.ts); otherwise the UI labels its key AI-derived.
      const refs: SourceRef[] = solutionSource
        ? validateRefs(
            repo,
            solutionSource.id,
            s.solutionRefs.filter((r) => provided.has(r.page)).map((r) => ({ ...r, pageEnd: r.pageEnd && provided.has(r.pageEnd) ? r.pageEnd : undefined })),
            solutionTitle,
          ).refs
        : [];
      const solution = set.key_source === "generated" && !/ai[- ]generated/i.test(s.solution) ? `*${GENERATED_NOTE}*\n\n${s.solution}` : s.solution;
      return {
        label: s.label.trim(),
        prompt: s.prompt,
        kind: s.key.kind,
        key: s.key,
        solution,
        hint: s.hint?.trim() || null,
        concepts: [...new Set(s.concepts.map((n) => byName.get(n.toLowerCase())).filter((id): id is string => Boolean(id)))],
        solution_refs: refs,
      };
    });

    return store.insertProblem(
      {
        set_id: set.id,
        position: at.position,
        number: at.number,
        title: content.title,
        intro: content.intro,
        concepts,
        keywords: content.keywords,
        taught_in: where.compute(),
        taught_in_sig: where.sig,
        problem_refs: pageSpans(at.problemPages).flatMap((span) => validateRefs(repo, problemSource.id, [span], documentTitle(repo, problemSource)).refs),
      },
      steps,
    );
  });
}

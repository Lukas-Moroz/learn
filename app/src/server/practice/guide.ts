// Guided practice: a warm-up before a problem (probing questions on the ideas it assumes),
// and coaching after every unsuccessful attempt at a step (a tentative diagnosis, a conceptual
// explanation grounded in the lecture, a worked mini-example on different data and a check
// question; the check is a second generation written from the committed explanation, so the
// explanation is shown, streaming as it is written, without waiting for it), without giving the
// step's answer away. Content is generated through
// Generator.run (job rows, validation, repair) in the background and stored, so a refresh or
// restart shows the same content. With no provider it waits ("waiting") and is retried later.
import type { Generator } from "../ai/generate.ts";
import { validateRefs } from "../alignment/refs.ts";
import type { Repo } from "../db/repo.ts";
import { now } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import { prerequisiteChain, upsertConcepts } from "../graph/concepts.ts";
import { ProviderError } from "../providers/types.ts";
import { boilerplateLines, isNearEmpty, scenarioDataProblem, stripBoilerplate, type Engine } from "../teaching/engine.ts";
import { grade, hiddenOptionReference, normalizeOptions, optionShapeProblem, resolveCorrect, seededRandom, shuffle } from "../../shared/grading.ts";
import { evidenceFromAttempt } from "../../shared/mastery.ts";
import { expectedDisplay } from "../../shared/practice-grading.ts";
import { forbiddenValues, leakedKeyValues } from "../../shared/practice-leak.ts";
import type { PracticeCoaching, PracticePrimer, PracticeRef } from "../../shared/practice.ts";
import { AttemptInput, type QuestionContent, type SourceRef, type Strategy } from "../../shared/schemas.ts";
import { documentTitle } from "./extract.ts";
import type { PracticeAttemptRow, PracticeProblemRow, PracticeRepo, PracticeStepRow, StoredCoaching, StoredProbe, StoredQuestion } from "./repo.ts";
import { firstParagraph, stepConcepts, unsuccessful } from "./view.ts";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Lecture text sent with each request (chars), from the problem's "taught in" pages. */
const EXCERPT_BUDGET = 4500;
const EXCERPT_PAGE_CHARS = 1200;
/** Coaching text the learner sees while it is being written (each preview is leak-checked first). */
const COACH_PREVIEW_FIELDS = ["diagnosis", "summary", "explanation", "example"] as const;
/** Coaching rounds per step; after that the solution is the next move. */
export const MAX_COACHING_ROUNDS = 3;
/** Teaching angles for coaching, in order: a later round never repeats an earlier one's. */
export const COACHING_STRATEGIES: Strategy[] = ["first_principles", "contrasting_cases", "worked_example", "analogy", "visual", "derivation"];

/** Audit a generated multiple-choice question with the same rules lesson questions follow. */
export function questionProblem(q: QuestionContent): string | null {
  try {
    const options = normalizeOptions(q.options);
    if (options.length < 2) return "needs at least two options";
    const correct = resolveCorrect(q.correct, options);
    if (!q.multiSelect && correct.length !== 1) return "single-select questions need exactly one correct value";
    const shape = optionShapeProblem(options, correct);
    if (shape) return shape;
    const hidden = hiddenOptionReference(q.explanation, options);
    if (hidden) return `explanation ${hidden}`;
    return scenarioDataProblem(q);
  } catch (e) {
    return (e as Error).message;
  }
}

/** Options shuffled once (deterministically per question id) and stored in display order. */
function storeQuestion(q: QuestionContent, seed: string): StoredQuestion {
  const options = normalizeOptions(q.options);
  const correct = resolveCorrect(q.correct, options);
  const { refs: _refs, options: _o, correct: _c, ...rest } = q;
  return { ...rest, options: shuffle(options, seededRandom(seed)), correct };
}

/** Sentences in a short text (decimals, "e.g." and "i.e." are not sentence ends). */
export function sentenceCount(text: string): number {
  const t = text.replace(/\b(?:e\.g|i\.e|etc|vs|cf)\./gi, "x").replace(/\$[^$]*\$/g, "x").trim();
  return t ? t.split(/[.!?]+(?=\s|$)/).filter((x) => x.trim()).length : 0;
}

const questionText = (q: QuestionContent) => [q.stem, ...q.options.map((o) => o.label), q.explanation].join("\n");

interface Excerpts {
  /** Excerpt document number → source. */
  docs: Map<number, { sourceId: string; title: string }>;
  input: { excerpts: { doc: number; lecture: string; page: number; text: string }[] } | null;
}

export class PracticeGuide {
  private running = new Map<string, Promise<void>>();
  private boilerplate = new Map<string, Set<string>>();

  constructor(
    readonly repo: Repo,
    readonly store: PracticeRepo,
    readonly gen: Generator,
    readonly bus: EventBus,
    readonly engine: Engine,
  ) {}

  /** Resolves once no generation is running (tests and the seed script await it). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  private launch(key: string, fn: () => Promise<void>) {
    if (this.running.has(key)) return;
    const p = fn()
      .catch(() => undefined)
      .finally(() => this.running.delete(key));
    this.running.set(key, p);
  }

  /** After a provider comes back: retry everything that waited for one. */
  resume() {
    for (const c of this.store.coachingWithStatus("waiting")) this.launch(`coach:${c.id}`, () => this.runCoaching(c.id));
    for (const c of this.store.coachingWithStatus("ready")) if (c.content && !c.content.check && c.content.checkStatus === "waiting") this.launch(`coach:${c.id}`, () => this.runCoaching(c.id));
    for (const p of this.store.primersWithStatus("waiting")) if (!p.skipped) this.launch(`primer:${p.problem_id}`, () => this.runPrimer(p.problem_id));
  }

  // ── Shared inputs ─────────────────────────────────────────────────────────

  /** Text of the lecture pages where the problem is taught, numbered by document for refs. */
  excerpts(problem: PracticeProblemRow): Excerpts {
    const docs = new Map<number, { sourceId: string; title: string }>();
    const numberOf = new Map<string, number>();
    const out: { doc: number; lecture: string; page: number; text: string }[] = [];
    let left = EXCERPT_BUDGET;
    for (const ref of problem.taught_in.slice(0, 3)) {
      const source = this.repo.getSource(ref.sourceId);
      if (!source) continue;
      const pages = this.repo.getPages(source.id);
      let bp = this.boilerplate.get(source.id);
      if (!bp) this.boilerplate.set(source.id, (bp = boilerplateLines(pages)));
      const title = documentTitle(this.repo, source);
      for (let p = ref.page; p <= Math.min(ref.pageEnd ?? ref.page, ref.page + 4); p++) {
        if (left < 200) break;
        const text = stripBoilerplate(pages[p - 1] ?? "", bp);
        if (isNearEmpty(text)) continue;
        if (!numberOf.has(source.id)) {
          numberOf.set(source.id, numberOf.size + 1);
          docs.set(numberOf.get(source.id)!, { sourceId: source.id, title });
        }
        const slice = text.slice(0, Math.min(EXCERPT_PAGE_CHARS, left));
        out.push({ doc: numberOf.get(source.id)!, lecture: title, page: p, text: slice });
        left -= slice.length;
      }
    }
    return { docs, input: out.length ? { excerpts: out } : null };
  }

  /** Model refs ({doc, page, quote}) checked against the stored pages, like lesson refs. */
  refs(refs: PracticeRef[], ex: Excerpts): SourceRef[] {
    const out: SourceRef[] = [];
    for (const [doc, d] of ex.docs) {
      const mine = refs.filter((r) => r.doc === doc).map(({ doc: _d, ...r }) => r);
      if (mine.length) out.push(...validateRefs(this.repo, d.sourceId, mine, d.title).refs);
    }
    return out;
  }

  private conceptInfo(id: string) {
    const c = this.repo.getConcept(id);
    return c ? { id, name: c.name, definition: c.definition, mastery: this.engine.mastery(id, "background").status } : null;
  }

  private courseOf(problem: PracticeProblemRow): string {
    return this.store.getSet(problem.set_id)!.course_id;
  }

  /**
   * Evidence and misconceptions for an answer to a warm-up probe or a coaching check, exactly as a
   * lesson question of the same purpose would record them.
   */
  private recordAnswer(answerId: string, conceptIds: string[], courseId: string, q: StoredQuestion, purpose: "probe" | "check", input: AttemptInput, g: ReturnType<typeof grade>, at: string) {
    const confidence = input.dontKnow ? null : input.confidence;
    const items = evidenceFromAttempt({ kind: q.kind, context: q.context, purpose, correct: g.correct, confidence, reasoning: null }, at).map((e) => ({
      ...e,
      note: `Exam practice ${purpose === "probe" ? "warm-up" : "coaching check"}: ${e.note ?? ""}`.trim(),
    }));
    for (const id of conceptIds) {
      this.repo.addEvidence(id, courseId, answerId, items);
      for (const m of new Set(g.misconceptions)) this.repo.recordMisconception(id, m, null, confidence, { kind: "practice", id: answerId }, at);
      if (g.correct === true && confidence !== "guess") {
        const targeted = new Set(q.options.map((o) => o.misconception).filter(Boolean));
        for (const m of this.repo.activeMisconceptions(id)) if (targeted.has(m.label)) this.repo.resolveMisconception(id, m.label, at);
      }
    }
  }

  // ── Warm-up ───────────────────────────────────────────────────────────────

  /** Prepare (or retry) the warm-up for a problem. Nothing to probe → "none", without an AI request. */
  startPrimer(problemId: string) {
    const problem = this.store.getProblem(problemId);
    if (!problem) throw httpError(404, "Problem not found");
    const row = this.store.getPrimer(problemId);
    if (row && (row.skipped || row.status === "ready" || row.status === "none")) return;
    if (this.running.has(`primer:${problemId}`)) return;
    const demonstrated = problem.concepts.every((c) => this.conceptInfo(c.id)?.mastery === "demonstrated");
    if (demonstrated) {
      this.store.putPrimer(problemId, { status: "none", error: null });
      return;
    }
    this.store.putPrimer(problemId, { status: "pending", error: null });
    this.launch(`primer:${problemId}`, () => this.runPrimer(problemId));
  }

  skipPrimer(problemId: string) {
    if (!this.store.getProblem(problemId)) throw httpError(404, "Problem not found");
    const row = this.store.getPrimer(problemId);
    this.store.putPrimer(problemId, { skipped: true, status: row?.status ?? "none" });
  }

  private async runPrimer(problemId: string): Promise<void> {
    const problem = this.store.getProblem(problemId);
    if (!problem) return;
    this.store.putPrimer(problemId, { status: "pending", error: null });
    const own = problem.concepts.map((c) => this.conceptInfo(c.id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const ownIds = new Set(own.map((c) => c.id));
    const prereqs = [...new Map(own.flatMap((c) => prerequisiteChain(this.repo, c.id, 2)).map((p) => [p.id, p])).keys()]
      .filter((id) => !ownIds.has(id))
      .map((id) => this.conceptInfo(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .slice(0, 8);
    const candidates = [...own.map((c) => ({ ...c, role: "problem" })), ...prereqs.map((c) => ({ ...c, role: "prerequisite" }))];
    const known = new Map(candidates.map((c) => [c.name.toLowerCase(), c]));
    const demonstrated = new Set(candidates.filter((c) => c.mastery === "demonstrated").map((c) => c.name.toLowerCase()));
    const steps = this.store.listSteps(problemId);
    const ex = this.excerpts(problem);
    const input = {
      problem: { title: problem.title, intro: problem.intro, steps: steps.map((s) => ({ label: s.label, prompt: s.prompt })) },
      concepts: candidates.filter((c) => !demonstrated.has(c.name.toLowerCase())).map((c) => ({ name: c.name, definition: c.definition, role: c.role, mastery: c.mastery })),
      alreadyDemonstrated: candidates.filter((c) => demonstrated.has(c.name.toLowerCase())).map((c) => c.name),
      lecture: ex.input,
    };
    let content: PracticePrimer;
    try {
      content = await this.gen.run("practice_primer", input, {
        check: (v) => {
          for (const [i, p] of v.probes.entries()) {
            const name = p.concept.trim().toLowerCase();
            if (demonstrated.has(name)) return `probes[${i}].concept "${p.concept}" is already demonstrated by the learner; probe a different idea`;
            if (!known.has(name) && !p.definition?.trim()) return `probes[${i}].concept "${p.concept}" is not in "concepts"; give its "definition"`;
            const q = questionProblem(p.question);
            if (q) return `probes[${i}].question: ${q}`;
            const text = `${questionText(p.question)}\n${p.teach}\n${p.why}`;
            for (const s of steps) {
              const hits = leakedKeyValues(s.key, text, problem.intro);
              if (hits.length) return `probes[${i}] gives away the answer to step ${s.label} (${hits.join(", ")}); warm-up questions use their own small data and never the problem's answers`;
            }
          }
          return null;
        },
      });
    } catch (e) {
      this.fail("primer", problemId, e);
      return;
    }
    const courseId = this.courseOf(problem);
    this.repo.tx(() => {
      const probes: StoredProbe[] = content.probes.map((p, i) => {
        let concept = known.get(p.concept.trim().toLowerCase());
        if (!concept) {
          const [planned] = upsertConcepts(this.repo, {
            courseId,
            lectureId: null,
            concepts: [{ name: p.concept.trim(), definition: p.definition!.trim(), role: "background", pages: [], prerequisites: [] }],
            learningPath: [p.concept.trim()],
          });
          concept = { ...this.conceptInfo(planned.conceptId)!, role: "prerequisite" };
        }
        return { conceptId: concept.id, conceptName: concept.name, why: p.why, question: storeQuestion(p.question, `${problemId}:${i}`), teach: p.teach, refs: this.refs(p.refs, ex) };
      });
      this.store.putPrimer(problemId, { status: "ready", probes, error: null });
    });
    this.bus.publish({ type: "practice", setId: problem.set_id, problemId, status: "primer" });
  }

  answerProbe(problemId: string, index: number, raw: unknown) {
    const input = AttemptInput.parse(raw);
    const problem = this.store.getProblem(problemId);
    if (!problem) throw httpError(404, "Problem not found");
    const row = this.store.getPrimer(problemId);
    const probe = row?.status === "ready" ? row.probes[index] : undefined;
    if (!probe) throw httpError(404, "Warm-up question not found");
    if (this.store.probeAnswers(problemId).some((a) => a.idx === index)) return; // already answered: idempotent
    let g: ReturnType<typeof grade>;
    try {
      g = grade(probe.question.options, probe.question.correct, { selected: input.selected, dontKnow: input.dontKnow });
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
    this.repo.tx(() => {
      const a = this.store.insertProbeAnswer({ problem_id: problemId, idx: index, selected: input.dontKnow ? [] : input.selected, dont_know: input.dontKnow, confidence: input.dontKnow ? null : input.confidence, correct: g.correct });
      this.recordAnswer(a.id, [probe.conceptId], this.courseOf(problem), probe.question, "probe", input, g, a.created_at);
    });
  }

  // ── Coaching after a miss ─────────────────────────────────────────────────

  /** Start coaching for an unsuccessful attempt (unless the key was already shown or the rounds are used up). */
  startCoaching(step: PracticeStepRow, attempt: PracticeAttemptRow) {
    if (!unsuccessful(attempt)) return;
    const attempts = this.store.attemptsForStep(step.id);
    if (attempts.some((a) => a.revealed || a.overridden)) return;
    if (this.store.coachingForAttempt(attempt.id)) return;
    const prior = this.store.coachingForStep(step.id);
    if (prior.length >= MAX_COACHING_ROUNDS) return;
    const row = this.store.insertCoaching({ step_id: step.id, attempt_id: attempt.id, round: prior.length + 1 });
    this.launch(`coach:${row.id}`, () => this.runCoaching(row.id));
  }

  /** Retry the step's latest coaching that is waiting or failed (or start it for the latest miss). */
  retryCoaching(stepId: string) {
    const step = this.store.getStep(stepId);
    if (!step) throw httpError(404, "Step not found");
    const latest = this.store.coachingForStep(stepId).at(-1);
    // Waiting or failed: the explanation, or (once it is there) the check question.
    if (latest && (latest.status !== "ready" || (latest.content && !latest.content.check))) {
      this.launch(`coach:${latest.id}`, () => this.runCoaching(latest.id));
      return;
    }
    const last = this.store.attemptsForStep(stepId).at(-1);
    if (last && !this.store.coachingForAttempt(last.id)) this.startCoaching(step, last);
  }

  /**
   * Coaching in two generations: the explanation (diagnosis, idea, worked example, next hint) is
   * committed and shown as soon as it validates, then the check question is written from it.
   */
  private async runCoaching(id: string): Promise<void> {
    const row = this.store.getCoaching(id);
    if (!row) return;
    if (row.status !== "ready") {
      if (!(await this.runCoachingExplanation(id))) return;
    } else if (!row.content || row.content.check) return;
    await this.runCoachingCheck(id);
  }

  private async runCoachingExplanation(id: string): Promise<boolean> {
    const row = this.store.getCoaching(id);
    if (!row || row.status === "ready") return true;
    const step = this.store.getStep(row.step_id);
    const attempt = this.store.getAttempt(row.attempt_id);
    if (!step || !attempt) return false;
    const problem = this.store.getProblem(step.problem_id)!;
    this.store.setCoaching(id, { status: "pending", error: null });
    const prior = this.store.coachingForStep(step.id).filter((c) => c.round < row.round && c.content);
    const used = prior.map((c) => c.content!.strategy);
    const strategy = COACHING_STRATEGIES.find((s) => !used.includes(s)) ?? COACHING_STRATEGIES[row.round % COACHING_STRATEGIES.length];
    const concepts = stepConcepts(this.store, problem, step).map((c) => this.conceptInfo(c.id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const ex = this.excerpts(problem);
    const input = {
      problem: { title: problem.title, intro: problem.intro },
      step: { label: step.label, prompt: step.prompt, kind: step.kind, hint: step.hint },
      key: { expected: expectedDisplay(step.key), solution: step.solution },
      forbiddenValues: forbiddenValues(step.key),
      learner: this.learnerInput(step, attempt),
      earlierAttempts: this.store
        .attemptsForStep(step.id)
        .filter((a) => a.id !== attempt.id && a.created_at <= attempt.created_at)
        .map((a) => this.learnerInput(step, a)),
      round: row.round,
      strategy,
      avoidStrategies: used,
      priorCoaching: prior.map((c) => ({
        round: c.round,
        strategy: c.content!.strategy,
        diagnosis: c.content!.diagnosis,
        summary: c.content!.summary ?? firstParagraph(c.content!.explanation),
        explanation: c.content!.explanation.slice(0, 800),
        example: c.content!.example.slice(0, 500),
        checkAnswered: c.check ? (c.check.correct === true ? "correct" : c.check.dont_know ? "I don't know" : "wrong") : "not answered",
      })),
      concepts: concepts.map(({ name, definition, mastery }) => ({ name, definition, mastery })),
      lecture: ex.input,
    };
    const leaks = (text: string) => leakedKeyValues(step.key, text, problem.intro);
    let content: PracticeCoaching;
    try {
      content = await this.gen.run("practice_coach", input, {
        meta: { setId: problem.set_id, problemId: problem.id, stepId: step.id, coachingId: id },
        // Streamed to the learner as it is written, each preview leak-checked against the key first.
        preview: { fields: COACH_PREVIEW_FIELDS, withhold: (v) => leaks(COACH_PREVIEW_FIELDS.map((f) => v[f] ?? "").join("\n")).length > 0 },
        check: (v) => {
          if (used.includes(v.strategy)) return `strategy "${v.strategy}" was already used for this step (${used.join(", ")}); take a genuinely different approach, e.g. "${strategy}"`;
          const sentences = sentenceCount(v.summary);
          if (sentences > 2) return `"summary" has ${sentences} sentences; give the core idea in at most two`;
          const hits = leaks([v.diagnosis, v.summary, v.explanation, v.example, v.nextHint].join("\n"));
          if (hits.length) return `the coaching gives the step's answer away: it contains ${hits.join(", ")}. Never write the key's values; teach the idea and work the example on different, smaller data`;
          return null;
        },
      });
    } catch (e) {
      this.fail("coach", id, e);
      return false;
    }
    const { refs, ...rest } = content;
    this.store.setCoaching(id, { status: "ready", content: { ...rest, check: null, checkStatus: "pending", checkError: null }, refs: this.refs(refs, ex), error: null });
    this.bus.publish({ type: "practice", setId: problem.set_id, problemId: problem.id, stepId: step.id, status: "coached" });
    return true;
  }

  /** The check question on a committed coaching block's mini-example. */
  private async runCoachingCheck(id: string): Promise<void> {
    const row = this.store.getCoaching(id);
    if (!row?.content || row.content.check) return;
    const step = this.store.getStep(row.step_id)!;
    const problem = this.store.getProblem(step.problem_id)!;
    const content = row.content;
    const setCheck = (patch: Partial<StoredCoaching>) => {
      const cur = this.store.getCoaching(id);
      if (cur?.content) this.store.setCoaching(id, { status: "ready", content: { ...cur.content, ...patch } });
      this.bus.publish({ type: "practice", setId: problem.set_id, problemId: problem.id, stepId: step.id, status: "coached" });
    };
    if (content.checkStatus !== "pending") setCheck({ checkStatus: "pending", checkError: null });
    const concepts = stepConcepts(this.store, problem, step).map((c) => this.conceptInfo(c.id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const earlier = this.store
      .coachingForStep(step.id)
      .filter((c) => c.id !== id && c.content?.check)
      .map((c) => ({ scenario: c.content!.check!.scenario, stem: c.content!.check!.stem }));
    const input = {
      problem: { title: problem.title, intro: problem.intro },
      step: { label: step.label, prompt: step.prompt, kind: step.kind },
      forbiddenValues: forbiddenValues(step.key),
      coaching: { strategy: content.strategy, explanation: content.explanation, example: content.example },
      round: row.round,
      avoid: earlier,
      concepts: concepts.map(({ name, definition }) => ({ name, definition })),
    };
    let check: QuestionContent;
    try {
      ({ check } = await this.gen.run("practice_coach_check", input, {
        meta: { setId: problem.set_id, problemId: problem.id, stepId: step.id, coachingId: id },
        // The question's stem is shown as it is written, leak-checked against the step's key first.
        preview: { fields: ["check.stem"], withhold: (v) => leakedKeyValues(step.key, v["check.stem"] ?? "", problem.intro).length > 0 },
        check: (v) => {
          const q = questionProblem(v.check);
          if (q) return `check: ${q}`;
          const hits = leakedKeyValues(step.key, questionText(v.check), problem.intro);
          if (hits.length) return `the check question gives the step's answer away: it contains ${hits.join(", ")}. Ask about the mini-example's own small data, never the problem's answers`;
          return null;
        },
      }));
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message, true);
      const failed = err.code === "invalid_response";
      setCheck({ checkStatus: failed ? "failed" : "waiting", checkError: failed ? "The AI's check question didn't pass the checks." : err.message });
      return;
    }
    setCheck({ check: storeQuestion(check, id), checkStatus: "ready", checkError: null });
  }

  /** What the learner did, for the coach: the answer in words, and for tables which cells were wrong. */
  learnerInput(step: PracticeStepRow, a: PracticeAttemptRow) {
    const key = step.key;
    const base = { confidence: a.confidence, ...(a.feedback ? { feedback: a.feedback } : {}), ...(a.grade?.misconception ? { misconception: a.grade.misconception.label } : {}) };
    if (a.dont_know) return { answer: "I don't know", ...base };
    if (key.kind === "table" && Array.isArray(a.value)) {
      const rows = a.value as string[][];
      const wrongCells: { row: string; column: string; typed: string }[] = [];
      a.cell_results?.forEach((r, i) => r.forEach((ok, j) => ok === false && wrongCells.push({ row: key.rowLabels[i] ?? String(i), column: key.colLabels[j] ?? String(j), typed: rows[i]?.[j] ?? "" })));
      return { answer: rows.map((r) => r.join(" | ")).join("\n"), wrongCells, ...base };
    }
    if (key.kind === "choice" && Array.isArray(a.value)) {
      const labels = new Map(normalizeOptions(key.options).map((o) => [o.value, o.label]));
      return { answer: (a.value as string[]).map((v) => labels.get(v) ?? v).join("; "), ...base };
    }
    return { answer: String(a.value ?? ""), ...base };
  }

  answerCheck(coachingId: string, raw: unknown): PracticeStepRow {
    const input = AttemptInput.parse(raw);
    const row = this.store.getCoaching(coachingId);
    if (!row?.content) throw httpError(404, "Coaching check not found");
    const step = this.store.getStep(row.step_id)!;
    if (row.check) return step; // already answered: idempotent
    const q = row.content.check;
    if (!q) throw httpError(409, "The check question isn't ready yet");
    let g: ReturnType<typeof grade>;
    try {
      g = grade(q.options, q.correct, { selected: input.selected, dontKnow: input.dontKnow });
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
    const problem = this.store.getProblem(step.problem_id)!;
    const conceptIds = step.concepts.length ? step.concepts : problem.concepts.map((c) => c.id);
    this.repo.tx(() => {
      this.store.setCoachingCheck(coachingId, { selected: input.dontKnow ? [] : input.selected, dont_know: input.dontKnow, confidence: input.dontKnow ? null : input.confidence, correct: g.correct });
      this.recordAnswer(coachingId, conceptIds, this.courseOf(problem), q, "check", input, g, now());
    });
    return step;
  }

  /** Invalid output after repairs: failed (retry on request). No provider: waiting (retried when one is back). */
  private fail(kind: "primer" | "coach", id: string, e: unknown) {
    const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message, true);
    const status = err.code === "invalid_response" ? "failed" : "waiting";
    const message = status === "failed" ? "The AI's answer didn't pass the checks." : err.message;
    let setId: string | undefined;
    let problemId: string | undefined;
    let stepId: string | undefined;
    if (kind === "primer") {
      this.store.putPrimer(id, { status, error: message });
      problemId = id;
    } else {
      this.store.setCoaching(id, { status, error: message });
      stepId = this.store.getCoaching(id)?.step_id;
      problemId = stepId ? this.store.getStep(stepId)?.problem_id : undefined;
    }
    setId = problemId ? this.store.getProblem(problemId)?.set_id : undefined;
    this.bus.publish({ type: "practice", setId, problemId, stepId, status: kind === "primer" ? "primer" : "coached" });
  }
}

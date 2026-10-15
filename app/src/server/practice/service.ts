// Exam practice: sets of worked problems from a study guide, checked step by step
// against its solution key. Grading is deterministic except for written explanations,
// which the AI grades later (they stay "pending" while no provider is available).
// Attempts write mastery evidence like lesson questions do: computed steps count as
// application, explanations as explanation, and only a first attempt counts (later
// ones come after coaching or the key). Guided practice (guide.ts): a wrong answer or
// "I don't know" keeps the key hidden and gets coaching; only "Show solution" reveals it.
import type { Generator } from "../ai/generate.ts";
import type { Repo, SourceRow } from "../db/repo.ts";
import { now } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import { ProviderError } from "../providers/types.ts";
import type { Engine } from "../teaching/engine.ts";
import { normalizeOptions } from "../../shared/grading.ts";
import { evidenceFromAttempt, type EvidenceItem } from "../../shared/mastery.ts";
import { gradeStep } from "../../shared/practice-grading.ts";
import { PracticeAnswerInput, type PracticeCandidates, type PracticeGrade } from "../../shared/practice.ts";
import type { Confidence } from "../../shared/schemas.ts";
import { documentTitle, runExtraction, taughtIn } from "./extract.ts";
import { FollowUpRepo } from "../followup/repo.ts";
import { PracticeGuide } from "./guide.ts";
import { PracticeRepo, type PracticeAttemptRow, type PracticeStepRow, type PracticeValue } from "./repo.ts";
import { problemView, setSummary, setView, stepConcepts, stepView } from "./view.ts";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

// Names that mark a document as a study guide or problem set, and suffixes that mark its solutions.
const PROBLEM_LIKE = /study\s*guide|practice|problems?|exam|midterm|final|homework|\bhw\s*\d|assignment|worksheet|quiz|exercises?/i;
const SOLUTION_SUFFIX = /(?:worked)?(?:solutions?|answers?|answerkey|key|sols?|solns?)$/;
const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^\p{L}\p{N}]+/gu, "");

export class PracticeService {
  readonly store: PracticeRepo;
  readonly guide: PracticeGuide;
  private runs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private grading: Promise<number> | null = null;

  constructor(
    readonly repo: Repo,
    readonly gen: Generator,
    readonly bus: EventBus,
    readonly engine: Engine,
  ) {
    this.store = new PracticeRepo(repo);
    this.guide = new PracticeGuide(repo, this.store, gen, bus, engine);
  }

  /** On boot: extractions cut off by a restart are marked failed; retry resumes them. Warm-ups and coaching wait for a retry. */
  recoverAtBoot(): number {
    this.store.interruptGuides();
    return this.store.interruptExtractions("Extraction stopped when Learn was closed. Finished problems are kept; retry to continue where it stopped.");
  }

  /** A provider is available again: grade waiting explanations and generate waiting coaching. */
  resume() {
    void this.processPendingGrades();
    this.guide.resume();
  }

  /** Resolves once no warm-up or coaching generation is running. */
  idle(): Promise<void> {
    return this.guide.idle();
  }

  // ── Sets ──────────────────────────────────────────────────────────────────

  private set(setId: string) {
    const set = this.store.getSet(setId);
    if (!set) throw httpError(404, "Practice set not found");
    return set;
  }

  listSets(courseId: string) {
    return this.store.listSets(courseId).map((s) => setView(this.store, s));
  }

  summaries(courseId: string) {
    return this.store.listSets(courseId).map((s) => setSummary(this.store, s));
  }

  getSet(setId: string) {
    return setView(this.store, this.set(setId));
  }

  /** The running extraction for a set, if any (tests and the seed script await it). */
  extraction(setId: string): Promise<void> | undefined {
    return this.runs.get(setId)?.promise;
  }

  private start(setId: string) {
    if (this.runs.has(setId)) return;
    const controller = new AbortController();
    const promise = runExtraction({ repo: this.repo, store: this.store, gen: this.gen, bus: this.bus }, setId, controller.signal)
      .catch(() => undefined)
      .finally(() => this.runs.delete(setId));
    this.runs.set(setId, { promise, controller });
  }

  private courseSource(courseId: string, id: unknown, what: string): SourceRow {
    const source = typeof id === "string" ? this.repo.getSource(id) : undefined;
    if (!source || this.repo.getDocument(source.document_id)?.course_id !== courseId) throw httpError(400, `The ${what} document isn't part of this course.`);
    return source;
  }

  create(courseId: string, body: { problemSourceId?: unknown; solutionSourceId?: unknown; title?: unknown }) {
    if (!this.repo.getCourse(courseId)) throw httpError(404, "Course not found");
    const problem = this.courseSource(courseId, body.problemSourceId, "problem");
    let solution = body.solutionSourceId ? this.courseSource(courseId, body.solutionSourceId, "solution") : null;
    // The same document for both: its solutions are found inside it (one version: the problem's).
    if (solution && solution.document_id === problem.document_id) solution = problem;
    // Same documents, same set: re-creating returns what exists (including its progress).
    const existing = this.store.findSet(courseId, problem.sha256, solution?.sha256 ?? null);
    if (existing) return setView(this.store, existing);

    const title = (typeof body.title === "string" && body.title.trim().slice(0, 200)) || documentTitle(this.repo, problem);
    const set = this.repo.tx(() => {
      const row = this.store.createSet({
        course_id: courseId,
        problem_source_id: problem.id,
        solution_source_id: solution?.id ?? null,
        problem_sha: problem.sha256,
        solution_sha: solution?.sha256 ?? null,
        title,
        key_source: solution ? "solutions" : "generated",
      });
      this.store.setLectureRole([...new Set([problem.document_id, ...(solution ? [solution.document_id] : [])])], "practice");
      return row;
    });
    this.bus.publish({ type: "practice", setId: set.id, status: "extracting", done: 0 });
    this.start(set.id);
    return setView(this.store, set);
  }

  retry(setId: string) {
    const set = this.set(setId);
    if (!this.runs.has(setId) && set.status !== "ready") {
      this.store.updateSet(setId, { status: "extracting", error: null });
      this.bus.publish({ type: "practice", setId, status: "extracting", done: this.store.problemPositions(setId).size, ...(set.progress_total !== null ? { total: set.progress_total } : {}) });
      this.start(setId);
    }
    return this.getSet(setId);
  }

  delete(setId: string) {
    const set = this.set(setId);
    this.runs.get(setId)?.controller.abort();
    const docs = [...new Set([set.problem_source_id, set.solution_source_id].flatMap((id) => (id ? [this.repo.getSource(id)!.document_id] : [])))];
    this.repo.tx(() => {
      this.store.deleteSet(setId);
      // Documents no other set uses become lectures again.
      const still = this.store.practiceDocuments(set.course_id);
      this.store.setLectureRole(docs.filter((d) => !still.has(d)), "lecture");
    });
    this.bus.publish({ type: "practice", setId, status: "deleted" });
    return { ok: true as const };
  }

  /** Course documents, and likely study-guide/solutions pairs among those not used yet. */
  candidates(courseId: string): PracticeCandidates {
    if (!this.repo.getCourse(courseId)) throw httpError(404, "Course not found");
    const used = this.store.practiceDocuments(courseId);
    const latest = this.repo.listSources(courseId).filter((s) => !s.superseded_by);
    const sources = latest.map((s) => ({ id: s.id, title: documentTitle(this.repo, s), filename: s.filename, pageCount: s.page_count, inPractice: used.has(s.document_id) }));

    // "X Solutions", "X_Solutions", "X - Answers", "X Answer Key" → X.
    const solutionFor = new Map<string, string>();
    const isSolution = new Set<string>();
    for (const s of latest) {
      const k = nameKey(s.filename);
      const m = SOLUTION_SUFFIX.exec(k);
      if (!m || k.length - m[0].length < 3) continue;
      const base = k.slice(0, -m[0].length);
      const partner = latest.find((p) => p.id !== s.id && nameKey(p.filename) === base);
      if (partner) {
        solutionFor.set(partner.id, s.id);
        isSolution.add(s.id);
      }
    }
    const suggested = latest
      .filter((s) => !used.has(s.document_id) && !isSolution.has(s.id))
      .filter((s) => solutionFor.has(s.id) || PROBLEM_LIKE.test(`${s.filename} ${documentTitle(this.repo, s)}`))
      .map((s) => {
        const solution = solutionFor.get(s.id);
        const free = solution && !used.has(this.repo.getSource(solution)!.document_id);
        return { problemSourceId: s.id, solutionSourceId: free ? solution! : null, title: documentTitle(this.repo, s) };
      });
    return { sources, suggested };
  }

  // ── Problems ──────────────────────────────────────────────────────────────

  getProblem(problemId: string) {
    let problem = this.store.getProblem(problemId);
    if (!problem) throw httpError(404, "Problem not found");
    // Lectures imported (or updated) since, or more of the set extracted: refresh where this is taught.
    const where = taughtIn(this.repo, this.store, this.store.getSet(problem.set_id)!, { position: problem.position, keywords: problem.keywords, concepts: problem.concepts.map((c) => c.name) });
    if (where.sig !== problem.taught_in_sig) {
      this.store.setTaughtIn(problem.id, where.compute(), where.sig);
      problem = this.store.getProblem(problemId)!;
    }
    const view = problemView(this.store, problem);
    if (view.steps.some((s) => s.status === "pending")) void this.processPendingGrades();
    return view;
  }

  step(stepId: string) {
    const step = this.store.getStep(stepId);
    if (!step) throw httpError(404, "Step not found");
    return step;
  }

  stepView(step: PracticeStepRow) {
    step = this.step(step.id);
    const problem = this.store.getProblem(step.problem_id)!;
    return stepView(step, this.store.attemptsForStep(step.id), stepConcepts(this.store, problem, step), this.store.getSet(problem.set_id)?.key_source, this.store.coachingForStep(step.id), new FollowUpRepo(this.repo));
  }

  /** Check the value has the shape the step's kind needs; 400 with a clear message otherwise. */
  private answerValue(step: PracticeStepRow, value: unknown): PracticeValue {
    const key = step.key;
    if (key.kind === "table") {
      if (!Array.isArray(value) || !value.every((r) => Array.isArray(r))) throw httpError(400, "A table answer must be a list of rows, each a list of cell values.");
      const rows = value as string[][];
      if (rows.every((r) => r.every((c) => !String(c).trim()))) throw httpError(400, "Fill in at least one cell, or choose “I don't know”.");
      return rows.map((r) => r.map((c) => String(c)));
    }
    if (key.kind === "choice") {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw httpError(400, "A choice answer must be a list of selected option values.");
      if (!value.length) throw httpError(400, "Select an option, or choose “I don't know”.");
      const known = new Set(normalizeOptions(key.options).map((o) => o.value));
      const unknown = value.find((v) => !known.has(v));
      if (unknown !== undefined) throw httpError(400, `“${unknown}” is not one of this step's options.`);
      if (!key.multiSelect && value.length > 1) throw httpError(400, "Select one option.");
      return value as string[];
    }
    if (typeof value !== "string") throw httpError(400, `This ${key.kind === "free" ? "explanation" : key.kind} step expects a text answer.`);
    if (!value.trim()) throw httpError(400, "Enter an answer, or choose “I don't know”.");
    return value;
  }

  attempt(stepId: string, raw: unknown) {
    const input = PracticeAnswerInput.parse(raw);
    const step = this.step(stepId);
    if (input.dontKnow) return this.dontKnow(step);
    const value = this.answerValue(step, input.value);
    const confidence = input.confidence;

    if (step.kind === "free") {
      this.store.insertAttempt({ step_id: step.id, value, dont_know: false, confidence, correct: null, score: null, cell_results: null, feedback: "", grading_status: "pending", grade: null });
      void this.processPendingGrades();
      return this.stepView(step);
    }

    let g: ReturnType<typeof gradeStep>;
    try {
      g = gradeStep(step.key, value);
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
    const a = this.repo.tx(() => {
      const a = this.store.insertAttempt({
        step_id: step.id,
        value,
        dont_know: false,
        confidence,
        correct: g!.correct,
        score: g!.score,
        cell_results: g!.cellResults ?? null,
        feedback: g!.feedback,
        grading_status: "done",
        grade: null,
      });
      this.addEvidence(step, a, g!.correct);
      return a;
    });
    if (!g!.correct) this.guide.startCoaching(step, a);
    return this.stepView(step);
  }

  /** "I don't know": an honest gap (never evidence of understanding). The key stays hidden; coaching follows. */
  private dontKnow(step: PracticeStepRow) {
    const a = this.repo.tx(() => {
      const a = this.store.insertAttempt({ step_id: step.id, value: null, dont_know: true, confidence: null, correct: null, score: null, cell_results: null, feedback: "", grading_status: "done", grade: null });
      this.addEvidence(step, a, null);
      return a;
    });
    this.guide.startCoaching(step, a);
    return this.stepView(step);
  }

  /** "Show solution": the key is shown. Recorded as an honest gap, never as evidence of understanding. */
  reveal(stepId: string) {
    const step = this.step(stepId);
    this.repo.tx(() => {
      const a = this.store.insertAttempt({ step_id: step.id, value: null, dont_know: true, confidence: null, correct: null, score: null, cell_results: null, feedback: "", grading_status: "done", grade: null, revealed: true });
      this.addEvidence(step, a, null);
    });
    return this.stepView(step);
  }

  // ── Guided practice ───────────────────────────────────────────────────────

  /** Set aside a step without inventing an answer, exposing the key or changing evidence. */
  skip(stepId: string) {
    const step = this.step(stepId);
    if (!["correct", "revealed"].includes(this.stepView(step).status)) this.store.setSkipped(stepId, true);
    const problem = this.store.getProblem(step.problem_id)!;
    const view = this.stepView(step);
    this.bus.publish({ type: "practice", setId: problem.set_id, problemId: problem.id, stepId, status: view.status });
    return view;
  }

  /** Prepare (or retry) the problem's warm-up; returns the problem. */
  startPrimer(problemId: string) {
    this.guide.startPrimer(problemId);
    return this.getProblem(problemId);
  }

  skipPrimer(problemId: string) {
    this.guide.skipPrimer(problemId);
    return this.getProblem(problemId);
  }

  answerProbe(problemId: string, index: unknown, raw: unknown) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw httpError(404, "Warm-up question not found");
    this.guide.answerProbe(problemId, i, raw);
    return this.getProblem(problemId);
  }

  /** Retry coaching that is waiting for a provider or failed; returns the step. */
  coach(stepId: string) {
    this.guide.retryCoaching(stepId);
    return this.stepView(this.step(stepId));
  }

  answerCheck(coachingId: string, raw: unknown) {
    return this.stepView(this.guide.answerCheck(coachingId, raw));
  }

  /** "Count as correct": the learner judges their answer right; its evidence becomes a correct answer's. */
  override(attemptId: string) {
    const a = this.store.getAttempt(attemptId);
    if (!a) throw httpError(404, "Attempt not found");
    if (a.dont_know) throw httpError(400, "A revealed step has no answer to count as correct.");
    const step = this.step(a.step_id);
    if (!a.overridden) {
      this.repo.tx(() => {
        this.store.setOverridden(a.id);
        // Whether the AI grade landed before or after, nothing this attempt added stays.
        this.store.retractAttemptMisconceptions(a.id);
        if (this.isFirstAttempt(a)) {
          this.store.deleteEvidenceFor(a.id);
          this.addEvidence(step, { ...a, overridden: true }, true);
        }
      });
    }
    return this.stepView(step);
  }

  private isFirstAttempt(a: PracticeAttemptRow) {
    return this.store.attemptsForStep(a.step_id)[0]?.id === a.id;
  }

  /** Concepts a step's evidence goes to: its own, else the problem's. */
  private evidenceConcepts(step: PracticeStepRow): string[] {
    if (step.concepts.length) return step.concepts;
    return this.store.getProblem(step.problem_id)?.concepts.map((c) => c.id) ?? [];
  }

  /**
   * Evidence for a first attempt (later attempts follow a reveal of the key, so they prove
   * nothing). correct: null = "I don't know"; "partial" = a partly complete explanation.
   */
  private addEvidence(step: PracticeStepRow, a: PracticeAttemptRow, correct: boolean | null | "partial") {
    if (!this.isFirstAttempt(a)) return;
    const set = this.store.getSet(this.store.getProblem(step.problem_id)!.set_id)!;
    const at = now();
    const items: EvidenceItem[] =
      correct === "partial"
        ? [{ dimension: "explanation", delta: 0.3, at, note: "partly complete written explanation" }]
        : evidenceFromAttempt(
            { kind: step.kind === "free" ? "causal" : "application", context: "original", purpose: "check", correct, confidence: a.dont_know ? null : (a.confidence as Confidence | null), reasoning: null },
            at,
          );
    const noted = items.map((e) => ({ ...e, note: `Exam practice: ${e.note ?? ""}`.trim() }));
    for (const id of this.evidenceConcepts(step)) this.repo.addEvidence(id, set.course_id, a.id, noted);
  }

  // ── Free-text grading (async; pending while no provider is available) ─────

  /** Grade pending written answers until done or the provider stops; one run at a time. */
  processPendingGrades(): Promise<number> {
    if (this.grading) return this.grading;
    this.grading = this.gradePending()
      .catch(() => 0)
      .finally(() => (this.grading = null));
    return this.grading;
  }

  private async gradePending(): Promise<number> {
    let done = 0;
    const tried = new Set<string>();
    for (;;) {
      const a = this.store.pendingGrades().find((x) => !tried.has(x.id));
      if (!a) return done;
      tried.add(a.id);
      const step = this.store.getStep(a.step_id);
      if (!step || step.key.kind !== "free") continue;
      const problem = this.store.getProblem(step.problem_id)!;
      let grade: PracticeGrade;
      try {
        grade = await this.gen.run("grade_practice", {
          problem: { title: problem.title, intro: problem.intro },
          step: { label: step.label, prompt: step.prompt },
          keyIdeas: step.key.keyIdeas,
          modelAnswer: step.key.modelAnswer,
          answer: a.value,
        });
      } catch (e) {
        if (e instanceof ProviderError && e.code === "invalid_response") {
          this.store.setGrade(a.id, { correct: null, score: null, grading_status: "failed", grade: null, feedback: "This answer couldn't be graded automatically. Compare it with the model answer, and use “Count as correct” if it makes the same points." });
          this.bus.publish({ type: "practice", setId: problem.set_id, problemId: problem.id, stepId: step.id, status: "graded" });
          continue;
        }
        return done; // paused or offline: stays pending, retried later
      }
      const n = step.key.keyIdeas.length;
      const covered = [...new Set(grade.covered.filter((i) => i < n))];
      const clean = { ...grade, covered };
      const score = grade.verdict === "correct" ? 1 : grade.verdict === "incorrect" ? 0 : Math.min(0.9, Math.max(0.1, covered.length / n || 0.5));
      let coach: PracticeAttemptRow | null = null;
      this.repo.tx(() => {
        const current = this.store.getAttempt(a.id);
        if (!current) return;
        this.store.setGrade(a.id, { correct: grade.verdict === "correct", score, feedback: grade.feedback, grading_status: "done", grade: clean });
        if (current.overridden) return; // the learner already counted it as correct: no evidence, no misconception
        if (grade.verdict !== "correct") coach = current;
        this.addEvidence(step, current, grade.verdict === "partial" ? "partial" : grade.verdict === "correct");
        // Like evidence, only a first attempt counts: later ones follow a reveal of the key.
        const concept = this.evidenceConcepts(step)[0];
        if (grade.misconception && grade.verdict !== "correct" && concept && this.isFirstAttempt(current)) {
          this.store.recordAttemptMisconception(current.id, concept, grade.misconception.label, grade.misconception.description, current.confidence, current.created_at);
        }
      });
      done++;
      if (coach) this.guide.startCoaching(step, this.store.getAttempt((coach as PracticeAttemptRow).id)!);
      this.bus.publish({ type: "practice", setId: problem.set_id, problemId: problem.id, stepId: step.id, status: "graded" });
    }
  }

  // ── Learning the concept behind a problem ─────────────────────────────────

  /** Start (or resume) a focused lesson on a concept the problem needs: the weakest one by default. */
  async learn(problemId: string, conceptId?: unknown): Promise<{ lessonId: string }> {
    const problem = this.store.getProblem(problemId);
    if (!problem) throw httpError(404, "Problem not found");
    const set = this.store.getSet(problem.set_id)!;
    let target: string | undefined;
    if (conceptId !== undefined && conceptId !== null && conceptId !== "") {
      if (typeof conceptId !== "string" || !this.repo.getConcept(conceptId)) throw httpError(400, "Unknown concept");
      target = conceptId;
    } else {
      const rank = (id: string) => {
        const m = this.engine.mastery(id, "central");
        const base = { needs_review: 0, developing: 1, not_assessed: 2, demonstrated: 3 }[m.status];
        return base * 10 - Object.values(m.dimensions).filter((d) => d === "negative").length;
      };
      target = [...problem.concepts].sort((a, b) => rank(a.id) - rank(b.id))[0]?.id;
    }
    if (!target) throw httpError(400, "This problem has no concepts to learn.");
    const name = this.repo.getConcept(target)!.name;
    const objective = `${name}, as needed for problem ${problem.number} (${problem.title}) of ${set.title}`;
    const open = this.repo.listLessons().find((l) => !l.state.complete && l.objective === objective && l.course_id === set.course_id);
    if (open) return { lessonId: open.id };
    return { lessonId: (await this.engine.startObjectiveLesson(objective, set.course_id)).id };
  }
}

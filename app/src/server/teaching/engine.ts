// Teaching engine: executes planner actions, calls the AI only to produce content,
// and persists everything (blocks, attempts, evidence, misconceptions, position) in
// transactions. Generated content is committed only after it completes and validates.
import { hash, type GenerateOptions, type Generator } from "../ai/generate.ts";
import { PROMPT_VERSION } from "../ai/prompts.ts";
import { pageSpan, provenanceFor, validateRefs } from "../alignment/refs.ts";
import type { LessonRow, QuestionRow, Repo, SourceRow } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import { prerequisiteChain, upsertConcepts, type PlannedConcept } from "../graph/concepts.ts";
import { grade, hiddenOptionReference, normalizeOptions, optionShapeProblem, resolveCorrect, seededRandom, shuffle } from "../../shared/grading.ts";
import { computeMastery, evidenceFromAttempt } from "../../shared/mastery.ts";
import {
  AttemptInput,
  initialLessonState,
  type Block,
  type ConceptRole,
  type LessonState,
  type MasterySummary,
  type QuestionContent,
  type QuestionKind,
  type QuestionPurpose,
  type ReasoningEvaluation,
  type Confidence,
  type ExplanationContent,
  type SourceAnalysis,
  type Strategy,
} from "../../shared/schemas.ts";
import { repetitionProblem } from "../../shared/similarity.ts";
import { ProviderError } from "../providers/types.ts";
import { buildCheckpoint } from "./checkpoint.ts";
import { currentConcept, plan, shouldCheckpoint, type Action, type ConceptFacts, type HistoryEvent, type Snapshot } from "./planner.ts";
import { Prefetcher } from "./prefetch.ts";

const PAGE_CHARS = 1500;
const ANALYSIS_CHARS = 60_000;
/** Source text budget per generation request (chars), filled from the concept's pages and their neighbours. */
const EXCERPT_CHARS = { explain: 4500, question: 3000 } as const;

export class Engine {
  private locks = new Map<string, Promise<unknown>>();
  /** Repeated banner/header lines per source (sources are immutable, so this never goes stale). */
  private boilerplate = new Map<string, Set<string>>();
  /** Content prepared ahead of the learner (the next explanation or question), revealed on Continue. */
  readonly prefetch: Prefetcher;

  constructor(
    readonly repo: Repo,
    readonly gen: Generator,
    readonly bus: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.prefetch = new Prefetcher(this);
  }

  /** Lessons with a mutation queued or running (advance, answer), by count. */
  private active = new Map<string, number>();

  /** Whether the lesson is being advanced or answered right now (its next step is not settled yet). */
  isBusy(lessonId: string): boolean {
    return (this.active.get(lessonId) ?? 0) > 0;
  }

  /** Serialise all mutations of one lesson (double clicks, retries, two tabs). */
  private withLock<T>(lessonId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(lessonId) ?? Promise.resolve();
    this.active.set(lessonId, (this.active.get(lessonId) ?? 0) + 1);
    const release = () => {
      const n = (this.active.get(lessonId) ?? 1) - 1;
      if (n > 0) this.active.set(lessonId, n);
      else this.active.delete(lessonId);
    };
    const next = prev.catch(() => undefined).then(fn).finally(release);
    this.locks.set(lessonId, next.catch(() => undefined));
    return next;
  }

  // ── Analysis and lesson creation ──────────────────────────────────────────

  async analyzeLecture(lectureId: string): Promise<{ analysis: SourceAnalysis; planned: PlannedConcept[]; source: SourceRow }> {
    const lecture = this.repo.getLecture(lectureId);
    if (!lecture?.document_id) throw new Error("Lecture has no source document");
    const source = this.repo.latestSource(lecture.document_id)!;
    let analysis = this.repo.getAnalysis(source.sha256, PROMPT_VERSION.analyze_source) as SourceAnalysis | undefined;
    if (!analysis) {
      const pages = this.repo.getPages(source.id);
      const known = this.repo.listConcepts().slice(0, 80).map((c) => c.name);
      const earlier = this.repo.listLectures(lecture.course_id).filter((l) => l.position < lecture.position).map((l) => l.title);
      analysis = await this.gen.run("analyze_source", {
        title: lecture.title,
        unit: source.unit,
        pageCount: pages.length,
        pages: analysisPages(pages, this.boilerplateFor(source.id, pages)),
        knownConcepts: known,
        previousLectures: earlier,
      }, {
        lessonId: null,
        // One-time and slow (about two minutes): the lecture's title and overview are shown as they are written.
        meta: { lectureId },
        preview: { fields: ["title", "overview"] },
      });
      analysis = sanitizeAnalysis(analysis, source.page_count);
      this.repo.putAnalysis(source.sha256, PROMPT_VERSION.analyze_source, analysis);
    }
    const planned = upsertConcepts(this.repo, { courseId: lecture.course_id, lectureId, concepts: analysis.concepts, learningPath: analysis.learningPath });
    return { analysis, planned, source };
  }

  /** Open (or resume) the lesson for a lecture. */
  async startLectureLesson(lectureId: string): Promise<LessonRow> {
    const existing = this.repo.listLessons().find((l) => l.lecture_id === lectureId && !l.state.complete);
    if (existing) return existing;
    const lecture = this.repo.getLecture(lectureId)!;
    const { analysis, planned, source } = await this.analyzeLecture(lectureId);
    const firstPage = planned.find((p) => p.pages.length)?.pages[0] ?? 1;
    const state = initialLessonState(planned.map((p) => p.conceptId), { sourceId: source.id, page: firstPage }, Object.fromEntries(planned.map((p) => [p.conceptId, p.role])));
    state.reviewQueue = this.dueReviewFor(planned.map((p) => p.conceptId));
    const lesson = this.repo.createLesson({ courseId: lecture.course_id, lectureId, sourceId: source.id, objective: null, title: analysis.title || lecture.title, state });
    this.repo.logEvent(lesson.id, "lesson_started", { lectureId });
    return lesson;
  }

  async startObjectiveLesson(objective: string, courseId: string | null): Promise<LessonRow> {
    const planOut = await this.gen.run("plan_objective", { objective, knownConcepts: this.knownConceptNames() }, { cacheKey: ["objective", objective.trim().toLowerCase()] });
    const planned = upsertConcepts(this.repo, { courseId, lectureId: null, concepts: planOut.concepts, learningPath: planOut.learningPath });
    const state = initialLessonState(planned.map((p) => p.conceptId), null, Object.fromEntries(planned.map((p) => [p.conceptId, p.role])));
    state.overviewShown = true;
    state.reviewQueue = this.dueReviewFor(planned.map((p) => p.conceptId));
    const lesson = this.repo.createLesson({ courseId, lectureId: null, sourceId: null, objective, title: planOut.title, state });
    this.repo.appendBlock({
      lessonId: lesson.id,
      type: "plan",
      conceptId: null,
      payload: { title: planOut.title, overview: planOut.overview, path: planned.map((p) => ({ conceptId: p.conceptId, name: p.name, role: p.role })) },
      provenance: "supplementary",
    });
    this.repo.logEvent(lesson.id, "lesson_started", { objective });
    return lesson;
  }

  private knownConceptNames(): { name: string; status: string }[] {
    return this.repo
      .conceptsWithEvidence()
      .map((id) => ({ name: this.repo.getConcept(id)!.name, status: this.mastery(id, "background").status }))
      .slice(0, 60);
  }

  /** Previously learned prerequisites of this material that are due for review. */
  private dueReviewFor(path: string[]): string[] {
    const related = new Set<string>();
    for (const id of path) {
      related.add(id);
      for (const p of prerequisiteChain(this.repo, id, 3)) related.add(p.id);
    }
    return [...related]
      .filter((id) => this.mastery(id, "background").status === "needs_review" && this.repo.questionsForConcept(id).length > 0)
      .slice(0, 3);
  }

  // ── Facts for the planner ─────────────────────────────────────────────────

  mastery(conceptId: string, role: ConceptRole): MasterySummary {
    return computeMastery(conceptId, this.repo.evidenceFor(conceptId), {
      central: role === "central",
      activeMisconceptions: this.repo.activeMisconceptions(conceptId),
      now: this.now(),
    });
  }

  facts(lesson: LessonRow, conceptId: string): ConceptFacts {
    const concept = this.repo.getConcept(conceptId)!;
    const role = lesson.state.roles[conceptId] ?? "background";
    const blocks = this.repo.listBlocks(lesson.id).filter((b) => b.conceptId === conceptId);
    const history: HistoryEvent[] = [];
    for (const b of blocks) {
      if (b.type === "explanation") history.push({ type: "explanation", strategy: b.payload.strategy as Strategy });
      if (b.type === "question") {
        const q = this.repo.getQuestion(b.payload.questionId)!;
        for (const a of this.repo.attemptsForQuestion(q.id).filter((x) => x.lesson_id === lesson.id)) {
          history.push({ type: "attempt", correct: a.correct, confidence: a.confidence, purpose: q.purpose, kind: q.kind, context: q.context, reasoning: a.reasoning?.verdict ?? null });
        }
      }
    }
    const active = this.repo.activeMisconceptions(conceptId);
    return {
      id: conceptId,
      name: concept.name,
      role,
      mastery: this.mastery(conceptId, role),
      activeMisconceptions: active.map((m) => m.label),
      misconceptionText: active.map((m) => `${m.label} ${m.description ?? ""}`).join(" "),
      definition: concept.definition,
      prerequisites: this.repo.prerequisitesOf(conceptId),
      history,
      failedStrategies: this.repo.strategiesFor(conceptId).filter((s) => s.outcome === "failed").map((s) => s.strategy),
      hasStoredReviewQuestion: this.repo.questionsForConcept(conceptId).length > 0,
    };
  }

  snapshot(lesson: LessonRow): Snapshot {
    const cache = new Map<string, ConceptFacts>();
    return {
      state: lesson.state,
      hasSource: Boolean(lesson.source_id),
      facts: (id) => {
        if (!cache.has(id)) cache.set(id, this.facts(lesson, id));
        return cache.get(id)!;
      },
    };
  }

  nextAction(lessonId: string): Action {
    return plan(this.snapshot(this.repo.getLesson(lessonId)!));
  }

  // ── Advancing the lesson ──────────────────────────────────────────────────

  /**
   * Run planner actions until the learner has something to respond to (a question)
   * or two content blocks were produced. If generation fails, nothing from the
   * failed step is committed; earlier steps in this call remain (they completed).
   * `pauseAfterExplanation`: stop once an explanation is committed (its question is then prepared
   * in the background and revealed by the next Continue; see Prefetcher).
   */
  advance(lessonId: string, opts: { pauseAfterExplanation?: boolean } = {}): Promise<{ created: Block[]; action: Action["type"] }> {
    return this.withLock(lessonId, async () => {
      const created: Block[] = [];
      let lastAction: Action["type"] = "await_answer";
      let content = 0;
      for (let guard = 0; guard < 12; guard++) {
        const lesson = this.repo.getLesson(lessonId);
        if (!lesson) throw new Error("Lesson not found");
        const action = plan(this.snapshot(lesson));
        lastAction = action.type;
        if (action.type === "await_answer" || (action.type === "complete" && lesson.state.complete)) break;
        const blocks = await this.execute(lesson, action);
        created.push(...blocks);
        // Each committed block is shown right away (e.g. the explanation while its question is being written).
        if (blocks.length) this.bus.publish({ type: "lesson", lessonId });
        if (blocks.some((b) => b.type === "question")) break;
        if (opts.pauseAfterExplanation && blocks.some((b) => b.type === "explanation")) break;
        if (blocks.some((b) => b.type === "explanation" || b.type === "overview")) content++;
        if (content >= 2 || action.type === "complete") break;
      }
      this.bus.publish({ type: "lesson", lessonId });
      return { created, action: lastAction };
    });
  }

  private save(lesson: LessonRow, state: LessonState) {
    lesson.version = this.repo.saveLessonState(lesson.id, state, lesson.version);
    lesson.state = state;
  }

  private async execute(lesson: LessonRow, action: Action): Promise<Block[]> {
    const state: LessonState = structuredClone(lesson.state);
    const repo = this.repo;
    switch (action.type) {
      case "overview": {
        const source = repo.getSource(lesson.source_id!)!;
        const analysis = (repo.getAnalysis(source.sha256, PROMPT_VERSION.analyze_source) ?? (await this.analyzeLecture(lesson.lecture_id!)).analysis) as SourceAnalysis;
        const lectureTitle = this.lectureTitle(lesson);
        const structure = analysis.structure.map((s) => ({
          ...s,
          ref: validateRefs(repo, source.id, [{ page: s.pageStart, pageEnd: s.pageEnd }], lectureTitle).refs[0] ?? null,
        }));
        const path = state.path.map((id) => {
          const lc = lesson.lecture_id ? repo.lectureConcepts(lesson.lecture_id).find((x) => x.concept_id === id) : undefined;
          const span = pageSpan(lc?.pages ?? []);
          return {
            conceptId: id,
            name: repo.getConcept(id)!.name,
            role: state.roles[id] ?? "background",
            ref: span ? validateRefs(repo, source.id, [span], lectureTitle).refs[0] ?? null : null,
          };
        });
        const refs = structure.map((s) => s.ref).filter((r): r is NonNullable<typeof r> => Boolean(r));
        return repo.tx(() => {
          const block = repo.appendBlock({
            lessonId: lesson.id,
            type: "overview",
            conceptId: null,
            payload: { ...analysis, structure, path, concepts: undefined },
            refs,
            provenance: provenanceFor(refs),
          });
          state.overviewShown = true;
          this.save(lesson, state);
          return [block];
        });
      }

      case "review": {
        const stored = repo.questionsForConcept(action.conceptId);
        const askedHere = new Set(repo.listBlocks(lesson.id).filter((b) => b.type === "question").map((b) => b.payload.sourceQuestionId ?? b.payload.questionId));
        const pick = stored.filter((q) => !askedHere.has(q.id) && q.purpose !== "review").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        state.reviewQueue = state.reviewQueue.slice(1);
        if (!pick) {
          this.save(lesson, state);
          return [];
        }
        return repo.tx(() => {
          const blocks: Block[] = [];
          if (!repo.listBlocks(lesson.id).some((b) => b.type === "review")) {
            blocks.push(repo.appendBlock({ lessonId: lesson.id, type: "review", conceptId: null, payload: { concepts: [action.conceptId, ...state.reviewQueue].map((id) => ({ conceptId: id, name: repo.getConcept(id)!.name })) }, provenance: "system" }));
          }
          const { block } = this.insertQuestion(lesson, action.conceptId, { ...pick, refs: [], multiSelect: pick.multi_select, correct: pick.correct }, "review", pick.id);
          blocks.push(block);
          state.pendingQuestionId = block.payload.questionId;
          this.save(lesson, state);
          return blocks;
        });
      }

      case "probe":
      case "check": {
        const purpose: QuestionPurpose = action.type === "probe" ? "probe" : action.purpose;
        const context = action.type === "probe" ? "original" : action.context;
        const content = await this.generateQuestion(lesson, action.conceptId, action.kind, context, action.difficulty, purpose);
        return repo.tx(() => {
          const { block } = this.insertQuestion(lesson, action.conceptId, content, purpose);
          state.pendingQuestionId = block.payload.questionId;
          state.conceptId = action.conceptId;
          this.save(lesson, state);
          return [block];
        });
      }

      case "explain": {
        const content = await this.generateExplanation(lesson, action);
        const refs = validateRefs(repo, lesson.source_id, content.refs, this.lectureTitle(lesson)).refs;
        return repo.tx(() => {
          const { refs: _r, ...rest } = content;
          const block = repo.appendBlock({
            lessonId: lesson.id,
            type: "explanation",
            conceptId: action.conceptId,
            payload: { ...rest, purpose: action.purpose, reason: action.reason },
            refs,
            provenance: provenanceFor(refs),
          });
          repo.logStrategy(action.conceptId, lesson.id, content.strategy, block.id);
          state.conceptId = action.conceptId;
          state.justReturned = null;
          const page = this.conceptPages(lesson, action.conceptId)[0] ?? refs[0]?.page;
          if (page && lesson.source_id) state.sourcePosition = { sourceId: lesson.source_id, page };
          this.save(lesson, state);
          return [block];
        });
      }

      case "detour": {
        const from = repo.getConcept(action.fromConceptId)!;
        const to = repo.getConcept(action.conceptId)!;
        const returnPage = applyDetour(state, action);
        return repo.tx(() => {
          const block = repo.appendBlock({
            lessonId: lesson.id,
            type: "detour_start",
            conceptId: action.conceptId,
            payload: {
              conceptName: to.name,
              fromConceptId: from.id,
              fromName: from.name,
              reason: action.reason,
              role: state.roles[action.conceptId],
              returnLabel: this.positionLabel(lesson, returnPage),
              depth: state.detours.length,
            },
            provenance: "system",
          });
          this.save(lesson, state);
          repo.logEvent(lesson.id, "detour_start", { from: from.id, to: to.id });
          return [block];
        });
      }

      case "return": {
        const frame = this.applyReturn(lesson, state);
        return repo.tx(() => {
          const block = repo.appendBlock({
            lessonId: lesson.id,
            type: "detour_end",
            conceptId: frame.conceptId,
            payload: {
              conceptName: repo.getConcept(frame.conceptId)!.name,
              returningTo: repo.getConcept(frame.fromConceptId)!.name,
              returnLabel: this.positionLabel(lesson, frame.returnTo.page),
              status: this.mastery(frame.conceptId, state.roles[frame.conceptId] ?? "background").status,
            },
            provenance: "system",
          });
          this.save(lesson, state);
          repo.logEvent(lesson.id, "detour_end", { concept: frame.conceptId });
          return [block];
        });
      }

      case "stuck": {
        state.deferred.push(action.conceptId);
        const blocks: Block[] = [];
        return repo.tx(() => {
          blocks.push(
            repo.appendBlock({
              lessonId: lesson.id,
              type: "notice",
              conceptId: action.conceptId,
              payload: {
                kind: "deferred",
                message: `${action.reason}. Rather than let this one concept take over the session, it's marked for review and we'll continue. It will come back in a later review with a fresh approach.`,
              },
              provenance: "system",
            }),
          );
          if (state.detours.length) {
            const frame = state.detours.pop()!;
            state.streakResets[frame.fromConceptId] = this.facts(lesson, frame.fromConceptId).history.filter((h) => h.type === "attempt").length;
            state.justReturned = { conceptId: frame.fromConceptId, fromDetour: frame.conceptId };
            state.conceptId = frame.fromConceptId;
            blocks.push(
              repo.appendBlock({
                lessonId: lesson.id,
                type: "detour_end",
                conceptId: frame.conceptId,
                payload: { conceptName: repo.getConcept(frame.conceptId)!.name, returningTo: repo.getConcept(frame.fromConceptId)!.name, returnLabel: this.positionLabel(lesson, frame.returnTo.page), status: "developing" },
                provenance: "system",
              }),
            );
          } else {
            blocks.push(...this.advancePath(lesson, state, action.conceptId));
          }
          this.save(lesson, state);
          return blocks;
        });
      }

      case "advance": {
        return repo.tx(() => {
          const blocks = this.advancePath(lesson, state, currentConcept(state)!);
          this.save(lesson, state);
          return blocks;
        });
      }

      case "checkpoint": {
        return repo.tx(() => {
          const block = this.checkpoint(lesson, state);
          this.save(lesson, state);
          return [block];
        });
      }

      case "complete": {
        return repo.tx(() => {
          state.complete = true;
          const block = repo.appendBlock({
            lessonId: lesson.id,
            type: "notice",
            conceptId: null,
            payload: { kind: "complete", message: "You've worked through every concept in this lesson. Review questions will come back on a spaced schedule." },
            provenance: "system",
          });
          this.save(lesson, state);
          repo.logEvent(lesson.id, "lesson_complete", {});
          return [block];
        });
      }

      case "await_answer":
        return [];
    }
  }

  /** Move past a finished concept on the path; place a checkpoint at major transitions. */
  private advancePath(lesson: LessonRow, state: LessonState, conceptId: string): Block[] {
    return this.stepPath(lesson, state, conceptId) ? [this.checkpoint(lesson, state)] : [];
  }

  /** The state change of moving past a concept on the path. Returns whether a checkpoint is due. */
  private stepPath(lesson: LessonRow, state: LessonState, conceptId: string): boolean {
    if (!state.sinceCheckpoint.includes(conceptId)) state.sinceCheckpoint.push(conceptId);
    state.pathIndex += 1;
    state.conceptId = state.path[state.pathIndex] ?? null;
    const next = state.conceptId;
    if (next && lesson.source_id) {
      const page = this.conceptPages(lesson, next)[0];
      if (page) state.sourcePosition = { sourceId: lesson.source_id, page };
    }
    return shouldCheckpoint(state, state.pathIndex >= state.path.length);
  }

  /** The state change of returning from a detour (pops its frame). */
  private applyReturn(lesson: LessonRow, state: LessonState) {
    const frame = state.detours.pop()!;
    state.streakResets[frame.fromConceptId] = this.facts(lesson, frame.fromConceptId).history.filter((h) => h.type === "attempt").length;
    state.justReturned = { conceptId: frame.fromConceptId, fromDetour: frame.conceptId };
    state.conceptId = frame.fromConceptId;
    if (frame.returnTo.page && lesson.source_id) state.sourcePosition = { sourceId: lesson.source_id, page: frame.returnTo.page };
    return frame;
  }

  /**
   * Look-ahead for prefetching: apply a move that generates nothing (overview, detour, return,
   * advance) to `lesson.state` in memory only, exactly as executing it would. Returns false for
   * moves it can't simulate. Nothing is written; a wrong guess only means the prepared content is
   * not used (the reveal compares the real generation input with the prepared one).
   */
  simulate(lesson: LessonRow, action: Action): boolean {
    const state = lesson.state;
    switch (action.type) {
      case "overview":
        state.overviewShown = true;
        return true;
      case "detour":
        applyDetour(state, action);
        return true;
      case "return":
        if (!state.detours.length) return false;
        this.applyReturn(lesson, state);
        return true;
      case "advance": {
        const cur = currentConcept(state);
        if (!cur) return false;
        if (this.stepPath(lesson, state, cur)) {
          state.sinceCheckpoint = [];
          state.checkpointCount += 1;
        }
        return true;
      }
      default:
        return false;
    }
  }

  private checkpoint(lesson: LessonRow, state: LessonState): Block {
    const payload = buildCheckpoint(this, lesson, state);
    state.sinceCheckpoint = [];
    state.checkpointCount += 1;
    this.repo.logEvent(lesson.id, "checkpoint", { concepts: payload.concepts.map((c) => c.conceptId) });
    return this.repo.appendBlock({ lessonId: lesson.id, type: "checkpoint", conceptId: null, payload, provenance: "system" });
  }

  // ── Content generation ────────────────────────────────────────────────────

  lectureTitle(lesson: LessonRow): string | null {
    return lesson.lecture_id ? this.repo.getLecture(lesson.lecture_id)?.title ?? null : null;
  }

  positionLabel(lesson: LessonRow, page: number | null | undefined): string | null {
    if (!page || !lesson.source_id) return null;
    const source = this.repo.getSource(lesson.source_id)!;
    const t = this.lectureTitle(lesson);
    return `${t ? `${t}, ` : ""}${source.unit} ${page}`;
  }

  conceptPages(lesson: LessonRow, conceptId: string): number[] {
    if (!lesson.lecture_id) return [];
    return this.repo.lectureConcepts(lesson.lecture_id).find((c) => c.concept_id === conceptId)?.pages ?? [];
  }

  private boilerplateFor(sourceId: string, pages: string[]): Set<string> {
    let lines = this.boilerplate.get(sourceId);
    if (!lines) this.boilerplate.set(sourceId, (lines = boilerplateLines(pages)));
    return lines;
  }

  /** The concept's source text, filled to a budget from its mapped pages and their neighbours (see excerptPages). */
  sourceExcerpt(lesson: LessonRow, conceptId: string, budget: number) {
    if (!lesson.source_id) return null;
    const mapped = this.conceptPages(lesson, conceptId);
    if (!mapped.length) return null;
    const source = this.repo.getSource(lesson.source_id)!;
    const all = this.repo.getPages(source.id);
    const pages = excerptPages(all, mapped, budget, this.boilerplateFor(source.id, all));
    if (pages.length) return { unit: source.unit, pages };
    // Only figures/handwriting around this concept: say so, so the model neither invents slide content nor cites it.
    return { unit: source.unit, pages, note: `The ${source.unit}s for this concept contain no extractable text (figures or handwriting), so there is nothing to quote: leave "refs" empty and don't describe what they show.` };
  }

  conceptInput(lesson: LessonRow, conceptId: string) {
    const c = this.repo.getConcept(conceptId)!;
    const ctx = lesson.course_id ? this.repo.contextsFor(conceptId).find((x) => x.course_id === lesson.course_id) : undefined;
    return { name: c.name, definition: c.definition, ...(ctx?.interpretation ? { interpretation: ctx.interpretation } : {}) };
  }

  private recentAttempts(conceptId: string, n = 3) {
    return this.repo
      .attemptsForConcept(conceptId)
      .slice(-n)
      .map((a) => ({
        question: a.question.stem,
        chose: a.dont_know ? "I don't know" : a.selected.map((v) => a.question.options.find((o) => o.value === v)?.label ?? v).join("; "),
        correct: a.correct,
        confidence: a.confidence,
        ...(a.note ? { note: a.note } : {}),
      }));
  }

  private async generateExplanation(lesson: LessonRow, action: Extract<Action, { type: "explain" }>): Promise<ExplanationContent> {
    const req = this.explanationRequest(lesson, action);
    // Prepared ahead (prefetch) with exactly this input: use it (waiting for it if still being written).
    const ready = await this.prefetch.claim(lesson.id, req.key);
    if (ready) return ready as ExplanationContent;
    return this.gen.run("explain", req.input, req.opts);
  }

  /** The explanation generation for a move: its input, options, and a key identifying both. */
  explanationRequest(lesson: LessonRow, action: Extract<Action, { type: "explain" }>) {
    const f = this.facts(lesson, action.conceptId);
    const state = lesson.state;
    const frame = state.detours[state.detours.length - 1];
    const known = this.repo
      .conceptsWithEvidence()
      .filter((id) => id !== action.conceptId && this.mastery(id, "background").status === "demonstrated")
      .map((id) => this.repo.getConcept(id)!.name)
      .slice(0, 12);
    const tried = f.history.filter((h): h is { type: "explanation"; strategy: Strategy } => h.type === "explanation").map((h) => h.strategy);
    const learnerSpecific = action.purpose !== "introduce" || f.activeMisconceptions.length > 0;
    const input = {
      concept: this.conceptInput(lesson, action.conceptId),
      strategy: action.strategy,
      purpose: action.purpose,
      avoidStrategies: [...new Set([...tried, ...f.failedStrategies])],
      learner: {
        known,
        misconceptions: this.repo.activeMisconceptions(action.conceptId).map((m) => ({ label: m.label, description: m.description })),
        recentAttempts: learnerSpecific ? this.recentAttempts(action.conceptId) : [],
      },
      connectTo: f.prerequisites.map((p) => this.repo.getConcept(p)!.name).slice(0, 4),
      ...(frame && action.purpose === "detour" ? { detourReason: frame.reason, detourFor: this.repo.getConcept(frame.fromConceptId)!.name } : {}),
      ...(action.purpose === "return" && state.justReturned ? { connectTo: [this.repo.getConcept(state.justReturned.fromDetour)!.name] } : {}),
      source: this.sourceExcerpt(lesson, action.conceptId, EXCERPT_CHARS.explain),
    };
    const sourceSha = lesson.source_id ? this.repo.getSource(lesson.source_id)!.sha256 : null;
    const cacheKey = learnerSpecific ? undefined : ["explain", this.repo.getConcept(action.conceptId)!.slug, action.strategy, action.purpose, sourceSha];
    const opts: GenerateOptions<ExplanationContent> = {
      lessonId: lesson.id,
      // The learner reads the explanation as it is written; the block is committed only once it validates.
      meta: { conceptId: action.conceptId },
      preview: { fields: ["title", "body", "workedExample"] },
      // Reuse plain introductions across lessons; never cache learner-specific remediation.
      cacheKey,
    };
    return { task: "explain" as const, input, opts, key: hash(["explain", lesson.id, input, cacheKey ?? null]) };
  }

  private async generateQuestion(lesson: LessonRow, conceptId: string, kind: QuestionKind, context: "original" | "novel", difficulty: number, purpose: QuestionPurpose) {
    const req = this.questionRequest(lesson, conceptId, kind, context, difficulty, purpose);
    const ready = (await this.prefetch.claim(lesson.id, req.key)) as QuestionContent | null;
    // Prepared with the same input; its checks run again against the state as it is now.
    if (ready && !req.opts.check!(ready)) return ready;
    return this.gen.run("question", req.input, req.opts);
  }

  /**
   * The question generation for a move: input (with the anti-repetition context), options (with the
   * deterministic checks), and a key identifying both. `explanation` stands in for the latest
   * explanation block when it is not committed yet (prefetch look-ahead).
   */
  questionRequest(lesson: LessonRow, conceptId: string, kind: QuestionKind, context: "original" | "novel", difficulty: number, purpose: QuestionPurpose, explanation?: { body: string; workedExample?: string | null }) {
    const prior = this.repo.questionsForConcept(conceptId).map((q) => ({ text: `${q.stem} ${q.options.map((o) => o.label).join(" ")}`, scenario: q.scenario, stem: q.stem }));
    const lastExplanation = explanation ? { payload: explanation } : [...this.repo.listBlocks(lesson.id)].reverse().find((b) => b.type === "explanation" && b.conceptId === conceptId);
    const explanationText = lastExplanation ? [lastExplanation.payload.body, lastExplanation.payload.workedExample ?? ""].join("\n") : null;
    const input = {
      concept: this.conceptInput(lesson, conceptId),
      kind,
      context,
      purpose,
      difficulty,
      avoid: prior.slice(-12).map((p) => ({ stem: p.stem, scenario: p.scenario })),
      recentExplanation: explanationText,
      targetMisconceptions: this.repo.activeMisconceptions(conceptId).map((m) => m.label),
      source: context === "original" ? this.sourceExcerpt(lesson, conceptId, EXCERPT_CHARS.question) : null,
    };
    const opts: GenerateOptions<QuestionContent> = {
      lessonId: lesson.id,
      meta: { conceptId },
      // The stem is shown as it is written (it never contains the answer); options appear once validated.
      preview: { fields: ["stem"] },
      check: (q) => {
        try {
          const options = normalizeOptions(q.options);
          if (options.length < 2) return "needs at least two options";
          const correct = resolveCorrect(q.correct, options);
          if (!q.multiSelect && correct.length !== 1) return "single-select questions need exactly one correct value";
          const shape = optionShapeProblem(options, correct);
          if (shape) return shape;
          const hidden = hiddenOptionReference(q.explanation, options);
          if (hidden) return `explanation ${hidden}`;
          const hiddenData = scenarioDataProblem(q);
          if (hiddenData) return hiddenData;
        } catch (e) {
          return (e as Error).message;
        }
        return repetitionProblem({ text: `${q.stem} ${q.options.map((o) => o.label).join(" ")}`, scenario: q.scenario }, prior, explanationText);
      },
    };
    return { task: "question" as const, input, opts, key: hash(["question", lesson.id, input]) };
  }

  private insertQuestion(lesson: LessonRow, conceptId: string, q: Omit<QuestionContent, "multiSelect"> & { multiSelect?: boolean }, purpose: QuestionPurpose, sourceQuestionId?: string) {
    const options = normalizeOptions(q.options);
    const correct = resolveCorrect(q.correct, options);
    const row = this.repo.insertQuestion({
      lesson_id: lesson.id,
      block_id: null,
      concept_id: conceptId,
      purpose,
      kind: q.kind,
      context: q.context,
      scenario: q.scenario,
      stem: q.stem,
      options: [],
      correct,
      multi_select: Boolean(q.multiSelect),
      explanation: q.explanation,
      rubric: q.rubric,
      difficulty: q.difficulty,
    });
    // Shuffle once, deterministically per question, and store the display order.
    const shuffled = shuffle(options, seededRandom(row.id));
    this.repo.db.prepare("UPDATE questions SET options_json = ? WHERE id = ?").run(JSON.stringify(shuffled), row.id);
    const refs = validateRefs(this.repo, lesson.source_id, q.refs ?? [], this.lectureTitle(lesson)).refs;
    const block = this.repo.appendBlock({
      lessonId: lesson.id,
      type: "question",
      conceptId,
      payload: { questionId: row.id, ...(sourceQuestionId ? { sourceQuestionId } : {}) },
      refs,
      provenance: provenanceFor(refs),
    });
    this.repo.setQuestionBlock(row.id, block.id);
    return { block, question: { ...row, options: shuffled } as QuestionRow };
  }

  // ── Answering ─────────────────────────────────────────────────────────────

  answer(lessonId: string, questionId: string, raw: unknown): Promise<{ feedback: Block; reused: boolean }> {
    return this.withLock(lessonId, async () => {
      const input = AttemptInput.parse(raw);
      const lesson = this.repo.getLesson(lessonId);
      if (!lesson) throw new Error("Lesson not found");
      const q = this.repo.getQuestion(questionId);
      if (!q || q.lesson_id !== lessonId) throw new Error("Question not found in this lesson");

      // Idempotent: a retried submission returns the recorded result instead of recording twice.
      const prior = this.repo.attemptsForQuestion(q.id).find((a) => a.lesson_id === lessonId);
      if (prior) {
        const fb = this.repo.listBlocks(lessonId).find((b) => b.type === "feedback" && b.payload.attemptId === prior.id);
        if (fb) return { feedback: fb, reused: true };
      }
      if (lesson.state.pendingQuestionId !== q.id) throw new Error("This question is no longer awaiting an answer");

      const g = grade(q.options, q.correct, { selected: input.selected, dontKnow: input.dontKnow });
      const note = input.note?.trim() || null;
      let reasoning: ReasoningEvaluation | null = null;
      let reasoningStatus: "none" | "pending" | "done" | "failed" = note ? "pending" : "none";
      if (note) {
        try {
          reasoning = await this.evaluateReasoning(lessonId, q, input.selected, input.dontKnow, g.correct, note);
          reasoningStatus = "done";
        } catch (e) {
          // Provider unavailable: grade the selection now, evaluate the reasoning later.
          reasoningStatus = e instanceof ProviderError && (e.code === "invalid_response") ? "failed" : "pending";
        }
      }
      return this.recordAttempt(lesson, q, { ...input, note }, g, reasoning, reasoningStatus);
    });
  }

  private async evaluateReasoning(lessonId: string | null, q: QuestionRow, selected: string[], dontKnow: boolean, correct: boolean | null, note: string) {
    return this.gen.run(
      "evaluate_reasoning",
      {
        question: { stem: q.stem, options: q.options.map((o) => ({ value: o.value, label: o.label })) },
        correctValues: q.correct,
        selected: dontKnow ? ["I don't know"] : selected,
        selectionWasCorrect: correct,
        note,
        rubric: q.rubric,
      },
      { lessonId },
    );
  }

  private recordAttempt(
    lesson: LessonRow,
    q: QuestionRow,
    input: { selected: string[]; dontKnow: boolean; confidence: AttemptInput["confidence"]; note: string | null },
    g: ReturnType<typeof grade>,
    reasoning: ReasoningEvaluation | null,
    reasoningStatus: "none" | "pending" | "done" | "failed",
  ) {
    const repo = this.repo;
    const at = this.now().toISOString();
    return repo.tx(() => {
      const attempt = repo.insertAttempt({
        question_id: q.id,
        lesson_id: lesson.id,
        selected: input.dontKnow ? [] : input.selected,
        dont_know: input.dontKnow,
        confidence: input.dontKnow ? null : input.confidence,
        note: input.note,
        correct: g.correct,
        misconceptions: g.misconceptions,
        reasoning_status: reasoningStatus,
        reasoning,
        // The answer's own time, shared with its evidence, misconceptions and resolutions.
        created_at: at,
      });
      const role = lesson.state.roles[q.concept_id] ?? "background";
      const evidence = evidenceFromAttempt(
        { kind: q.kind, context: q.context, purpose: q.purpose, correct: g.correct, confidence: attempt.confidence, reasoning: reasoning?.verdict ?? null },
        at,
      );
      repo.addEvidence(q.concept_id, lesson.course_id, attempt.id, evidence);

      // One answer, one diagnosis: the reasoning evaluator's label (it read the learner's own words)
      // when it names one, otherwise the misconception behind the distractor chosen.
      const recorded: string[] = [];
      const fromReasoning = reasoningMisconception(reasoning, g.correct);
      if (fromReasoning) {
        repo.recordMisconception(q.concept_id, fromReasoning.label, fromReasoning.description, attempt.confidence, { kind: "lesson", id: attempt.id }, at);
        recorded.push(fromReasoning.label);
      } else {
        for (const m of new Set(g.misconceptions)) {
          repo.recordMisconception(q.concept_id, m, null, attempt.confidence, { kind: "lesson", id: attempt.id }, at);
          recorded.push(m);
        }
      }
      // Resolution: a correct, not-guessed answer to a question that offered the
      // misconception as a distractor, with no flawed reasoning, resolves it.
      if (g.correct === true && attempt.confidence !== "guess" && reasoning?.verdict !== "flawed") {
        const targeted = new Set(q.options.map((o) => o.misconception).filter(Boolean));
        const active = repo.activeMisconceptions(q.concept_id);
        const recentSure = repo.attemptsForConcept(q.concept_id).slice(-2).every((a) => a.correct === true && a.confidence === "sure");
        for (const m of active) {
          if (targeted.has(m.label) || recentSure) {
            repo.resolveMisconception(q.concept_id, m.label, at, attempt.id);
          }
        }
      }
      // Was the most recent teaching strategy for this concept effective?
      if (g.correct !== null) repo.setLatestStrategyOutcome(q.concept_id, g.correct ? "worked" : "failed");

      const mastery = this.mastery(q.concept_id, role);
      const feedback = repo.appendBlock({
        lessonId: lesson.id,
        type: "feedback",
        conceptId: q.concept_id,
        payload: {
          questionId: q.id,
          attemptId: attempt.id,
          correct: g.correct,
          dontKnow: input.dontKnow,
          confidence: attempt.confidence,
          // The hint describes the option chosen, so it names the distractor's idea when there is one.
          message: feedbackMessage(g.correct, attempt.confidence, reasoning?.verdict ?? null, g.misconceptions[0] ?? recorded[0] ?? null),
          misconceptions: recorded,
          reasoning,
          reasoningStatus,
          mastery: { status: mastery.status, reasons: mastery.reasons.slice(0, 3) },
        },
        provenance: "system",
      });
      const state = structuredClone(lesson.state);
      state.pendingQuestionId = null;
      this.save(lesson, state);
      repo.logEvent(lesson.id, "answer", { questionId: q.id, correct: g.correct, confidence: attempt.confidence });
      return { feedback, reused: false };
    });
  }

  /** Evaluate written reasoning that was deferred while no provider was available. */
  async processPendingReasoning(limit = 5): Promise<number> {
    let done = 0;
    for (const a of this.repo.pendingReasoning().slice(0, limit)) {
      // Claim the attempt atomically so two concurrent callers never apply the same evaluation twice.
      if (!this.repo.claimPendingReasoning(a.id)) continue;
      const q = this.repo.getQuestion(a.question_id)!;
      let r: ReasoningEvaluation;
      try {
        r = await this.evaluateReasoning(a.lesson_id, q, a.selected, a.dont_know, a.correct, a.note ?? "");
      } catch (e) {
        if (e instanceof ProviderError && e.code === "invalid_response") this.repo.setAttemptReasoning(a.id, "failed", null);
        else this.repo.releaseReasoningClaim(a.id);
        break;
      }
      const at = this.now().toISOString();
      const applied = this.repo.tx(() => {
        // Re-check inside the transaction: only the claim holder may change evidence/misconceptions.
        if (!this.repo.finishReasoningClaim(a.id, r)) return false;
        const items =
          r.verdict === "flawed" && a.correct
            ? [{ dimension: "explanation" as const, delta: -0.8, at, note: "written reasoning (evaluated later) was flawed" }]
            : r.verdict === "sound" && a.correct
              ? [{ dimension: "explanation" as const, delta: a.confidence === "sure" ? 1 : 0.6, at, note: "sound written reasoning (evaluated later)" }]
              : [];
        this.repo.addEvidence(q.concept_id, null, a.id, items);
        // Same rule as when the reasoning is evaluated at once: its label replaces the distractor's
        // misconception that was recorded for this attempt while the evaluation was pending.
        const fromReasoning = reasoningMisconception(r, a.correct);
        // Resolutions this answer made assumed its reasoning was not flawed; now that it is (or it
        // expresses a misconception), retract them. Other resolutions keep the strict-newer rule.
        if (r.verdict === "flawed" || fromReasoning) this.repo.retractResolutionsBy(a.id);
        // The occurrence keeps the attempt's time; the ledger is keyed by the attempt, so only its
        // own distractor contributions go, whatever happened to those rows since.
        if (fromReasoning) {
          this.repo.retractMisconceptions("lesson", a.id, (label) => label === fromReasoning.label);
          // Same label already recorded for this attempt: enrich it, don't count the attempt twice.
          if (this.repo.misconceptionContributions("lesson", a.id, fromReasoning.label).length) {
            if (fromReasoning.description) this.repo.describeContribution("lesson", a.id, q.concept_id, fromReasoning.label, fromReasoning.description);
          } else this.repo.recordMisconception(q.concept_id, fromReasoning.label, fromReasoning.description, a.confidence, { kind: "lesson", id: a.id }, a.created_at);
        }
        const fb = a.lesson_id ? this.repo.listBlocks(a.lesson_id).find((b) => b.type === "feedback" && b.payload.attemptId === a.id) : undefined;
        if (fb) this.repo.updateBlockPayload(fb.id, { ...fb.payload, reasoning: r, reasoningStatus: "done", ...(fromReasoning ? { misconceptions: [fromReasoning.label] } : {}) });
        return true;
      });
      if (applied) done++;
    }
    return done;
  }

  /** Set aside the current portion without treating it as an answer or evidence of understanding. */
  skipConcept(lessonId: string, expectedConceptId: string) {
    return this.withLock(lessonId, async () => {
      const lesson = this.repo.getLesson(lessonId);
      if (!lesson) throw Object.assign(new Error("Lesson not found"), { status: 404 });
      const state = structuredClone(lesson.state);
      const pending = state.pendingQuestionId ? this.repo.getQuestion(state.pendingQuestionId) : undefined;
      const isReview = pending?.purpose === "review" || (!pending && state.reviewQueue.length > 0);
      const inDetour = state.detours.length > 0;
      const conceptId = isReview ? pending?.concept_id ?? state.reviewQueue[0] : currentConcept(state);
      // Two tabs or a retried click must never silently set aside the next concept too.
      if (state.complete || conceptId !== expectedConceptId) throw Object.assign(new Error("The lesson has moved on. Use the current step to continue."), { status: 409 });
      this.prefetch.cancel(lessonId);
      this.repo.tx(() => {
        this.skipPendingQuestion(lesson, state);
        if (isReview) {
          state.reviewQueue = [];
        } else {
          if (!state.deferred.includes(conceptId)) state.deferred.push(conceptId);
          state.justReturned = null;
          if (state.detours.length) {
            const frame = this.applyReturn(lesson, state);
            this.repo.appendBlock({
              lessonId, type: "detour_end", conceptId,
              payload: { conceptName: this.repo.getConcept(conceptId)!.name, returningTo: this.repo.getConcept(frame.fromConceptId)!.name, returnLabel: this.positionLabel(lesson, frame.returnTo.page), status: "deferred" },
              provenance: "system",
            });
          } else {
            this.advancePath(lesson, state, conceptId);
          }
        }
        this.repo.appendBlock({
          lessonId, type: "notice", conceptId,
          payload: { kind: "skipped", message: isReview ? "Review set aside for now. Continuing with your lesson." : `${this.repo.getConcept(conceptId)!.name} is set aside for now. Your progress is saved, and you can keep going.` },
          provenance: "system",
        });
        this.save(lesson, state);
        this.repo.logEvent(lessonId, "lesson_portion_skipped", { conceptId, kind: isReview ? "review" : inDetour ? "detour" : "concept" });
      });
      this.bus.publish({ type: "lesson", lessonId });
    });
  }

  /** Record an unanswered question as skipped in its block; answer keys stay hidden. */
  private skipPendingQuestion(lesson: LessonRow, state: LessonState) {
    if (!state.pendingQuestionId) return;
    const block = this.repo.listBlocks(lesson.id).find((b) => b.type === "question" && b.payload.questionId === state.pendingQuestionId);
    if (block) this.repo.updateBlockPayload(block.id, { ...block.payload, skipped: true });
    state.pendingQuestionId = null;
  }

  skipReview(lessonId: string) {
    return this.withLock(lessonId, async () => {
      const lesson = this.repo.getLesson(lessonId)!;
      const state = structuredClone(lesson.state);
      this.repo.tx(() => {
        if (state.pendingQuestionId && this.repo.getQuestion(state.pendingQuestionId)?.purpose === "review") this.skipPendingQuestion(lesson, state);
        state.reviewQueue = [];
        this.save(lesson, state);
      });
    });
  }
}

/** The state change of starting a detour. Returns the page to come back to. */
function applyDetour(state: LessonState, action: Extract<Action, { type: "detour" }>): number | null {
  const returnPage = state.sourcePosition?.page ?? null;
  state.detours.push({ conceptId: action.conceptId, reason: action.reason, fromConceptId: action.fromConceptId, returnTo: { conceptId: action.fromConceptId, page: returnPage } });
  state.detourHistory.push(`${action.fromConceptId}>${action.conceptId}`);
  state.conceptId = action.conceptId;
  if (!state.roles[action.conceptId]) state.roles[action.conceptId] = "background";
  return returnPage;
}

export function feedbackMessage(correct: boolean | null, confidence: string | null, reasoning: string | null, misconception: string | null): string {
  // The UI already shows the verdict (Correct / Not quite); this adds what it means.
  if (correct === null) return "That's useful information: it marks a gap to teach, not a mistake to undo.";
  if (correct) {
    if (reasoning === "flawed" || reasoning === "off_topic") return "The answer is right, but the written reasoning doesn't support it, so this counts only as recognition, not understanding.";
    if (confidence === "guess") return "Since it was a guess, it doesn't count as evidence yet.";
    if (confidence === "unsure") return "You weren't sure, so it's recorded as tentative; another question will confirm it.";
    return "";
  }
  // Labels are often full sentences; drop their end punctuation so the hint doesn't end in "….*."
  const idea = misconception?.trim().replace(/[\s.!?;:,]+$/, "");
  const hint = idea ? `The option you chose usually reflects this idea: *${idea}*.` : "";
  if (confidence === "sure") return `Because you were sure, this looks like a firmly held idea worth examining. ${hint}`.trim();
  return hint;
}

/** The misconception the reasoning evaluator diagnosed, when it counts: flawed reasoning, or a wrong answer. */
export function reasoningMisconception(r: ReasoningEvaluation | null, correct: boolean | null) {
  return r?.misconception && (r.verdict === "flawed" || correct === false) ? r.misconception : null;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** Standalone numbers in a text ("−3", "0.5", "1,000"), ignoring digits inside identifiers ("chr21", "2D", "x_1"). */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.replace(/(\d),(\d{3})(?!\d)/g, "$1$2").matchAll(/(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?(?![\p{L}\p{N}_])/gu)) out.add(String(Number(m[0])));
  return out;
}

/**
 * The learner sees only the stem and options; "scenario" is a hidden tag. A scenario carrying data
 * the stem lacks (e.g. "candidate scores −3, −1, −4" behind a stem that says "at this cell") makes the
 * question unanswerable. Conservative: it takes at least two missing numbers, at least half of the
 * scenario's numbers, and a number written as a word in the stem ("two states") counts as shown.
 */
export function scenarioDataProblem(q: { stem: string; scenario: string; options: { label: string }[] }): string | null {
  const hidden = numbersIn(q.scenario);
  if (hidden.size < 2) return null;
  const shown = `${q.stem}\n${q.options.map((o) => o.label).join("\n")}`;
  const visible = numbersIn(shown);
  NUMBER_WORDS.forEach((w, n) => new RegExp(`\\b${w}\\b`, "i").test(shown) && visible.add(String(n)));
  const missing = [...hidden].filter((n) => !visible.has(n));
  if (missing.length < 2 || missing.length * 2 < hidden.size) return null;
  return `"scenario" contains values (${missing.join(", ")}) that appear in neither the stem nor the options, but the learner sees only the stem and options. Put every value the question needs into the stem, and keep "scenario" a short label without data.`;
}

// ── Source text sent to the model ───────────────────────────────────────────

/** Fewer non-space characters than this: a figure, handwriting or a bare title, not teachable text. */
const NEAR_EMPTY_CHARS = 20;

/**
 * Lines (≥ 20 chars) repeated on at least half of a document's pages: copyright banners and
 * running headers. Stripped only from text sent to the model; stored pages are never rewritten.
 */
export function boilerplateLines(pages: string[]): Set<string> {
  const lines = new Set<string>();
  if (pages.length < 4) return lines;
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const line of new Set(page.split("\n").map((l) => l.trim()))) if (line.length >= 20) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  for (const [line, n] of counts) if (n >= Math.max(3, pages.length / 2)) lines.add(line);
  return lines;
}

export function stripBoilerplate(text: string, boilerplate: Set<string>): string {
  if (!boilerplate.size) return text.trim();
  return text
    .split("\n")
    .filter((l) => !boilerplate.has(l.trim()))
    .join("\n")
    .trim();
}

export function isNearEmpty(text: string): boolean {
  return text.replace(/\s+/g, "").length < NEAR_EMPTY_CHARS;
}

/** Analysis input: boilerplate removed, and pages without usable text marked so the model doesn't invent them. */
export function analysisPages(pages: string[], boilerplate = boilerplateLines(pages)): { page: number; text: string }[] {
  const clean = pages.map((t) => stripBoilerplate(t, boilerplate));
  const withText = clean.filter((t) => !isNearEmpty(t)).length;
  const perPage = Math.max(300, Math.min(PAGE_CHARS, Math.floor(ANALYSIS_CHARS / Math.max(1, withText))));
  return clean.map((text, i) => {
    const page = i + 1;
    if (!isNearEmpty(text)) return { page, text: text.slice(0, perPage) };
    const fragment = text.replace(/\s+/g, " ").trim();
    return {
      page,
      text: fragment
        ? `[page ${page}: only a short fragment is extractable; the rest is a figure, handwriting or a title] ${fragment}`
        : `[page ${page}: no extractable text — figure or handwriting]`,
    };
  });
}

/**
 * Pages for a concept's excerpt: its mapped pages first (in the analysis's order), then pages
 * just after them (a title slide is usually followed by its content) and just before, skipping
 * pages without usable text, until the character budget is spent.
 */
export function excerptPages(pages: string[], mapped: number[], budget: number, boilerplate = boilerplateLines(pages)): { page: number; text: string }[] {
  const order: number[] = [];
  const add = (p: number) => p >= 1 && p <= pages.length && !order.includes(p) && order.push(p);
  mapped.forEach(add);
  for (const d of [1, 2, 3, 4, -1]) mapped.forEach((p) => add(p + d));
  const out: { page: number; text: string }[] = [];
  let left = budget;
  for (const p of order) {
    if (left < 200 || out.length >= 8) break;
    const text = stripBoilerplate(pages[p - 1] ?? "", boilerplate);
    if (isNearEmpty(text)) continue;
    const slice = text.slice(0, Math.min(PAGE_CHARS, left));
    out.push({ page: p, text: slice });
    left -= slice.length;
  }
  return out.sort((a, b) => a.page - b.page);
}

/** Drop analysis pages outside the document and names missing from the concept list. */
export function sanitizeAnalysis(a: SourceAnalysis, pageCount: number): SourceAnalysis {
  const inRange = (p: number) => p >= 1 && p <= pageCount;
  const names = new Set(a.concepts.map((c) => c.name.toLowerCase()));
  return {
    ...a,
    structure: a.structure.filter((s) => inRange(s.pageStart)).map((s) => ({ ...s, pageEnd: inRange(s.pageEnd) && s.pageEnd >= s.pageStart ? s.pageEnd : s.pageStart })),
    concepts: a.concepts.map((c) => ({ ...c, pages: c.pages.filter(inRange), prerequisites: c.prerequisites.filter((p) => names.has(p.toLowerCase()) && p.toLowerCase() !== c.name.toLowerCase()) })),
    learningPath: a.learningPath.filter((n) => names.has(n.toLowerCase())),
  };
}

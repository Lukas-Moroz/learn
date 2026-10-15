// Prefetch: prepare the lesson's next generated content (an explanation or a question) while the
// learner is still reading or answering, so Continue can reveal it at once.
//
// - What comes next is deterministic: the planner is a pure function of the lesson state, so the
//   prefetcher asks it for the next move as if the learner pressed Continue now (looking through
//   moves that generate nothing: the overview, advancing to the next concept, detours, returns).
// - A prepared generation is an ordinary Generator.run (job row, validation, repairs), but hidden:
//   it publishes no live events and nothing is stored outside its job row, so the client learns
//   nothing about it until the engine reveals it. Nothing is committed by the prefetcher.
// - It is identified by a key over the exact generation input (the concept, the move, the
//   anti-repetition context, misconceptions, recent attempts, source text …). The engine computes
//   the same key when it executes the move for real and uses the prepared result only on a match
//   (re-running a question's deterministic checks against the state as it is then). Any change in
//   state that would change the generation changes the key, so stale content is never used.
// - At most MAX_RUNNING hidden generations per lesson; leaving the lesson cancels them.
import { Visibility } from "../ai/generate.ts";
import type { LessonRow } from "../db/repo.ts";
import type { ExplanationContent } from "../../shared/schemas.ts";
import type { Engine } from "./engine.ts";
import { nextCheck, plan } from "./planner.ts";

/** Hidden generations running at once for one lesson. */
export const MAX_RUNNING = 2;
/** Moves that generate nothing, looked through to find the next generation. */
const LOOKAHEAD = 4;

interface Entry {
  key: string;
  task: "explain" | "question";
  /** The explanation entry this question was chained from (kept while that one is wanted). */
  parent: string | null;
  controller: AbortController;
  visibility: Visibility;
  promise: Promise<unknown>;
  state: "running" | "ready" | "failed";
  startedAt: number;
}

type Target =
  | (ReturnType<Engine["explanationRequest"]> & { sim: LessonRow; conceptId: string })
  | ReturnType<Engine["questionRequest"]>;

export interface PrefetchStats {
  started: number;
  /** Prepared generations the learner received (fully or while still being written). */
  used: number;
  /** Cancelled or no longer needed: the extra AI requests prefetching cost. */
  discarded: number;
}

export class Prefetcher {
  private lessons = new Map<string, Map<string, Entry>>();
  readonly stats: PrefetchStats = { started: 0, used: 0, discarded: 0 };

  constructor(private readonly engine: Engine) {}

  /** The "prefetch" setting (default on). */
  enabled(): boolean {
    return this.engine.repo.getSetting<{ prefetch?: boolean }>("generation", {}).prefetch !== false;
  }

  /**
   * Start preparing the lesson's next generation, if there is one, it isn't prepared already, and
   * the lesson has room. Prepared content the lesson no longer leads to is cancelled.
   */
  schedule(lessonId: string): void {
    if (!this.enabled()) return;
    // Mid-advance or mid-answer the next step isn't settled (and may be being generated right now):
    // the route schedules again once it is done.
    if (this.engine.isBusy(lessonId)) return;
    let target: Target | null = null;
    try {
      target = this.next(lessonId);
    } catch {
      target = null; // a look-ahead that can't be computed just means nothing is prepared
    }
    const map = this.lessons.get(lessonId) ?? new Map<string, Entry>();
    for (const [key, e] of map) {
      if (target && (key === target.key || e.parent === target.key)) continue;
      this.drop(map, key);
    }
    if (!target || map.has(target.key)) return this.store(lessonId, map);
    if (this.running(map) >= MAX_RUNNING) return this.store(lessonId, map);
    this.start(lessonId, map, target, null);
    this.store(lessonId, map);
  }

  /**
   * The prepared result for exactly this generation, or null. Revealing it makes its job visible
   * (the client sees its live preview from now on, if it is still being written). A prepared
   * generation that already failed is dropped (null: generate afresh); one still running is
   * awaited, and its failure is the learner's failure, as if it had started now.
   */
  async claim(lessonId: string, key: string): Promise<unknown | null> {
    const map = this.lessons.get(lessonId);
    const e = map?.get(key);
    if (!map || !e) return null;
    map.delete(key);
    if (e.state === "failed") {
      this.stats.discarded++;
      return null;
    }
    this.stats.used++;
    e.visibility.show();
    return e.promise;
  }

  /** Cancel everything prepared for a lesson (the learner left it, or prefetching was turned off). */
  cancel(lessonId: string): number {
    const map = this.lessons.get(lessonId);
    if (!map) return 0;
    const n = map.size;
    for (const key of [...map.keys()]) this.drop(map, key);
    this.lessons.delete(lessonId);
    return n;
  }

  cancelAll(): void {
    for (const id of [...this.lessons.keys()]) this.cancel(id);
  }

  /** Keys and states of what is prepared for a lesson (tests and diagnostics; never sent to the client). */
  pending(lessonId: string): { key: string; task: string; state: string }[] {
    return [...(this.lessons.get(lessonId)?.values() ?? [])].map((e) => ({ key: e.key, task: e.task, state: e.state }));
  }

  /** Resolves once nothing prepared for the lesson (or any lesson) is still being written. */
  async idle(lessonId?: string): Promise<void> {
    for (;;) {
      const running = [...this.lessons.entries()]
        .filter(([id]) => !lessonId || id === lessonId)
        .flatMap(([, m]) => [...m.values()])
        .filter((e) => e.state === "running");
      if (!running.length) return;
      await Promise.allSettled(running.map((e) => e.promise));
      await new Promise((r) => setImmediate(r)); // let chained generations start
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The generation the lesson needs next if the learner continues now (null: none, or unknown). */
  private next(lessonId: string): Target | null {
    const lesson = this.engine.repo.getLesson(lessonId);
    if (!lesson || lesson.state.complete || lesson.state.pendingQuestionId) return null;
    const sim: LessonRow = { ...lesson, state: structuredClone(lesson.state) };
    for (let i = 0; i < LOOKAHEAD; i++) {
      const action = plan(this.engine.snapshot(sim));
      switch (action.type) {
        case "explain":
          return { ...this.engine.explanationRequest(sim, action), sim, conceptId: action.conceptId };
        case "probe":
          return this.engine.questionRequest(sim, action.conceptId, action.kind, "original", action.difficulty, "probe");
        case "check":
          return this.engine.questionRequest(sim, action.conceptId, action.kind, action.context, action.difficulty, action.purpose);
        default:
          if (!this.engine.simulate(sim, action)) return null;
      }
    }
    return null;
  }

  private start(lessonId: string, map: Map<string, Entry>, target: Target, parent: string | null) {
    const visibility = new Visibility();
    const controller = new AbortController();
    const run =
      target.task === "explain"
        ? this.engine.gen.run("explain", target.input, { ...target.opts, signal: controller.signal, visibility })
        : this.engine.gen.run("question", target.input, { ...target.opts, signal: controller.signal, visibility });
    const e: Entry = { key: target.key, task: target.task, parent, controller, visibility, promise: run, state: "running", startedAt: Date.now() };
    this.stats.started++;
    map.set(target.key, e);
    run.then(
      (value) => {
        e.state = "ready";
        // An explanation's question can be written as soon as the explanation exists.
        if (target.task === "explain" && "sim" in target) this.chain(lessonId, e, target, value as ExplanationContent);
      },
      () => {
        e.state = "failed";
      },
    );
  }

  /** After a prepared explanation: prepare the question the planner asks right after it. */
  private chain(lessonId: string, parent: Entry, target: Extract<Target, { sim: LessonRow }>, explanation: ExplanationContent) {
    if (!this.enabled()) return;
    const map = this.lessons.get(lessonId);
    // Still wanted: either still prepared, or revealed (then the map no longer holds it).
    const wanted = map?.get(parent.key) === parent || parent.visibility.visible;
    if (!map || !wanted) return;
    try {
      const sim = this.engine.repo.getLesson(lessonId);
      if (!sim) return;
      // The question that follows an explanation is nextCheck(facts): explanations don't change mastery.
      const check = nextCheck(this.engine.snapshot({ ...sim, state: target.sim.state }).facts(target.conceptId));
      const q = this.engine.questionRequest({ ...sim, state: target.sim.state }, target.conceptId, check.kind, check.context, check.difficulty, check.purpose, explanation);
      if (map.has(q.key) || this.running(map) >= MAX_RUNNING) return;
      this.start(lessonId, map, q, parent.key);
    } catch {
      // nothing prepared
    }
  }

  private running(map: Map<string, Entry>) {
    return [...map.values()].filter((e) => e.state === "running").length;
  }

  private drop(map: Map<string, Entry>, key: string) {
    const e = map.get(key);
    if (!e) return;
    map.delete(key);
    this.stats.discarded++;
    if (e.state === "running") e.controller.abort();
  }

  private store(lessonId: string, map: Map<string, Entry>) {
    if (map.size) this.lessons.set(lessonId, map);
    else this.lessons.delete(lessonId);
  }
}

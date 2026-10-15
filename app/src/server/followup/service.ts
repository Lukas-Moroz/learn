// Follow-up questions: after any answer the learner can ask a free-text question about it (a
// practice step, a coaching round, or a lesson explanation / answer feedback) and get a short,
// focused answer before moving on. Answers go through Generator.run like all content (job row,
// streaming preview of "answer", validation, repair) and are committed only once they validate.
// Leak safety: before a practice step is finished, the model sees the key only as forbidden
// context, and the preview and the final answer are checked against it (practice-leak.ts). In a
// lesson, an unanswered question's correct option is never named. Follow-ups never change lesson
// state, evidence or misconceptions (a lesson records an event only). With no provider a question
// waits ("waiting") and is answered once one is back.
import type { Generator } from "../ai/generate.ts";
import { validateRefs } from "../alignment/refs.ts";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import type { PracticeService } from "../practice/service.ts";
import { keyShown, stepConcepts, stepStatus } from "../practice/view.ts";
import { ProviderError } from "../providers/types.ts";
import type { Engine } from "../teaching/engine.ts";
import { FollowUpAsk, type FollowUpAnswer, type FollowUpTargetKind, type FollowUpThreadView } from "../../shared/followup.ts";
import { expectedDisplay } from "../../shared/practice-grading.ts";
import { followUpLeaks, forbiddenValues, namesVerbatim } from "../../shared/practice-leak.ts";
import type { PracticeRef } from "../../shared/practice.ts";
import type { SourceRef } from "../../shared/schemas.ts";
import { FollowUpRepo, type FollowUpThreadRow, type FollowUpTurnRow } from "./repo.ts";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Earlier turns of the thread sent with each question (the most recent ones). */
const PRIOR_TURNS = 6;
const LESSON_EXCERPT_CHARS = 3000;
const clip = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

/** Everything one answer needs, computed when it is generated (so a step finished meanwhile is "open"). */
interface Prepared {
  input: Record<string, unknown>;
  /** A reason to reject (or withhold) text that gives away what must stay hidden; null when it's fine. */
  leakProblem: ((text: string) => string | null) | null;
  refs: (refs: PracticeRef[]) => SourceRef[];
}

export class FollowUpService {
  readonly store: FollowUpRepo;
  private running = new Map<string, Promise<void>>();

  constructor(
    readonly repo: Repo,
    readonly practice: PracticeService,
    readonly engine: Engine,
    readonly gen: Generator,
    readonly bus: EventBus,
  ) {
    this.store = new FollowUpRepo(repo);
  }

  /** On boot: answers cut off by the last shutdown wait for a retry. */
  recoverAtBoot(): number {
    return this.store.interrupt();
  }

  /** Resolves once no answer is being generated (tests await it). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  /** A provider is available again: answer every question that waited for one. */
  resume() {
    for (const t of this.store.turnsWithStatus("waiting")) this.launch(t);
  }

  thread(threadId: string): FollowUpThreadView {
    const t = this.store.getThread(threadId);
    if (!t) throw httpError(404, "Follow-up thread not found");
    return this.store.toView(t);
  }

  /** Ask a question; returns the thread at once (the new turn "pending"), the answer follows over SSE. */
  ask(raw: unknown): FollowUpThreadView {
    const { kind, id, question } = FollowUpAsk.parse(raw);
    const lessonId = this.target(kind, id);
    const existing = this.store.thread(kind, id);
    if (existing && this.store.turns(existing.id).some((t) => t.status === "pending" || t.status === "waiting")) {
      throw httpError(409, "Your last question is still waiting for its answer. Ask the next one once it's there.");
    }
    const thread = existing ?? this.store.ensureThread(kind, id, lessonId);
    const turn = this.store.insertTurn(thread.id, question);
    this.repo.logEvent(lessonId, "follow_up", { kind, targetId: id, threadId: thread.id, turnId: turn.id });
    this.launch(turn);
    return this.store.toView(thread);
  }

  /** Retry a question whose answer failed the checks or waited for a provider. */
  retry(turnId: string): FollowUpThreadView {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw httpError(404, "Follow-up question not found");
    if (turn.status === "failed" || turn.status === "waiting") {
      this.store.setTurn(turn.id, { status: "pending", error: null });
      this.launch(turn);
    }
    return this.thread(turn.thread_id);
  }

  /** Check the target exists and can take a follow-up; returns its lesson (lesson blocks only). */
  private target(kind: FollowUpTargetKind, id: string): string | null {
    const ps = this.practice.store;
    if (kind === "practice_step") {
      if (!ps.getStep(id)) throw httpError(404, "Step not found");
      if (!ps.attemptsForStep(id).length) throw httpError(409, "Answer the step first; then you can ask about it.");
      return null;
    }
    if (kind === "practice_coaching") {
      if (!ps.getCoaching(id)) throw httpError(404, "Coaching not found");
      return null;
    }
    const block = this.repo.getBlock(id);
    if (!block) throw httpError(404, "Lesson block not found");
    if (block.type !== "explanation" && block.type !== "feedback") throw httpError(400, "Follow-ups can be asked about an explanation or an answer.");
    return block.lessonId;
  }

  private launch(turn: FollowUpTurnRow) {
    // One answer at a time per thread (a thread only ever has one unanswered question).
    const key = turn.thread_id;
    if (this.running.has(key)) return;
    const p = this.run(turn.id)
      .catch(() => undefined)
      .finally(() => this.running.delete(key));
    this.running.set(key, p);
  }

  private publish(thread: FollowUpThreadRow, turnId: string, status: string) {
    this.bus.publish({ type: "followup", threadId: thread.id, followUpId: turnId, status, lessonId: thread.lesson_id });
  }

  private async run(turnId: string): Promise<void> {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.status === "ready") return;
    const thread = this.store.getThread(turn.thread_id)!;
    this.store.setTurn(turn.id, { status: "pending", error: null });
    this.publish(thread, turn.id, "pending");
    let prep: Prepared;
    try {
      prep = this.prepare(thread, turn);
    } catch (e) {
      this.store.setTurn(turn.id, { status: "failed", error: (e as Error).message });
      this.publish(thread, turn.id, "failed");
      return;
    }
    let out: FollowUpAnswer;
    try {
      out = await this.gen.run("follow_up", prep.input, {
        lessonId: null,
        meta: { followUpId: turn.id, threadId: thread.id },
        // Streamed as it is written; before a step is finished each preview is leak-checked first.
        preview: { fields: ["answer"], ...(prep.leakProblem ? { withhold: (v: Record<string, string>) => Boolean(prep.leakProblem!(v.answer ?? "")) } : {}) },
        check: (v) => prep.leakProblem?.(v.answer) ?? null,
      });
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message, true);
      const failed = err.code === "invalid_response";
      this.store.setTurn(turn.id, { status: failed ? "failed" : "waiting", error: failed ? "The AI's answer didn't pass the checks." : err.message });
      this.publish(thread, turn.id, failed ? "failed" : "waiting");
      return;
    }
    this.store.setTurn(turn.id, { status: "ready", answer: out.answer, refs: prep.refs(out.refs), error: null });
    this.publish(thread, turn.id, "ready");
  }

  // ── Context ───────────────────────────────────────────────────────────────

  private prepare(thread: FollowUpThreadRow, turn: FollowUpTurnRow): Prepared {
    const earlier = this.store
      .turns(thread.id)
      .filter((t) => t.position < turn.position && t.status === "ready")
      .slice(-PRIOR_TURNS)
      .map((t) => ({ question: t.question, answer: clip(t.answer, 1500) }));
    const base = thread.target_kind === "lesson_block" ? this.lessonContext(thread.target_id) : this.practiceContext(thread.target_kind, thread.target_id);
    return { ...base, input: { ...base.input, thread: earlier, question: turn.question } };
  }

  private practiceContext(kind: FollowUpTargetKind, targetId: string): Prepared {
    const ps = this.practice.store;
    const guide = this.practice.guide;
    const coaching = kind === "practice_coaching" ? ps.getCoaching(targetId) : undefined;
    const step = ps.getStep(coaching ? coaching.step_id : targetId);
    if (!step) throw new Error("This step no longer exists.");
    const problem = ps.getProblem(step.problem_id)!;
    const attempts = ps.attemptsForStep(step.id);
    const status = stepStatus(attempts);
    // Finished (right, counted as correct, or the solution shown), or the key is on screen anyway.
    const open = keyShown(attempts, status);
    const ex = guide.excerpts(problem);
    const concepts = stepConcepts(ps, problem, step).flatMap((c) => {
      const row = this.repo.getConcept(c.id);
      return row ? [{ name: row.name, definition: row.definition }] : [];
    });
    const last = attempts.at(-1);
    const c = coaching?.content;
    const input = {
      about: {
        what: coaching ? "a coaching round after a missed exam-practice step" : "an exam-practice step",
        problem: { title: problem.title, intro: clip(problem.intro, 3000) },
        step: { label: step.label, prompt: step.prompt, kind: step.kind, ...(step.hint ? { hint: step.hint } : {}) },
      },
      learner: {
        status,
        attempts: attempts.slice(-4).map((a) => (a.revealed ? { answer: "(asked to see the solution)" } : guide.learnerInput(step, a))),
      },
      shown: {
        ...(last?.feedback ? { feedback: last.feedback } : {}),
        ...(c
          ? {
              coaching: {
                diagnosis: c.diagnosis,
                summary: c.summary ?? "",
                explanation: clip(c.explanation, 2000),
                example: clip(c.example, 1200),
                nextHint: c.nextHint,
                ...(coaching?.check ? { checkQuestionAnswered: coaching.check.correct === true ? "correct" : "not correct" } : {}),
              },
            }
          : {}),
      },
      keyStatus: open ? "open" : "hidden",
      ...(open
        ? { key: { expected: expectedDisplay(step.key), solution: step.solution } }
        : { hiddenKey: { expected: expectedDisplay(step.key), forbiddenValues: forbiddenValues(step.key), solution: step.solution } }),
      concepts,
      lecture: ex.input,
    };
    const shownText = `${problem.intro}\n${step.prompt}`;
    return {
      input,
      leakProblem: open
        ? null
        : (text) => {
            const hits = followUpLeaks(step.key, text, shownText);
            return hits.length
              ? `the answer gives the step's answer away before the learner has finished the step: it contains ${hits.join(", ")}. Never state, confirm or narrow down the key; explain the idea or method, on different data if an example helps`
              : null;
          },
      refs: (r) => guide.refs(r, ex),
    };
  }

  private lessonContext(blockId: string): Prepared {
    const repo = this.repo;
    const block = repo.getBlock(blockId);
    if (!block) throw new Error("This part of the lesson no longer exists.");
    const lesson = repo.getLesson(block.lessonId)!;
    const conceptId = block.conceptId;
    const title = this.engine.lectureTitle(lesson);
    const excerpt = conceptId ? this.engine.sourceExcerpt(lesson, conceptId, LESSON_EXCERPT_CHARS) : null;
    const lecture = excerpt?.pages.length ? { excerpts: excerpt.pages.map((p) => ({ doc: 1, lecture: title ?? "the source", page: p.page, text: p.text })) } : null;
    const concept = conceptId ? this.engine.conceptInput(lesson, conceptId) : null;
    const p = block.payload;

    let about: Record<string, unknown>;
    let learner: Record<string, unknown> | undefined;
    let shown: Record<string, unknown> = {};
    if (block.type === "explanation") {
      about = {
        what: "a lesson explanation the learner just read",
        concept,
        explanation: { title: p.title, body: clip(p.body, 3000), ...(p.workedExample ? { workedExample: clip(p.workedExample, 1500) } : {}), ...(p.analogy ? { analogy: p.analogy.text } : {}) },
      };
    } else {
      const q = repo.getQuestion(p.questionId)!;
      const a = repo.getAttempt(p.attemptId);
      const label = new Map(q.options.map((o) => [o.value, o.label]));
      const lastExplanation = repo
        .listBlocks(lesson.id)
        .filter((b) => b.type === "explanation" && b.conceptId === conceptId && b.seq < block.seq)
        .at(-1);
      about = {
        what: "a lesson question the learner just answered",
        concept,
        question: { stem: q.stem, options: q.options.map((o) => o.label), correct: q.correct.map((v) => label.get(v) ?? v), explanation: q.explanation },
      };
      learner = a
        ? { chose: a.dont_know ? "I don't know" : a.selected.map((v) => label.get(v) ?? v), correct: a.correct, confidence: a.confidence, ...(a.note ? { note: a.note } : {}) }
        : undefined;
      shown = {
        feedback: p.message,
        ...(p.reasoning?.summary ? { reasoningFeedback: p.reasoning.summary } : {}),
        ...(lastExplanation ? { earlierExplanation: { title: lastExplanation.payload.title, body: clip(lastExplanation.payload.body, 1500) } } : {}),
      };
    }

    // A question waiting for an answer: its correct option must not be given away.
    const pendingId = lesson.state.pendingQuestionId;
    const pending = pendingId ? repo.getQuestion(pendingId) : undefined;
    const unanswered = pending && !repo.attemptsForQuestion(pending.id).some((a) => a.lesson_id === lesson.id) ? pending : undefined;
    const doNotSay = unanswered ? unanswered.correct.map((v) => unanswered.options.find((o) => o.value === v)?.label ?? v) : [];

    return {
      input: {
        about,
        ...(learner ? { learner } : {}),
        shown,
        keyStatus: "open",
        ...(unanswered ? { openQuestion: { stem: unanswered.stem, options: unanswered.options.map((o) => o.label), doNotSay } } : {}),
        lecture,
      },
      leakProblem: doNotSay.length
        ? (text) => {
            const hit = doNotSay.find((l) => namesVerbatim(text, l));
            return hit
              ? `the answer names the correct option of the question the learner hasn't answered yet ("${hit}"). Help with the underlying idea without revealing or hinting which option is right`
              : null;
          }
        : null,
      refs: (r) =>
        lesson.source_id
          ? validateRefs(
              repo,
              lesson.source_id,
              r.filter((x) => x.doc === 1).map(({ doc: _d, ...x }) => x),
              title,
            ).refs
          : [],
    };
  }
}

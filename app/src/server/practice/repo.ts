// Practice persistence: sets, problems, steps and attempts. Kept beside the main
// repository (same database, same transactions) rather than inside it.
import type { Repo } from "../db/repo.ts";
import { newId, now } from "../db/repo.ts";
import type { AnswerKey, AnswerKind, GuideStatus, PracticeGrade, PracticeOutline } from "../../shared/practice.ts";
import type { QuestionOption, QuestionContent, Strategy } from "../../shared/schemas.ts";
import type { Confidence, SourceRef } from "../../shared/schemas.ts";

export type PracticeValue = string | string[] | string[][];

export interface PracticeSetRow {
  id: string; course_id: string; problem_source_id: string; solution_source_id: string | null;
  problem_sha: string; solution_sha: string | null; title: string; key_source: "solutions" | "generated";
  status: "extracting" | "ready" | "failed"; error: string | null; outline: PracticeOutline | null;
  progress_total: number | null; created_at: string; updated_at: string;
}
export interface PracticeProblemRow {
  id: string; set_id: string; position: number; number: string; title: string; intro: string;
  concepts: { id: string; name: string }[]; keywords: string[]; taught_in: SourceRef[]; taught_in_sig: string;
  problem_refs: SourceRef[]; created_at: string;
}
export interface PracticeStepRow {
  id: string; problem_id: string; position: number; label: string; prompt: string; kind: AnswerKind;
  key: AnswerKey; solution: string; hint: string | null; concepts: string[]; solution_refs: SourceRef[];
  skipped: boolean;
}
export interface PracticeAttemptRow {
  id: string; step_id: string; value: PracticeValue | null; dont_know: boolean; confidence: Confidence | null;
  correct: boolean | null; score: number | null; cell_results: (boolean | null)[][] | null; feedback: string;
  grading_status: "done" | "pending" | "failed"; grade: PracticeGrade | null; overridden: boolean;
  /** "Show solution": the key was shown with this attempt. A plain "I don't know" is dont_know without revealed. */
  revealed: boolean; created_at: string;
}

/** A multiple-choice question as stored for guided practice: options in display order, correct values resolved. */
export interface StoredQuestion extends Omit<QuestionContent, "options" | "correct" | "refs"> {
  options: QuestionOption[];
  correct: string[];
}

export interface StoredProbe {
  conceptId: string;
  conceptName: string;
  why: string;
  question: StoredQuestion;
  teach: string;
  refs: SourceRef[];
}

export interface PrimerRow {
  problem_id: string; status: GuideStatus | "none"; skipped: boolean; probes: StoredProbe[]; error: string | null;
  created_at: string; updated_at: string;
}
export interface ProbeAnswerRow {
  id: string; problem_id: string; idx: number; selected: string[]; dont_know: boolean; confidence: Confidence | null;
  correct: boolean | null; created_at: string;
}

export interface StoredCoaching {
  strategy: Strategy;
  diagnosis: string;
  /** The core idea in at most two sentences; absent on rows from before it existed (practice-coach-v2). */
  summary?: string;
  explanation: string;
  example: string;
  nextHint: string;
  /** Generated after the explanation (null until then). Rows from before the split always have it. */
  check: StoredQuestion | null;
  /** State of the check's generation; absent on older rows (whose check came with the explanation). */
  checkStatus?: GuideStatus;
  checkError?: string | null;
}
export interface CoachingRow {
  id: string; step_id: string; attempt_id: string; round: number; status: GuideStatus; content: StoredCoaching | null;
  refs: SourceRef[]; error: string | null;
  check: { selected: string[]; dont_know: boolean; confidence: Confidence | null; correct: boolean | null; at: string } | null;
  created_at: string; updated_at: string;
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);
const bool = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

export class PracticeRepo {
  constructor(readonly repo: Repo) {}

  private get db() {
    return this.repo.db;
  }

  // ── Sets ──────────────────────────────────────────────────────────────────
  createSet(s: Pick<PracticeSetRow, "course_id" | "problem_source_id" | "solution_source_id" | "problem_sha" | "solution_sha" | "title" | "key_source">): PracticeSetRow {
    const t = now();
    const row = { ...s, id: newId(), status: "extracting", error: null, outline_json: null, progress_total: null, created_at: t, updated_at: t };
    this.db
      .prepare(
        `INSERT INTO practice_sets (id, course_id, problem_source_id, solution_source_id, problem_sha, solution_sha, title, key_source,
         status, error, outline_json, progress_total, created_at, updated_at) VALUES (@id, @course_id, @problem_source_id,
         @solution_source_id, @problem_sha, @solution_sha, @title, @key_source, @status, @error, @outline_json, @progress_total,
         @created_at, @updated_at)`,
      )
      .run(row);
    return this.getSet(row.id)!;
  }
  getSet(id: string): PracticeSetRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_sets WHERE id = ?").get(id);
    return r ? this.toSet(r) : undefined;
  }
  findSet(courseId: string, problemSha: string, solutionSha: string | null): PracticeSetRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM practice_sets WHERE course_id = ? AND problem_sha = ? AND COALESCE(solution_sha, '') = ?")
      .get(courseId, problemSha, solutionSha ?? "");
    return r ? this.toSet(r) : undefined;
  }
  listSets(courseId: string): PracticeSetRow[] {
    return (this.db.prepare("SELECT * FROM practice_sets WHERE course_id = ? ORDER BY created_at").all(courseId) as any[]).map((r) => this.toSet(r));
  }
  updateSet(id: string, patch: Partial<Pick<PracticeSetRow, "status" | "error" | "outline" | "progress_total" | "title">>) {
    const cols: Record<string, unknown> = {};
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.error !== undefined) cols.error = patch.error;
    if (patch.outline !== undefined) cols.outline_json = patch.outline ? json(patch.outline) : null;
    if (patch.progress_total !== undefined) cols.progress_total = patch.progress_total;
    if (patch.title !== undefined) cols.title = patch.title;
    const keys = Object.keys(cols);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE practice_sets SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...cols, updated_at: now(), id });
  }
  /** Attempts, steps and problems go with the set; evidence, misconceptions and their ledger contributions are learning history and stay. */
  deleteSet(id: string) {
    this.repo.tx(() => {
      // Follow-up threads on the set's steps and coaching rounds (their turns cascade).
      this.db
        .prepare(
          `DELETE FROM follow_up_threads WHERE (target_kind = 'practice_step' AND target_id IN (SELECT s.id FROM practice_steps s
           JOIN practice_problems p ON p.id = s.problem_id WHERE p.set_id = @id)) OR (target_kind = 'practice_coaching' AND target_id IN
           (SELECT c.id FROM practice_coaching c JOIN practice_steps s ON s.id = c.step_id JOIN practice_problems p ON p.id = s.problem_id
           WHERE p.set_id = @id))`,
        )
        .run({ id });
      this.db
        .prepare("DELETE FROM practice_coaching WHERE step_id IN (SELECT s.id FROM practice_steps s JOIN practice_problems p ON p.id = s.problem_id WHERE p.set_id = ?)")
        .run(id);
      this.db.prepare("DELETE FROM practice_probe_answers WHERE problem_id IN (SELECT id FROM practice_problems WHERE set_id = ?)").run(id);
      this.db.prepare("DELETE FROM practice_primers WHERE problem_id IN (SELECT id FROM practice_problems WHERE set_id = ?)").run(id);
      this.db
        .prepare(
          `DELETE FROM practice_attempts WHERE step_id IN (SELECT s.id FROM practice_steps s JOIN practice_problems p ON p.id = s.problem_id
           WHERE p.set_id = ?)`,
        )
        .run(id);
      this.db.prepare("DELETE FROM practice_steps WHERE problem_id IN (SELECT id FROM practice_problems WHERE set_id = ?)").run(id);
      this.db.prepare("DELETE FROM practice_problems WHERE set_id = ?").run(id);
      this.db.prepare("DELETE FROM practice_sets WHERE id = ?").run(id);
    });
  }
  /** On boot: an extraction still marked running belonged to a process that stopped. */
  interruptExtractions(message: string): number {
    return Number(this.db.prepare("UPDATE practice_sets SET status = 'failed', error = ?, updated_at = ? WHERE status = 'extracting'").run(message, now()).changes);
  }
  private toSet(r: any): PracticeSetRow {
    const { outline_json, ...rest } = r;
    return { ...rest, outline: parse<PracticeOutline | null>(outline_json, null) };
  }

  /** Documents (by id) that are a practice set's problems or solutions in this course. */
  practiceDocuments(courseId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT s.document_id FROM practice_sets p JOIN sources s ON s.id IN (p.problem_source_id, p.solution_source_id)
         WHERE p.course_id = ?`,
      )
      .all(courseId) as { document_id: string }[];
    return new Set(rows.map((r) => r.document_id));
  }
  setLectureRole(documentIds: string[], role: "lecture" | "practice") {
    const upd = this.db.prepare("UPDATE lectures SET role = ? WHERE document_id = ?");
    for (const d of documentIds) upd.run(role, d);
  }

  // ── Problems & steps ──────────────────────────────────────────────────────
  insertProblem(
    p: Omit<PracticeProblemRow, "id" | "created_at">,
    steps: Omit<PracticeStepRow, "id" | "problem_id" | "position" | "skipped">[],
  ): PracticeProblemRow {
    return this.repo.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO practice_problems (id, set_id, position, number, title, intro, concepts_json, keywords_json, taught_in_json,
           taught_in_sig, problem_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, p.set_id, p.position, p.number, p.title, p.intro, json(p.concepts), json(p.keywords), json(p.taught_in), p.taught_in_sig, json(p.problem_refs), now());
      const ins = this.db.prepare(
        `INSERT INTO practice_steps (id, problem_id, position, label, prompt, kind, key_json, solution, hint, concepts_json, solution_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      steps.forEach((s, i) => ins.run(newId(), id, i, s.label, s.prompt, s.kind, json(s.key), s.solution, s.hint, json(s.concepts), json(s.solution_refs)));
      return this.getProblem(id)!;
    });
  }
  getProblem(id: string): PracticeProblemRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_problems WHERE id = ?").get(id);
    return r ? this.toProblem(r) : undefined;
  }
  listProblems(setId: string): PracticeProblemRow[] {
    return (this.db.prepare("SELECT * FROM practice_problems WHERE set_id = ? ORDER BY position").all(setId) as any[]).map((r) => this.toProblem(r));
  }
  problemPositions(setId: string): Set<number> {
    return new Set((this.db.prepare("SELECT position FROM practice_problems WHERE set_id = ?").all(setId) as { position: number }[]).map((r) => r.position));
  }
  setTaughtIn(problemId: string, refs: SourceRef[], sig: string) {
    this.db.prepare("UPDATE practice_problems SET taught_in_json = ?, taught_in_sig = ? WHERE id = ?").run(json(refs), sig, problemId);
  }
  private toProblem(r: any): PracticeProblemRow {
    const { concepts_json, keywords_json, taught_in_json, problem_refs_json, ...rest } = r;
    return { ...rest, concepts: parse(concepts_json, []), keywords: parse(keywords_json, []), taught_in: parse(taught_in_json, []), problem_refs: parse(problem_refs_json, []) };
  }

  listSteps(problemId: string): PracticeStepRow[] {
    return (this.db.prepare("SELECT * FROM practice_steps WHERE problem_id = ? ORDER BY position").all(problemId) as any[]).map((r) => this.toStep(r));
  }
  stepsForSet(setId: string): PracticeStepRow[] {
    return (
      this.db
        .prepare("SELECT s.* FROM practice_steps s JOIN practice_problems p ON p.id = s.problem_id WHERE p.set_id = ? ORDER BY p.position, s.position")
        .all(setId) as any[]
    ).map((r) => this.toStep(r));
  }
  getStep(id: string): PracticeStepRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_steps WHERE id = ?").get(id);
    return r ? this.toStep(r) : undefined;
  }
  private toStep(r: any): PracticeStepRow {
    const { key_json, concepts_json, solution_refs_json, ...rest } = r;
    return { ...rest, skipped: Boolean(r.skipped), key: JSON.parse(key_json), concepts: parse(concepts_json, []), solution_refs: parse(solution_refs_json, []) };
  }

  setSkipped(stepId: string, skipped: boolean) {
    this.db.prepare("UPDATE practice_steps SET skipped = ? WHERE id = ?").run(skipped ? 1 : 0, stepId);
  }

  // ── Attempts ──────────────────────────────────────────────────────────────
  insertAttempt(a: Omit<PracticeAttemptRow, "id" | "created_at" | "overridden" | "revealed"> & { revealed?: boolean }): PracticeAttemptRow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO practice_attempts (id, step_id, value_json, dont_know, confidence, correct, score, cell_results_json, feedback,
         grading_status, grade_json, overridden, revealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id, a.step_id, a.value === null ? null : json(a.value), a.dont_know ? 1 : 0, a.confidence, bool(a.correct), a.score,
        a.cell_results ? json(a.cell_results) : null, a.feedback, a.grading_status, a.grade ? json(a.grade) : null, a.revealed ? 1 : 0, now(),
      );
    this.setSkipped(a.step_id, false);
    return this.getAttempt(id)!;
  }
  getAttempt(id: string): PracticeAttemptRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_attempts WHERE id = ?").get(id);
    return r ? this.toAttempt(r) : undefined;
  }
  /** Oldest first. */
  attemptsForStep(stepId: string): PracticeAttemptRow[] {
    return (this.db.prepare("SELECT * FROM practice_attempts WHERE step_id = ? ORDER BY created_at, rowid").all(stepId) as any[]).map((r) => this.toAttempt(r));
  }
  attemptsForSet(setId: string): PracticeAttemptRow[] {
    return (
      this.db
        .prepare(
          `SELECT a.* FROM practice_attempts a JOIN practice_steps s ON s.id = a.step_id JOIN practice_problems p ON p.id = s.problem_id
           WHERE p.set_id = ? ORDER BY a.created_at, a.rowid`,
        )
        .all(setId) as any[]
    ).map((r) => this.toAttempt(r));
  }
  pendingGrades(): PracticeAttemptRow[] {
    return (this.db.prepare("SELECT * FROM practice_attempts WHERE grading_status = 'pending' ORDER BY created_at, rowid").all() as any[]).map((r) => this.toAttempt(r));
  }
  setGrade(id: string, g: { correct: boolean | null; score: number | null; feedback: string; grading_status: PracticeAttemptRow["grading_status"]; grade: PracticeGrade | null }) {
    this.db
      .prepare("UPDATE practice_attempts SET correct = ?, score = ?, feedback = ?, grading_status = ?, grade_json = ? WHERE id = ?")
      .run(bool(g.correct), g.score, g.feedback, g.grading_status, g.grade ? json(g.grade) : null, id);
  }
  setOverridden(id: string) {
    this.db.prepare("UPDATE practice_attempts SET overridden = 1 WHERE id = ?").run(id);
  }
  private toAttempt(r: any): PracticeAttemptRow {
    return {
      id: r.id,
      step_id: r.step_id,
      value: parse(r.value_json, null),
      dont_know: !!r.dont_know,
      confidence: r.confidence,
      correct: r.correct === null ? null : !!r.correct,
      score: r.score,
      cell_results: parse(r.cell_results_json, null),
      feedback: r.feedback,
      grading_status: r.grading_status,
      grade: parse(r.grade_json, null),
      overridden: !!r.overridden,
      revealed: !!r.revealed,
      created_at: r.created_at,
    };
  }

  /**
   * Record a misconception on behalf of one attempt: a ledger contribution keyed by the attempt, at
   * the attempt's own time (not grading time), so a late grade never reopens a later resolution.
   */
  recordAttemptMisconception(attemptId: string, conceptId: string, label: string, description: string | null, confidence: Confidence | null, at?: string) {
    return this.repo.recordMisconception(conceptId, label, description, confidence, { kind: "practice", id: attemptId }, at);
  }

  /** Undo exactly what one attempt contributed: deactivate its contributions and rebuild those rows from what remains. */
  retractAttemptMisconceptions(attemptId: string) {
    this.repo.retractMisconceptions("practice", attemptId);
  }

  /** Evidence recorded for one attempt (replaced when the learner overrides the grade). */
  deleteEvidenceFor(attemptId: string) {
    this.db.prepare("DELETE FROM evidence WHERE attempt_id = ?").run(attemptId);
  }

  // ── Warm-up primers ───────────────────────────────────────────────────────
  getPrimer(problemId: string): PrimerRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_primers WHERE problem_id = ?").get(problemId) as any;
    if (!r) return undefined;
    const { content_json, skipped, ...rest } = r;
    return { ...rest, skipped: !!skipped, probes: parse<StoredProbe[]>(content_json, []) };
  }
  /** Insert or update the primer row (status, content, error, skipped). */
  putPrimer(problemId: string, patch: { status?: PrimerRow["status"]; probes?: StoredProbe[]; error?: string | null; skipped?: boolean }) {
    const t = now();
    const existing = this.getPrimer(problemId);
    if (!existing) {
      this.db
        .prepare("INSERT INTO practice_primers (problem_id, status, skipped, content_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(problemId, patch.status ?? "pending", patch.skipped ? 1 : 0, patch.probes ? json(patch.probes) : null, patch.error ?? null, t, t);
      return;
    }
    this.db
      .prepare("UPDATE practice_primers SET status = ?, skipped = ?, content_json = ?, error = ?, updated_at = ? WHERE problem_id = ?")
      .run(
        patch.status ?? existing.status,
        (patch.skipped ?? existing.skipped) ? 1 : 0,
        json(patch.probes ?? existing.probes),
        patch.error !== undefined ? patch.error : existing.error,
        t,
        problemId,
      );
  }
  primersWithStatus(status: PrimerRow["status"]): PrimerRow[] {
    return (this.db.prepare("SELECT problem_id FROM practice_primers WHERE status = ?").all(status) as { problem_id: string }[]).map((r) => this.getPrimer(r.problem_id)!);
  }
  insertProbeAnswer(a: Omit<ProbeAnswerRow, "id" | "created_at">): ProbeAnswerRow {
    const id = newId();
    this.db
      .prepare("INSERT INTO practice_probe_answers (id, problem_id, idx, selected_json, dont_know, confidence, correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.problem_id, a.idx, json(a.selected), a.dont_know ? 1 : 0, a.confidence, bool(a.correct), now());
    return this.probeAnswers(a.problem_id).find((x) => x.id === id)!;
  }
  probeAnswers(problemId: string): ProbeAnswerRow[] {
    return (this.db.prepare("SELECT * FROM practice_probe_answers WHERE problem_id = ? ORDER BY idx").all(problemId) as any[]).map((r) => ({
      id: r.id,
      problem_id: r.problem_id,
      idx: r.idx,
      selected: parse<string[]>(r.selected_json, []),
      dont_know: !!r.dont_know,
      confidence: r.confidence,
      correct: r.correct === null ? null : !!r.correct,
      created_at: r.created_at,
    }));
  }

  // ── Coaching ──────────────────────────────────────────────────────────────
  insertCoaching(c: { step_id: string; attempt_id: string; round: number }): CoachingRow {
    const id = newId();
    const t = now();
    this.db
      .prepare("INSERT INTO practice_coaching (id, step_id, attempt_id, round, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, c.step_id, c.attempt_id, c.round, t, t);
    return this.getCoaching(id)!;
  }
  getCoaching(id: string): CoachingRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_coaching WHERE id = ?").get(id);
    return r ? this.toCoaching(r) : undefined;
  }
  coachingForAttempt(attemptId: string): CoachingRow | undefined {
    const r = this.db.prepare("SELECT * FROM practice_coaching WHERE attempt_id = ?").get(attemptId);
    return r ? this.toCoaching(r) : undefined;
  }
  /** Oldest first. */
  coachingForStep(stepId: string): CoachingRow[] {
    return (this.db.prepare("SELECT * FROM practice_coaching WHERE step_id = ? ORDER BY round, created_at").all(stepId) as any[]).map((r) => this.toCoaching(r));
  }
  coachingWithStatus(status: GuideStatus): CoachingRow[] {
    return (this.db.prepare("SELECT * FROM practice_coaching WHERE status = ? ORDER BY created_at").all(status) as any[]).map((r) => this.toCoaching(r));
  }
  setCoaching(id: string, patch: { status: GuideStatus; content?: StoredCoaching | null; refs?: SourceRef[]; error?: string | null }) {
    const cur = this.getCoaching(id);
    if (!cur) return;
    this.db
      .prepare("UPDATE practice_coaching SET status = ?, content_json = ?, refs_json = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.status,
        (patch.content !== undefined ? patch.content : cur.content) ? json(patch.content !== undefined ? patch.content : cur.content) : null,
        json(patch.refs ?? cur.refs),
        patch.error !== undefined ? patch.error : cur.error,
        now(),
        id,
      );
  }
  setCoachingCheck(id: string, a: { selected: string[]; dont_know: boolean; confidence: Confidence | null; correct: boolean | null }) {
    this.db
      .prepare("UPDATE practice_coaching SET check_selected_json = ?, check_dont_know = ?, check_confidence = ?, check_correct = ?, checked_at = ?, updated_at = ? WHERE id = ?")
      .run(json(a.selected), a.dont_know ? 1 : 0, a.confidence, bool(a.correct), now(), now(), id);
  }
  /** On boot: generation cut off by a restart waits to be retried. */
  interruptGuides(): number {
    const a = this.db.prepare("UPDATE practice_coaching SET status = 'waiting', error = ? WHERE status = 'pending'").run("Stopped when Learn was closed.").changes;
    const b = this.db.prepare("UPDATE practice_primers SET status = 'waiting', error = ? WHERE status = 'pending'").run("Stopped when Learn was closed.").changes;
    // A check question cut off after its explanation was committed waits too.
    let c = 0;
    for (const row of this.coachingWithStatus("ready")) {
      if (row.content && !row.content.check && row.content.checkStatus === "pending") {
        this.setCoaching(row.id, { status: "ready", content: { ...row.content, checkStatus: "waiting", checkError: "Stopped when Learn was closed." } });
        c++;
      }
    }
    return Number(a) + Number(b) + c;
  }
  private toCoaching(r: any): CoachingRow {
    return {
      id: r.id,
      step_id: r.step_id,
      attempt_id: r.attempt_id,
      round: r.round,
      status: r.status,
      content: parse<StoredCoaching | null>(r.content_json, null),
      refs: parse<SourceRef[]>(r.refs_json, []),
      error: r.error,
      check: r.checked_at
        ? { selected: parse<string[]>(r.check_selected_json, []), dont_know: !!r.check_dont_know, confidence: r.check_confidence, correct: r.check_correct === null ? null : !!r.check_correct, at: r.checked_at }
        : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}

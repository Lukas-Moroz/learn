// Typed repository over SQLite. All persistent learning state goes through here.
import { randomUUID } from "node:crypto";
import type { DB } from "./database.ts";
import type {
  Block,
  BlockType,
  ConceptRole,
  Confidence,
  EdgeKind,
  LessonState,
  Provenance,
  QuestionContent,
  QuestionOption,
  QuestionPurpose,
  ReasoningEvaluation,
  SourceRef,
  Strategy,
} from "../../shared/schemas.ts";
import type { EvidenceItem } from "../../shared/mastery.ts";

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();

export interface CourseRow { id: string; title: string; created_at: string }
export interface DocumentRow { id: string; course_id: string; key: string; title: string; kind: string; created_at: string }
export interface SourceRow {
  id: string; document_id: string; sha256: string; kind: string; filename: string; stored_path: string;
  page_count: number; unit: "page" | "slide"; version: number; superseded_by: string | null; created_at: string;
}
export interface LectureRow {
  id: string; course_id: string; title: string; position: number; document_id: string | null; created_at: string;
  /** "practice": the document belongs to a practice set (study guide or solutions), so it isn't listed as a lecture. */
  role: "lecture" | "practice";
}
export interface ConceptRow { id: string; slug: string; name: string; sense: string | null; definition: string; created_at: string }
export interface LectureConceptRow { lecture_id: string; concept_id: string; role: ConceptRole; position: number; pages: number[]; section: string | null }
export interface LessonRow {
  id: string; course_id: string | null; lecture_id: string | null; source_id: string | null; objective: string | null;
  title: string; state: LessonState; version: number; created_at: string; updated_at: string;
}
export interface QuestionRow {
  id: string; lesson_id: string | null; block_id: string | null; concept_id: string; purpose: QuestionPurpose;
  kind: QuestionContent["kind"]; context: "original" | "novel"; scenario: string; stem: string;
  options: QuestionOption[]; correct: string[]; multi_select: boolean; explanation: string;
  rubric: QuestionContent["rubric"]; difficulty: number; created_at: string;
}
export interface AttemptRow {
  id: string; question_id: string; lesson_id: string | null; selected: string[]; dont_know: boolean;
  confidence: Confidence | null; note: string | null; correct: boolean | null; misconceptions: string[];
  reasoning_status: "none" | "pending" | "done" | "failed"; reasoning: ReasoningEvaluation | null; created_at: string;
}
export interface MisconceptionRow {
  id: string; concept_id: string; label: string; description: string | null; status: "suspected" | "likely" | "resolved";
  occurrences: number; strongest_confidence: Confidence | null; first_seen: string; last_seen: string; resolved_at: string | null;
}
export type ContributionSource = "lesson" | "practice" | "other";
/** One occurrence of a misconception in the ledger (misconception_contributions). */
export interface MisconceptionContribution {
  id: number; concept_id: string; label: string; source_kind: ContributionSource; source_id: string | null;
  confidence: Confidence | null; description: string | null; created_at: string; active: number;
}
export interface JobRow {
  id: string; lesson_id: string | null; task: string; status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  provider: string | null; partial_text: string; error: any; created_at: string; finished_at: string | null;
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

export class Repo {
  constructor(readonly db: DB) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Courses ───────────────────────────────────────────────────────────────
  createCourse(title: string): CourseRow {
    const row = { id: newId(), title: title.trim(), created_at: now() };
    this.db.prepare("INSERT INTO courses VALUES (@id, @title, @created_at)").run(row);
    return row;
  }
  listCourses(): CourseRow[] {
    return this.db.prepare("SELECT * FROM courses ORDER BY created_at").all() as CourseRow[];
  }
  getCourse(id: string): CourseRow | undefined {
    return this.db.prepare("SELECT * FROM courses WHERE id = ?").get(id) as CourseRow | undefined;
  }

  // ── Documents & sources ───────────────────────────────────────────────────
  findDocument(courseId: string, key: string): DocumentRow | undefined {
    return this.db.prepare("SELECT * FROM documents WHERE course_id = ? AND key = ?").get(courseId, key) as DocumentRow | undefined;
  }
  getDocument(id: string): DocumentRow | undefined {
    return this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
  }
  createDocument(courseId: string, key: string, title: string, kind: string): DocumentRow {
    const row = { id: newId(), course_id: courseId, key, title, kind, created_at: now() };
    this.db.prepare("INSERT INTO documents VALUES (@id, @course_id, @key, @title, @kind, @created_at)").run(row);
    return row;
  }
  getSource(id: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
  }
  findSourceBySha(sha256: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE sha256 = ? ORDER BY created_at LIMIT 1").get(sha256) as SourceRow | undefined;
  }
  findSourceInDocument(documentId: string, sha256: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE document_id = ? AND sha256 = ?").get(documentId, sha256) as SourceRow | undefined;
  }
  latestSource(documentId: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE document_id = ? ORDER BY version DESC LIMIT 1").get(documentId) as SourceRow | undefined;
  }
  createSource(s: Omit<SourceRow, "id" | "created_at" | "superseded_by">): SourceRow {
    const row: SourceRow = { ...s, id: newId(), superseded_by: null, created_at: now() };
    this.db
      .prepare(
        `INSERT INTO sources VALUES (@id, @document_id, @sha256, @kind, @filename, @stored_path, @page_count, @unit,
         @version, @superseded_by, @created_at)`,
      )
      .run(row);
    return row;
  }
  supersede(oldId: string, newId_: string) {
    this.db.prepare("UPDATE sources SET superseded_by = ? WHERE id = ?").run(newId_, oldId);
  }
  setPages(sourceId: string, pages: string[]) {
    const ins = this.db.prepare("INSERT OR REPLACE INTO source_pages VALUES (?, ?, ?)");
    pages.forEach((text, i) => ins.run(sourceId, i + 1, text));
  }
  getPages(sourceId: string): string[] {
    const rows = this.db.prepare("SELECT text FROM source_pages WHERE source_id = ? ORDER BY page").all(sourceId) as { text: string }[];
    return rows.map((r) => r.text);
  }
  getPage(sourceId: string, page: number): string | undefined {
    const r = this.db.prepare("SELECT text FROM source_pages WHERE source_id = ? AND page = ?").get(sourceId, page) as { text: string } | undefined;
    return r?.text;
  }
  listSources(courseId: string): (SourceRow & { document_title: string })[] {
    return this.db
      .prepare(
        `SELECT s.*, d.title AS document_title FROM sources s JOIN documents d ON d.id = s.document_id
         WHERE d.course_id = ? ORDER BY s.created_at`,
      )
      .all(courseId) as (SourceRow & { document_title: string })[];
  }

  getAnalysis(sha256: string, promptVersion: string): unknown | undefined {
    const r = this.db.prepare("SELECT json FROM analyses WHERE sha256 = ? AND prompt_version = ?").get(sha256, promptVersion) as
      | { json: string }
      | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }
  putAnalysis(sha256: string, promptVersion: string, value: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO analyses VALUES (?, ?, ?, ?)").run(sha256, promptVersion, json(value), now());
  }

  // ── Lectures ──────────────────────────────────────────────────────────────
  createLecture(courseId: string, title: string, documentId: string | null, position?: number): LectureRow {
    const pos =
      position ??
      ((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM lectures WHERE course_id = ?").get(courseId) as { p: number }).p);
    const row = { id: newId(), course_id: courseId, title, position: pos, document_id: documentId, created_at: now() };
    this.db
      .prepare("INSERT INTO lectures (id, course_id, title, position, document_id, created_at) VALUES (@id, @course_id, @title, @position, @document_id, @created_at)")
      .run(row);
    return { ...row, role: "lecture" };
  }
  /** Lectures in order. Documents used by a practice set are left out unless asked for. */
  listLectures(courseId: string, opts: { includePractice?: boolean } = {}): LectureRow[] {
    const where = opts.includePractice ? "" : "AND role = 'lecture'";
    return this.db.prepare(`SELECT * FROM lectures WHERE course_id = ? ${where} ORDER BY position, created_at`).all(courseId) as LectureRow[];
  }
  getLecture(id: string): LectureRow | undefined {
    return this.db.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as LectureRow | undefined;
  }
  findLectureByDocument(documentId: string): LectureRow | undefined {
    return this.db.prepare("SELECT * FROM lectures WHERE document_id = ?").get(documentId) as LectureRow | undefined;
  }
  reorderLectures(courseId: string, orderedIds: string[]) {
    this.tx(() => {
      const upd = this.db.prepare("UPDATE lectures SET position = ? WHERE id = ? AND course_id = ?");
      orderedIds.forEach((id, i) => upd.run(i, id, courseId));
    });
  }
  renameLecture(id: string, title: string) {
    this.db.prepare("UPDATE lectures SET title = ? WHERE id = ?").run(title, id);
  }

  // ── Concept graph ─────────────────────────────────────────────────────────
  getConcept(id: string): ConceptRow | undefined {
    return this.db.prepare("SELECT * FROM concepts WHERE id = ?").get(id) as ConceptRow | undefined;
  }
  findConceptBySlug(slug: string): ConceptRow | undefined {
    return this.db.prepare("SELECT * FROM concepts WHERE slug = ?").get(slug) as ConceptRow | undefined;
  }
  createConcept(slug: string, name: string, sense: string | null, definition: string): ConceptRow {
    const row = { id: newId(), slug, name, sense, definition, created_at: now() };
    this.db.prepare("INSERT INTO concepts VALUES (@id, @slug, @name, @sense, @definition, @created_at)").run(row);
    return row;
  }
  listConcepts(): ConceptRow[] {
    return this.db.prepare("SELECT * FROM concepts ORDER BY name").all() as ConceptRow[];
  }
  addEdge(conceptId: string, relatedId: string, kind: EdgeKind) {
    if (conceptId === relatedId) return;
    this.db.prepare("INSERT OR IGNORE INTO concept_edges VALUES (?, ?, ?)").run(conceptId, relatedId, kind);
  }
  edges(): { concept_id: string; related_id: string; kind: EdgeKind }[] {
    return this.db.prepare("SELECT * FROM concept_edges").all() as { concept_id: string; related_id: string; kind: EdgeKind }[];
  }
  prerequisitesOf(conceptId: string): string[] {
    return (
      this.db.prepare("SELECT related_id FROM concept_edges WHERE concept_id = ? AND kind = 'prerequisite'").all(conceptId) as {
        related_id: string;
      }[]
    ).map((r) => r.related_id);
  }
  setContext(conceptId: string, courseId: string, interpretation: string | null) {
    this.db
      .prepare(
        `INSERT INTO concept_contexts VALUES (?, ?, ?) ON CONFLICT(concept_id, course_id)
         DO UPDATE SET interpretation = COALESCE(excluded.interpretation, interpretation)`,
      )
      .run(conceptId, courseId, interpretation);
  }
  contextsFor(conceptId: string): { course_id: string; interpretation: string | null; course_title: string }[] {
    return this.db
      .prepare(
        `SELECT cc.course_id, cc.interpretation, c.title AS course_title FROM concept_contexts cc
         JOIN courses c ON c.id = cc.course_id WHERE cc.concept_id = ?`,
      )
      .all(conceptId) as { course_id: string; interpretation: string | null; course_title: string }[];
  }
  setLectureConcepts(lectureId: string, rows: Omit<LectureConceptRow, "lecture_id">[]) {
    this.tx(() => {
      this.db.prepare("DELETE FROM lecture_concepts WHERE lecture_id = ?").run(lectureId);
      const ins = this.db.prepare("INSERT INTO lecture_concepts VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of rows) ins.run(lectureId, r.concept_id, r.role, r.position, json(r.pages), r.section);
    });
  }
  lectureConcepts(lectureId: string): LectureConceptRow[] {
    return (this.db.prepare("SELECT * FROM lecture_concepts WHERE lecture_id = ? ORDER BY position").all(lectureId) as any[]).map((r) => ({
      ...r,
      pages: parse<number[]>(r.pages_json, []),
    }));
  }
  /** The role a concept plays in a lesson's lecture (central if unknown — the safe, stricter default). */
  conceptRole(lectureId: string | null, conceptId: string): ConceptRole {
    if (!lectureId) return "central";
    const r = this.db.prepare("SELECT role FROM lecture_concepts WHERE lecture_id = ? AND concept_id = ?").get(lectureId, conceptId) as
      | { role: ConceptRole }
      | undefined;
    return r?.role ?? "background";
  }

  // ── Lessons & blocks ──────────────────────────────────────────────────────
  createLesson(l: { courseId: string | null; lectureId: string | null; sourceId: string | null; objective: string | null; title: string; state: LessonState }): LessonRow {
    const t = now();
    const id = newId();
    this.db
      .prepare("INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .run(id, l.courseId, l.lectureId, l.sourceId, l.objective, l.title, json(l.state), t, t);
    return this.getLesson(id)!;
  }
  getLesson(id: string): LessonRow | undefined {
    const r = this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as any;
    return r ? { ...r, state: JSON.parse(r.state_json) } : undefined;
  }
  listLessons(): LessonRow[] {
    return (this.db.prepare("SELECT * FROM lessons ORDER BY updated_at DESC").all() as any[]).map((r) => ({ ...r, state: JSON.parse(r.state_json) }));
  }
  /** Optimistic concurrency: a stale writer fails instead of clobbering newer state. */
  saveLessonState(id: string, state: LessonState, expectedVersion: number): number {
    const res = this.db
      .prepare("UPDATE lessons SET state_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .run(json(state), now(), id, expectedVersion);
    if (res.changes !== 1) throw new Error("lesson state changed concurrently; reload and retry");
    return expectedVersion + 1;
  }
  appendBlock(b: { lessonId: string; type: BlockType; conceptId: string | null; payload: unknown; refs?: SourceRef[]; provenance: Provenance }): Block {
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM blocks WHERE lesson_id = ?").get(b.lessonId) as { s: number }).s;
    const row = {
      id: newId(),
      lesson_id: b.lessonId,
      seq,
      type: b.type,
      concept_id: b.conceptId,
      payload_json: json(b.payload),
      refs_json: json(b.refs ?? []),
      provenance: b.provenance,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO blocks VALUES (@id, @lesson_id, @seq, @type, @concept_id, @payload_json, @refs_json, @provenance, @created_at)")
      .run(row);
    return this.toBlock(row);
  }
  updateBlockPayload(id: string, payload: unknown) {
    this.db.prepare("UPDATE blocks SET payload_json = ? WHERE id = ?").run(json(payload), id);
  }
  listBlocks(lessonId: string): Block[] {
    return (this.db.prepare("SELECT * FROM blocks WHERE lesson_id = ? ORDER BY seq").all(lessonId) as any[]).map((r) => this.toBlock(r));
  }
  getBlock(id: string): Block | undefined {
    const r = this.db.prepare("SELECT * FROM blocks WHERE id = ?").get(id);
    return r ? this.toBlock(r) : undefined;
  }
  private toBlock(r: any): Block {
    return {
      id: r.id,
      lessonId: r.lesson_id,
      seq: r.seq,
      type: r.type,
      conceptId: r.concept_id,
      payload: JSON.parse(r.payload_json),
      refs: JSON.parse(r.refs_json),
      provenance: r.provenance,
      createdAt: r.created_at,
    };
  }

  // ── Questions & attempts ──────────────────────────────────────────────────
  insertQuestion(q: Omit<QuestionRow, "id" | "created_at">): QuestionRow {
    const row: QuestionRow = { ...q, id: newId(), created_at: now() };
    this.db
      .prepare("INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        row.id, row.lesson_id, row.block_id, row.concept_id, row.purpose, row.kind, row.context, row.scenario, row.stem,
        json(row.options), json(row.correct), row.multi_select ? 1 : 0, row.explanation, json(row.rubric), row.difficulty, row.created_at,
      );
    return row;
  }
  setQuestionBlock(questionId: string, blockId: string) {
    this.db.prepare("UPDATE questions SET block_id = ? WHERE id = ?").run(blockId, questionId);
  }
  getQuestion(id: string): QuestionRow | undefined {
    const r = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
    return r ? this.toQuestion(r) : undefined;
  }
  questionsForConcept(conceptId: string): QuestionRow[] {
    return (this.db.prepare("SELECT * FROM questions WHERE concept_id = ? ORDER BY created_at").all(conceptId) as any[]).map((r) => this.toQuestion(r));
  }
  private toQuestion(r: any): QuestionRow {
    return {
      ...r,
      options: JSON.parse(r.options_json),
      correct: JSON.parse(r.correct_json),
      multi_select: !!r.multi_select,
      rubric: JSON.parse(r.rubric_json),
    };
  }
  insertAttempt(a: Omit<AttemptRow, "id" | "created_at"> & { created_at?: string }): AttemptRow {
    const row: AttemptRow = { ...a, id: newId(), created_at: a.created_at ?? now() };
    this.db
      .prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        row.id, row.question_id, row.lesson_id, json(row.selected), row.dont_know ? 1 : 0, row.confidence, row.note,
        row.correct === null ? null : row.correct ? 1 : 0, json(row.misconceptions), row.reasoning_status,
        row.reasoning ? json(row.reasoning) : null, row.created_at,
      );
    return row;
  }
  setAttemptReasoning(id: string, status: AttemptRow["reasoning_status"], reasoning: ReasoningEvaluation | null) {
    this.db.prepare("UPDATE attempts SET reasoning_status = ?, reasoning_json = ? WHERE id = ?").run(status, reasoning ? json(reasoning) : null, id);
  }
  attemptsForQuestion(questionId: string): AttemptRow[] {
    return (this.db.prepare("SELECT * FROM attempts WHERE question_id = ? ORDER BY created_at").all(questionId) as any[]).map((r) => this.toAttempt(r));
  }
  getAttempt(id: string): AttemptRow | undefined {
    const r = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id);
    return r ? this.toAttempt(r) : undefined;
  }
  /** Attempts on a concept, oldest first, joined with the question that was asked. */
  attemptsForConcept(conceptId: string): (AttemptRow & { question: QuestionRow })[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, q.id AS qid FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE q.concept_id = ? ORDER BY a.created_at, a.rowid`,
      )
      .all(conceptId) as any[];
    return rows.map((r) => ({ ...this.toAttempt(r), question: this.getQuestion(r.qid)! }));
  }
  allAttempts(): AttemptRow[] {
    return (this.db.prepare("SELECT * FROM attempts ORDER BY created_at").all() as any[]).map((r) => this.toAttempt(r));
  }
  /** Atomically claim a pending reasoning evaluation; false when another caller already holds or finished it. */
  claimPendingReasoning(id: string): boolean {
    return Number(this.db.prepare("UPDATE attempts SET reasoning_status = 'running' WHERE id = ? AND reasoning_status = 'pending'").run(id).changes) === 1;
  }
  /** Give a claimed evaluation back (e.g. the provider was unavailable) so it is retried later. */
  releaseReasoningClaim(id: string) {
    this.db.prepare("UPDATE attempts SET reasoning_status = 'pending' WHERE id = ? AND reasoning_status = 'running'").run(id);
  }
  /** Complete a claimed evaluation; false when the claim is no longer held. Call inside the applying transaction. */
  finishReasoningClaim(id: string, reasoning: ReasoningEvaluation): boolean {
    return Number(this.db.prepare("UPDATE attempts SET reasoning_status = 'done', reasoning_json = ? WHERE id = ? AND reasoning_status = 'running'").run(json(reasoning), id).changes) === 1;
  }
  pendingReasoning(): AttemptRow[] {
    return (this.db.prepare("SELECT * FROM attempts WHERE reasoning_status = 'pending' ORDER BY created_at").all() as any[]).map((r) =>
      this.toAttempt(r),
    );
  }
  private toAttempt(r: any): AttemptRow {
    return {
      id: r.id,
      question_id: r.question_id,
      lesson_id: r.lesson_id,
      selected: JSON.parse(r.selected_json),
      dont_know: !!r.dont_know,
      confidence: r.confidence,
      note: r.note,
      correct: r.correct === null ? null : !!r.correct,
      misconceptions: JSON.parse(r.misconceptions_json),
      // A claimed ("running") evaluation is still pending from every reader's point of view.
      reasoning_status: r.reasoning_status === "running" ? "pending" : r.reasoning_status,
      reasoning: r.reasoning_json ? JSON.parse(r.reasoning_json) : null,
      created_at: r.created_at,
    };
  }

  // ── Evidence & misconceptions ─────────────────────────────────────────────
  addEvidence(conceptId: string, courseId: string | null, attemptId: string | null, items: EvidenceItem[]) {
    const ins = this.db.prepare("INSERT INTO evidence (concept_id, course_id, dimension, delta, note, attempt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const e of items) ins.run(conceptId, courseId, e.dimension, e.delta, e.note ?? null, attemptId, e.at);
  }
  evidenceFor(conceptId: string): EvidenceItem[] {
    return (this.db.prepare("SELECT dimension, delta, note, created_at FROM evidence WHERE concept_id = ? ORDER BY created_at, id").all(conceptId) as any[]).map(
      (r) => ({ dimension: r.dimension, delta: r.delta, note: r.note ?? undefined, at: r.created_at }),
    );
  }
  conceptsWithEvidence(): string[] {
    return (this.db.prepare("SELECT DISTINCT concept_id FROM evidence").all() as { concept_id: string }[]).map((r) => r.concept_id);
  }
  /**
   * Record one occurrence of a misconception: a ledger contribution keyed by what produced it
   * (a lesson or practice attempt; 'other' for untracked callers), then rebuild the row.
   */
  recordMisconception(
    conceptId: string, label: string, description: string | null, confidence: Confidence | null,
    source: { kind: ContributionSource; id: string | null } = { kind: "other", id: null }, at: string = now(),
  ): MisconceptionRow {
    // Idempotent per (source, concept, label): the same source never counts a label twice;
    // re-recording it refreshes (and reactivates) its one contribution.
    this.db
      .prepare(
        `INSERT INTO misconception_contributions (concept_id, label, source_kind, source_id, confidence, description, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (source_kind, source_id, concept_id, label) WHERE source_id IS NOT NULL
         DO UPDATE SET description = COALESCE(excluded.description, description), active = 1`,
      )
      .run(conceptId, label, source.kind, source.id, confidence, description, at);
    // A newer occurrence reopens a resolved row in the rebuild; the resolution history stays.
    return this.rebuildMisconception(conceptId, label)!;
  }

  /** Active contributions of one source (optionally one label), oldest first. */
  misconceptionContributions(kind: ContributionSource, sourceId: string, label?: string): MisconceptionContribution[] {
    return (
      this.db
        .prepare("SELECT * FROM misconception_contributions WHERE source_kind = ? AND source_id = ? AND active = 1 ORDER BY created_at, id")
        .all(kind, sourceId) as MisconceptionContribution[]
    ).filter((c) => label === undefined || c.label === label);
  }

  /** Retract what one source contributed (all labels, or those `keep` rejects), rebuilding each affected row. */
  retractMisconceptions(kind: ContributionSource, sourceId: string, keep: (label: string) => boolean = () => false) {
    const hits = this.misconceptionContributions(kind, sourceId).filter((c) => !keep(c.label));
    const deactivate = this.db.prepare("UPDATE misconception_contributions SET active = 0 WHERE id = ?");
    for (const c of hits) deactivate.run(c.id);
    const labels = new Map(hits.map((c) => [`${c.concept_id}\u0000${c.label}`, c]));
    for (const c of labels.values()) this.rebuildMisconception(c.concept_id, c.label);
  }

  /** Replace the description of one source's contributions to a label (a richer diagnosis of the same occurrence). */
  describeContribution(kind: ContributionSource, sourceId: string, conceptId: string, label: string, description: string) {
    this.db
      .prepare("UPDATE misconception_contributions SET description = ? WHERE source_kind = ? AND source_id = ? AND concept_id = ? AND label = ? AND active = 1")
      .run(description, kind, sourceId, conceptId, label);
    this.rebuildMisconception(conceptId, label);
  }

  /**
   * Derive a misconception row purely from its active contributions, oldest first, with the
   * recording rules: a single guess is suspected, a repeat or a sure answer likely; the first
   * contribution's confidence, raised to sure by any sure one; the latest description given.
   * No active contributions deletes the row (nothing supports it any more). A resolution stands
   * while no active contribution is newer than it. The row keeps its id while it exists.
   */
  rebuildMisconception(conceptId: string, label: string): MisconceptionRow | undefined {
    const current = this.db.prepare("SELECT * FROM misconceptions WHERE concept_id = ? AND label = ?").get(conceptId, label) as MisconceptionRow | undefined;
    const cs = this.db
      .prepare("SELECT * FROM misconception_contributions WHERE concept_id = ? AND label = ? AND active = 1 ORDER BY created_at, id")
      .all(conceptId, label) as MisconceptionContribution[];
    if (!cs.length) {
      if (current) this.db.prepare("DELETE FROM misconceptions WHERE id = ?").run(current.id);
      return undefined;
    }
    const last = cs[cs.length - 1];
    const lastResolved = (
      this.db.prepare("SELECT MAX(resolved_at) AS t FROM misconception_resolutions WHERE concept_id = ? AND label = ?").get(conceptId, label) as { t: string | null }
    ).t;
    const resolved = lastResolved !== null && !cs.some((c) => c.created_at > lastResolved);
    const row: MisconceptionRow = {
      id: current?.id ?? newId(),
      concept_id: conceptId,
      label,
      description: [...cs].reverse().find((c) => c.description)?.description ?? null,
      status: resolved ? "resolved" : cs.length > 1 || cs[0].confidence === "sure" ? "likely" : "suspected",
      occurrences: cs.length,
      strongest_confidence: cs.some((c) => c.confidence === "sure") ? "sure" : cs[0].confidence,
      first_seen: cs[0].created_at,
      last_seen: last.created_at,
      resolved_at: resolved ? lastResolved : null,
    };
    this.db
      .prepare(
        "INSERT OR REPLACE INTO misconceptions VALUES (@id, @concept_id, @label, @description, @status, @occurrences, @strongest_confidence, @first_seen, @last_seen, @resolved_at)",
      )
      .run(row);
    return row;
  }

  misconceptions(conceptId?: string): MisconceptionRow[] {
    return (
      conceptId
        ? this.db.prepare("SELECT * FROM misconceptions WHERE concept_id = ? ORDER BY last_seen DESC").all(conceptId)
        : this.db.prepare("SELECT * FROM misconceptions ORDER BY last_seen DESC").all()
    ) as MisconceptionRow[];
  }
  activeMisconceptions(conceptId: string): MisconceptionRow[] {
    return this.misconceptions(conceptId).filter((m) => m.status !== "resolved");
  }
  /**
   * Resolve one misconception at `at`: recorded in the resolution history (tagged with the lesson
   * attempt that resolved it, when there is one), then the row rebuilt.
   */
  resolveMisconception(conceptId: string, label: string, at: string = now(), sourceAttemptId: string | null = null) {
    this.db
      .prepare("INSERT INTO misconception_resolutions (concept_id, label, resolved_at, source_attempt_id) VALUES (?, ?, ?, ?)")
      .run(conceptId, label, at, sourceAttemptId);
    return this.rebuildMisconception(conceptId, label);
  }
  /** Retract the resolutions one attempt made (its deferred reasoning turned out flawed), rebuilding each row. */
  retractResolutionsBy(attemptId: string) {
    const hits = this.db
      .prepare("SELECT DISTINCT concept_id, label FROM misconception_resolutions WHERE source_attempt_id = ?")
      .all(attemptId) as { concept_id: string; label: string }[];
    this.db.prepare("DELETE FROM misconception_resolutions WHERE source_attempt_id = ?").run(attemptId);
    for (const h of hits) this.rebuildMisconception(h.concept_id, h.label);
  }
  resolveMisconceptions(conceptId: string, at: string = now()) {
    for (const m of this.activeMisconceptions(conceptId)) this.resolveMisconception(conceptId, m.label, at);
  }

  logStrategy(conceptId: string, lessonId: string | null, strategy: Strategy, blockId: string | null) {
    this.db.prepare("INSERT INTO strategy_log (concept_id, lesson_id, strategy, block_id, outcome, created_at) VALUES (?, ?, ?, ?, NULL, ?)").run(
      conceptId, lessonId, strategy, blockId, now(),
    );
  }
  setLatestStrategyOutcome(conceptId: string, outcome: "worked" | "failed") {
    this.db
      .prepare(
        `UPDATE strategy_log SET outcome = ? WHERE id = (SELECT id FROM strategy_log WHERE concept_id = ? ORDER BY id DESC LIMIT 1) AND outcome IS NULL`,
      )
      .run(outcome, conceptId);
  }
  strategiesFor(conceptId: string): { strategy: Strategy; outcome: string | null }[] {
    return this.db.prepare("SELECT strategy, outcome FROM strategy_log WHERE concept_id = ? ORDER BY id").all(conceptId) as {
      strategy: Strategy;
      outcome: string | null;
    }[];
  }

  // ── AI jobs, cache, settings, events ──────────────────────────────────────
  createJob(lessonId: string | null, task: string, provider: string | null): JobRow {
    const row = { id: newId(), lesson_id: lessonId, task, status: "running", provider, partial_text: "", error_json: null, created_at: now(), finished_at: null };
    this.db.prepare("INSERT INTO ai_jobs VALUES (@id, @lesson_id, @task, @status, @provider, @partial_text, @error_json, @created_at, @finished_at)").run(row);
    return this.getJob(row.id)!;
  }
  savePartial(jobId: string, text: string) {
    this.db.prepare("UPDATE ai_jobs SET partial_text = ? WHERE id = ? AND status = 'running'").run(text, jobId);
  }
  finishJob(jobId: string, status: JobRow["status"], error?: unknown, provider?: string) {
    this.db
      .prepare("UPDATE ai_jobs SET status = ?, error_json = ?, finished_at = ?, provider = COALESCE(?, provider) WHERE id = ?")
      .run(status, error ? json(error) : null, now(), provider ?? null, jobId);
  }
  getJob(id: string): JobRow | undefined {
    const r = this.db.prepare("SELECT * FROM ai_jobs WHERE id = ?").get(id) as any;
    return r ? { ...r, error: parse(r.error_json, null) } : undefined;
  }
  jobsForLesson(lessonId: string): JobRow[] {
    return (this.db.prepare("SELECT * FROM ai_jobs WHERE lesson_id = ? ORDER BY created_at").all(lessonId) as any[]).map((r) => ({
      ...r,
      error: parse(r.error_json, null),
    }));
  }
  /** On boot: any job still "running" was cut off by a crash or restart. Its partial output is never used. */
  markInterruptedJobs(): number {
    // At boot nothing is evaluating, so a reasoning claim left 'running' by a crash goes back to the queue.
    this.db.prepare("UPDATE attempts SET reasoning_status = 'pending' WHERE reasoning_status = 'running'").run();
    return Number(
      this.db.prepare("UPDATE ai_jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now()).changes,
    );
  }
  cacheGet(key: string): unknown | undefined {
    const r = this.db.prepare("SELECT json FROM ai_cache WHERE key = ?").get(key) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }
  cachePut(key: string, task: string, value: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO ai_cache VALUES (?, ?, ?, ?)").run(key, task, json(value), now());
  }
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return r ? (JSON.parse(r.value_json) as T) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(key, json(value));
  }
  logEvent(lessonId: string | null, type: string, payload: unknown) {
    this.db.prepare("INSERT INTO events (lesson_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(lessonId, type, json(payload), now());
  }
  events(lessonId: string): { type: string; payload: any; created_at: string }[] {
    return (this.db.prepare("SELECT type, payload_json, created_at FROM events WHERE lesson_id = ? ORDER BY id").all(lessonId) as any[]).map((r) => ({
      type: r.type,
      payload: JSON.parse(r.payload_json),
      created_at: r.created_at,
    }));
  }
}

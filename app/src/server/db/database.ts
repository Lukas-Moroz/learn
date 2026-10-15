import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// Node's built-in SQLite (no native add-on to rebuild when Node changes). This thin
// adapter provides the small better-sqlite3-style surface the repository uses:
// prepare().run/get/all, exec, pragma, and nestable transactions (via savepoints).
type Params = unknown[];

export interface Statement {
  run(...params: Params): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: Params): unknown;
  all(...params: Params): unknown[];
}

export class DB {
  private readonly raw: DatabaseSync;
  private depth = 0;
  private cache = new Map<string, Statement>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
  }

  prepare(sql: string): Statement {
    let st = this.cache.get(sql);
    if (!st) {
      const s = this.raw.prepare(sql);
      // Accept either positional values or one object of named values (keys without the "@").
      const args = (p: Params) => (p.length === 1 && p[0] !== null && typeof p[0] === "object" ? [p[0] as Record<string, SQLInputValue>] : (p as SQLInputValue[]));
      st = {
        run: (...p) => s.run(...(args(p) as [SQLInputValue])),
        get: (...p) => s.get(...(args(p) as [SQLInputValue])),
        all: (...p) => s.all(...(args(p) as [SQLInputValue])),
      };
      this.cache.set(sql, st);
    }
    return st;
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  pragma(sql: string, opts: { simple?: boolean } = {}): unknown {
    const rows = this.raw.prepare(`PRAGMA ${sql}`).all() as Record<string, unknown>[];
    return opts.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
  }

  /** Returns a function that runs `fn` atomically. Nested calls become savepoints. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const outer = this.depth === 0;
      const sp = `sp${this.depth}`;
      this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const out = fn();
        this.depth--;
        this.raw.exec(outer ? "COMMIT" : `RELEASE ${sp}`);
        return out;
      } catch (e) {
        this.depth--;
        this.raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    };
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

// Append-only list of migrations. Never edit a shipped entry; add a new one.
export const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE courses (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);

  -- A document is the stable identity of a file across versions (local path or Drive id).
  CREATE TABLE documents (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
    key TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(course_id, key));

  -- A source is one immutable, content-addressed version of a document.
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
    sha256 TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, stored_path TEXT NOT NULL,
    page_count INTEGER NOT NULL, unit TEXT NOT NULL, version INTEGER NOT NULL,
    superseded_by TEXT, created_at TEXT NOT NULL, UNIQUE(document_id, sha256));
  CREATE INDEX sources_sha ON sources(sha256);

  CREATE TABLE source_pages (source_id TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY(source_id, page));

  -- Expensive AI analysis keyed by content hash, so unchanged files are never re-analysed.
  CREATE TABLE analyses (sha256 TEXT NOT NULL, prompt_version TEXT NOT NULL, json TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(sha256, prompt_version));

  CREATE TABLE lectures (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id), title TEXT NOT NULL,
    position INTEGER NOT NULL, document_id TEXT REFERENCES documents(id), created_at TEXT NOT NULL);

  -- Shared cross-course concept graph.
  CREATE TABLE concepts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, sense TEXT,
    definition TEXT NOT NULL, created_at TEXT NOT NULL);
  -- Course-specific interpretation of a shared concept.
  CREATE TABLE concept_contexts (
    concept_id TEXT NOT NULL REFERENCES concepts(id), course_id TEXT NOT NULL REFERENCES courses(id),
    interpretation TEXT, PRIMARY KEY(concept_id, course_id));
  -- (concept_id) --kind--> (related_id); for "prerequisite", related_id is needed first.
  CREATE TABLE concept_edges (
    concept_id TEXT NOT NULL, related_id TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY(concept_id, related_id, kind));

  CREATE TABLE lecture_concepts (
    lecture_id TEXT NOT NULL REFERENCES lectures(id), concept_id TEXT NOT NULL REFERENCES concepts(id),
    role TEXT NOT NULL, position INTEGER NOT NULL, pages_json TEXT NOT NULL, section TEXT,
    PRIMARY KEY(lecture_id, concept_id));

  CREATE TABLE lessons (
    id TEXT PRIMARY KEY, course_id TEXT REFERENCES courses(id), lecture_id TEXT REFERENCES lectures(id),
    source_id TEXT REFERENCES sources(id), objective TEXT, title TEXT NOT NULL,
    state_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE blocks (
    id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), seq INTEGER NOT NULL,
    type TEXT NOT NULL, concept_id TEXT, payload_json TEXT NOT NULL, refs_json TEXT NOT NULL,
    provenance TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(lesson_id, seq));

  CREATE TABLE questions (
    id TEXT PRIMARY KEY, lesson_id TEXT REFERENCES lessons(id), block_id TEXT,
    concept_id TEXT NOT NULL REFERENCES concepts(id), purpose TEXT NOT NULL, kind TEXT NOT NULL,
    context TEXT NOT NULL, scenario TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT NOT NULL,
    correct_json TEXT NOT NULL, multi_select INTEGER NOT NULL, explanation TEXT NOT NULL,
    rubric_json TEXT NOT NULL, difficulty INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX questions_concept ON questions(concept_id);

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id), lesson_id TEXT,
    selected_json TEXT NOT NULL, dont_know INTEGER NOT NULL, confidence TEXT, note TEXT,
    correct INTEGER, misconceptions_json TEXT NOT NULL,
    reasoning_status TEXT NOT NULL, reasoning_json TEXT, created_at TEXT NOT NULL);
  CREATE INDEX attempts_question ON attempts(question_id);

  CREATE TABLE evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, course_id TEXT,
    dimension TEXT NOT NULL, delta REAL NOT NULL, note TEXT, attempt_id TEXT, created_at TEXT NOT NULL);
  CREATE INDEX evidence_concept ON evidence(concept_id);

  CREATE TABLE misconceptions (
    id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, label TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL, occurrences INTEGER NOT NULL, strongest_confidence TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT,
    UNIQUE(concept_id, label));

  -- Which teaching strategies were used per concept, and whether the next check succeeded.
  CREATE TABLE strategy_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, lesson_id TEXT, strategy TEXT NOT NULL,
    block_id TEXT, outcome TEXT, created_at TEXT NOT NULL);

  -- Streaming generation. Content is only turned into blocks when a job completes and validates.
  CREATE TABLE ai_jobs (
    id TEXT PRIMARY KEY, lesson_id TEXT, task TEXT NOT NULL, status TEXT NOT NULL, provider TEXT,
    partial_text TEXT NOT NULL DEFAULT '', error_json TEXT, created_at TEXT NOT NULL, finished_at TEXT);

  CREATE TABLE ai_cache (key TEXT PRIMARY KEY, task TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL);
  `,
  /* 2 */ `
  -- A document used as a practice set's problems or solutions is not a lecture.
  ALTER TABLE lectures ADD COLUMN role TEXT NOT NULL DEFAULT 'lecture';

  -- Exam practice: worked problems extracted from a study guide, keyed from its solutions.
  CREATE TABLE practice_sets (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
    problem_source_id TEXT NOT NULL REFERENCES sources(id), solution_source_id TEXT REFERENCES sources(id),
    problem_sha TEXT NOT NULL, solution_sha TEXT, title TEXT NOT NULL, key_source TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, outline_json TEXT, progress_total INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  -- Same documents in the same course, same set.
  CREATE UNIQUE INDEX practice_sets_pair ON practice_sets(course_id, problem_sha, COALESCE(solution_sha, ''));

  -- One row per outline problem, inserted only once it validated (position = outline index).
  CREATE TABLE practice_problems (
    id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES practice_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL, intro TEXT NOT NULL,
    concepts_json TEXT NOT NULL, keywords_json TEXT NOT NULL, taught_in_json TEXT NOT NULL,
    taught_in_sig TEXT NOT NULL, problem_refs_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(set_id, position));

  CREATE TABLE practice_steps (
    id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES practice_problems(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, label TEXT NOT NULL, prompt TEXT NOT NULL, kind TEXT NOT NULL,
    key_json TEXT NOT NULL, solution TEXT NOT NULL, hint TEXT, concepts_json TEXT NOT NULL,
    solution_refs_json TEXT NOT NULL, UNIQUE(problem_id, position));

  CREATE TABLE practice_attempts (
    id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES practice_steps(id) ON DELETE CASCADE,
    value_json TEXT, dont_know INTEGER NOT NULL, confidence TEXT, correct INTEGER, score REAL,
    cell_results_json TEXT, feedback TEXT NOT NULL, grading_status TEXT NOT NULL, grade_json TEXT,
    overridden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE INDEX practice_attempts_step ON practice_attempts(step_id);
  CREATE INDEX evidence_attempt ON evidence(attempt_id);
  -- The misconception ledger: every occurrence of a misconception, keyed by what produced it.
  -- A misconceptions row is derived from its active contributions (see Repo.rebuildMisconception);
  -- retracting an occurrence deactivates its contribution. Never deleted with a practice set.
  CREATE TABLE misconception_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, label TEXT NOT NULL,
    source_kind TEXT NOT NULL, source_id TEXT, confidence TEXT, description TEXT,
    created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  CREATE INDEX misconception_contributions_label ON misconception_contributions(concept_id, label);
  CREATE INDEX misconception_contributions_source ON misconception_contributions(source_kind, source_id);
  -- One contribution per (source, concept, label): an attempt counts a misconception once.
  CREATE UNIQUE INDEX misconception_contributions_unique
    ON misconception_contributions(source_kind, source_id, concept_id, label) WHERE source_id IS NOT NULL;
  -- Resolution history, kept apart from the derived row so recording (or retracting) an occurrence
  -- never erases a resolution: a row is resolved while no active contribution is newer than its
  -- latest resolution (see Repo.rebuildMisconception).
  CREATE TABLE misconception_resolutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, label TEXT NOT NULL, resolved_at TEXT NOT NULL,
    -- The lesson attempt whose answer resolved it (null for untracked resolutions), so a deferred
    -- diagnosis of that same attempt can retract its own resolution.
    source_attempt_id TEXT);
  CREATE INDEX misconception_resolutions_label ON misconception_resolutions(concept_id, label);
  INSERT INTO misconception_resolutions (concept_id, label, resolved_at)
    SELECT concept_id, label, resolved_at FROM misconceptions WHERE status = 'resolved' AND resolved_at IS NOT NULL;
  -- The contribution backfill from v1 rows and attempts runs in MIGRATION_STEPS[2].
  `,
  /* 3 */ `
  -- Guided practice. "I don't know" no longer shows the key; only "Show solution" does, so a
  -- reveal is marked on the attempt. Until now every "I don't know" attempt was a reveal.
  ALTER TABLE practice_attempts ADD COLUMN revealed INTEGER NOT NULL DEFAULT 0;
  UPDATE practice_attempts SET revealed = 1 WHERE dont_know = 1;

  -- Warm-up before a problem: probing questions on the ideas it assumes (one row per problem).
  -- status: pending | waiting (no provider; retried later) | failed | ready | none (nothing to probe).
  CREATE TABLE practice_primers (
    problem_id TEXT PRIMARY KEY REFERENCES practice_problems(id) ON DELETE CASCADE,
    status TEXT NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, content_json TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE practice_probe_answers (
    id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES practice_problems(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, selected_json TEXT NOT NULL, dont_know INTEGER NOT NULL, confidence TEXT,
    correct INTEGER, created_at TEXT NOT NULL, UNIQUE(problem_id, idx));

  -- Coaching after an unsuccessful attempt (one per attempt), with its check question's answer.
  CREATE TABLE practice_coaching (
    id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES practice_steps(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL UNIQUE, round INTEGER NOT NULL, status TEXT NOT NULL,
    content_json TEXT, refs_json TEXT, error TEXT,
    check_selected_json TEXT, check_dont_know INTEGER, check_confidence TEXT, check_correct INTEGER, checked_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX practice_coaching_step ON practice_coaching(step_id);
  `,
  /* 4 */ `
  -- Follow-up questions: one thread per thing answered (a practice step, a coaching round, or a
  -- lesson block), each question and its answer a turn. Answers are generated like other content:
  -- a turn is "ready" only once its answer validated. status: pending | waiting | failed | ready.
  CREATE TABLE follow_up_threads (
    id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, lesson_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(target_kind, target_id));
  CREATE TABLE follow_up_turns (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES follow_up_threads(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT, refs_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, answered_at TEXT,
    UNIQUE(thread_id, position));
  CREATE INDEX follow_up_turns_status ON follow_up_turns(status);
  `,
  /* 5 */ `
  -- Navigation choice, separate from answers and mastery evidence.
  ALTER TABLE practice_steps ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
  `,
];

type V1Row = { concept_id: string; label: string; description: string | null; occurrences: number; strongest_confidence: string | null; first_seen: string; last_seen: string };
type V1Hit = { attempt_id: string; confidence: string | null; created_at: string };

/**
 * Code run after a migration's SQL, in the same transaction (keyed by the version it produces).
 * 2: backfill the ledger from v1 data. Every v1 attempt contributes one 'lesson' contribution per
 * distinct (concept, label) in its misconceptions_json, with the attempt's own confidence and
 * created_at (source-owned values are never adjusted). A label listed twice in one v1 attempt
 * counts once: v1's double counts are dropped (and not replaced by anonymous occurrences). Then each v1 row gets anonymous 'other'
 * contributions only for occurrences beyond those v1 attempts listed (carrying the row's description,
 * at first_seen/last_seen; confidence null, except strongest_confidence on one if no attributed
 * contribution already reaches it). Rebuilt rows may therefore differ slightly from v1 (e.g.
 * fewer occurrences where v1 double-counted); that is intended.
 */
export const MIGRATION_STEPS: Record<number, (db: DB) => void> = {
  2: (db) => {
    const ins = db.prepare(
      `INSERT INTO misconception_contributions (concept_id, label, source_kind, source_id, confidence, description, created_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const hits = db
      .prepare(
        `SELECT DISTINCT q.concept_id, j.value AS label, a.id AS attempt_id, a.confidence, a.created_at
           FROM attempts a JOIN questions q ON q.id = a.question_id, json_each(a.misconceptions_json) j
          WHERE j.type = 'text' ORDER BY a.created_at, a.id`,
      )
      .all() as (V1Hit & { concept_id: string; label: string })[];
    const descs = new Map<string, string | null>();
    for (const m of db.prepare("SELECT concept_id, label, description FROM misconceptions").all() as V1Row[]) descs.set(`${m.concept_id}\u0000${m.label}`, m.description);
    for (const h of hits) {
      const k = `${h.concept_id}\u0000${h.label}`;
      // Only labels v1 still tracks; an attempt whose row is gone has nothing to back.
      if (descs.has(k)) ins.run(h.concept_id, h.label, "lesson", h.attempt_id, h.confidence, descs.get(k) ?? null, h.created_at);
    }
    const attributed = db.prepare("SELECT confidence FROM misconception_contributions WHERE concept_id = ? AND label = ?");
    // v1 counted every listed label, duplicates included: those occurrences are accounted for by
    // the (deduplicated) attempt contributions, so they never turn into anonymous ones.
    const v1Listed = db.prepare(
      `SELECT COUNT(*) AS n FROM attempts a JOIN questions q ON q.id = a.question_id, json_each(a.misconceptions_json) j
        WHERE q.concept_id = ? AND j.value = ?`,
    );
    for (const m of db.prepare("SELECT * FROM misconceptions ORDER BY id").all() as V1Row[]) {
      const have = attributed.all(m.concept_id, m.label) as { confidence: string | null }[];
      const extra = m.occurrences - (v1Listed.get(m.concept_id, m.label) as { n: number }).n;
      if (extra < 1) continue;
      const reached = m.strongest_confidence === null || have.some((c) => c.confidence === m.strongest_confidence);
      for (let i = 0; i < extra; i++) {
        const confidence = i === 0 && !reached ? m.strongest_confidence : null;
        const at = i === 0 ? m.first_seen : m.last_seen;
        ins.run(m.concept_id, m.label, "other", null, confidence, m.description, at);
      }
    }
  },
};

export function openDatabase(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DB(file);
  db.pragma("journal_mode = WAL");
  // FULL: an answer the server acknowledged survives power loss, not just a process crash.
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      MIGRATION_STEPS[v + 1]?.(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

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
const MIGRATIONS: string[] = [
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
];

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
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

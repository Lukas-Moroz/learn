// Follow-up threads and their turns (question → answer), in the main database.
import type { Repo } from "../db/repo.ts";
import { newId, now } from "../db/repo.ts";
import { provenanceFor } from "../alignment/refs.ts";
import type { FollowUpStatus, FollowUpTargetKind, FollowUpThreadView, FollowUpTurnView } from "../../shared/followup.ts";
import type { SourceRef } from "../../shared/schemas.ts";

export interface FollowUpThreadRow {
  id: string; target_kind: FollowUpTargetKind; target_id: string; lesson_id: string | null; created_at: string; updated_at: string;
}
export interface FollowUpTurnRow {
  id: string; thread_id: string; position: number; question: string; answer: string | null; refs: SourceRef[];
  status: FollowUpStatus; error: string | null; created_at: string; answered_at: string | null;
}

export class FollowUpRepo {
  constructor(readonly repo: Repo) {}

  private get db() {
    return this.repo.db;
  }

  thread(kind: FollowUpTargetKind, targetId: string): FollowUpThreadRow | undefined {
    return this.db.prepare("SELECT * FROM follow_up_threads WHERE target_kind = ? AND target_id = ?").get(kind, targetId) as FollowUpThreadRow | undefined;
  }
  getThread(id: string): FollowUpThreadRow | undefined {
    return this.db.prepare("SELECT * FROM follow_up_threads WHERE id = ?").get(id) as FollowUpThreadRow | undefined;
  }
  ensureThread(kind: FollowUpTargetKind, targetId: string, lessonId: string | null): FollowUpThreadRow {
    const found = this.thread(kind, targetId);
    if (found) return found;
    const t = now();
    this.db
      .prepare("INSERT INTO follow_up_threads (id, target_kind, target_id, lesson_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), kind, targetId, lessonId, t, t);
    return this.thread(kind, targetId)!;
  }
  /** Threads of one lesson's blocks, by block id. */
  threadsForLesson(lessonId: string): Map<string, FollowUpThreadView> {
    const rows = this.db.prepare("SELECT * FROM follow_up_threads WHERE lesson_id = ? AND target_kind = 'lesson_block'").all(lessonId) as FollowUpThreadRow[];
    return new Map(rows.map((r) => [r.target_id, this.toView(r)]));
  }

  /** Oldest first. */
  turns(threadId: string): FollowUpTurnRow[] {
    return (this.db.prepare("SELECT * FROM follow_up_turns WHERE thread_id = ? ORDER BY position").all(threadId) as any[]).map(toTurn);
  }
  getTurn(id: string): FollowUpTurnRow | undefined {
    const r = this.db.prepare("SELECT * FROM follow_up_turns WHERE id = ?").get(id);
    return r ? toTurn(r) : undefined;
  }
  turnsWithStatus(status: FollowUpStatus): FollowUpTurnRow[] {
    return (this.db.prepare("SELECT * FROM follow_up_turns WHERE status = ? ORDER BY created_at").all(status) as any[]).map(toTurn);
  }
  insertTurn(threadId: string, question: string): FollowUpTurnRow {
    return this.repo.tx(() => {
      const position = ((this.db.prepare("SELECT MAX(position) AS m FROM follow_up_turns WHERE thread_id = ?").get(threadId) as { m: number | null }).m ?? -1) + 1;
      const id = newId();
      const t = now();
      this.db
        .prepare("INSERT INTO follow_up_turns (id, thread_id, position, question, answer, refs_json, status, error, created_at) VALUES (?, ?, ?, ?, NULL, '[]', 'pending', NULL, ?)")
        .run(id, threadId, position, question, t);
      this.db.prepare("UPDATE follow_up_threads SET updated_at = ? WHERE id = ?").run(t, threadId);
      return this.getTurn(id)!;
    });
  }
  setTurn(id: string, patch: { status: FollowUpStatus; answer?: string; refs?: SourceRef[]; error?: string | null }) {
    const cur = this.getTurn(id);
    if (!cur) return;
    this.db
      .prepare("UPDATE follow_up_turns SET status = ?, answer = ?, refs_json = ?, error = ?, answered_at = ? WHERE id = ?")
      .run(
        patch.status,
        patch.answer ?? cur.answer,
        JSON.stringify(patch.refs ?? cur.refs),
        patch.error !== undefined ? patch.error : cur.error,
        patch.status === "ready" ? now() : cur.answered_at,
        id,
      );
  }
  /** On boot: answers cut off by a restart wait to be retried (their partial text is never used). */
  interrupt(): number {
    return Number(this.db.prepare("UPDATE follow_up_turns SET status = 'waiting', error = ? WHERE status = 'pending'").run("Stopped when Learn was closed.").changes);
  }

  view(kind: FollowUpTargetKind, targetId: string): FollowUpThreadView | null {
    const t = this.thread(kind, targetId);
    return t ? this.toView(t) : null;
  }
  toView(t: FollowUpThreadRow): FollowUpThreadView {
    return { id: t.id, kind: t.target_kind, targetId: t.target_id, turns: this.turns(t.id).map(turnView) };
  }
}

export function turnView(t: FollowUpTurnRow): FollowUpTurnView {
  return {
    id: t.id,
    question: t.question,
    answer: t.status === "ready" ? t.answer : null,
    refs: t.status === "ready" ? t.refs : [],
    provenance: t.status === "ready" ? provenanceFor(t.refs) : "supplementary",
    status: t.status,
    error: t.status === "ready" ? null : t.error,
    createdAt: t.created_at,
  };
}

function toTurn(r: any): FollowUpTurnRow {
  const { refs_json, ...rest } = r;
  return { ...rest, refs: refs_json ? JSON.parse(refs_json) : [] };
}

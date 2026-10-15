// In-process pub/sub for live progress (SSE). Purely a UI convenience: nothing
// here is authoritative; the database is.
import { EventEmitter } from "node:events";

export interface LiveEvent {
  type: "job" | "lesson" | "provider" | "practice" | "followup";
  lessonId?: string | null;
  jobId?: string;
  task?: string;
  /** practice: the set's status ("extracting" | "ready" | "failed" | "deleted"), or "graded" when a free-text grade lands. */
  status?: string;
  chars?: number;
  error?: unknown;
  setId?: string;
  problemId?: string;
  stepId?: string;
  /** job: the concept an explanation or question is about. */
  conceptId?: string;
  /** job: the lecture a source analysis is for. */
  lectureId?: string;
  /** job: the guided-practice coaching row being generated. */
  coachingId?: string;
  /** job / followup: the follow-up turn being answered, and its thread. */
  followUpId?: string;
  threadId?: string;
  /**
   * job (running): live preview of the response's text fields so far (display only, never
   * committed). null once withheld (it would give a practice key away).
   */
  preview?: Record<string, string> | null;
  /** job: this attempt's output will not be used and another is on its way (failed validation, or a withheld preview). */
  revising?: boolean;
  /** practice extraction progress: problems extracted so far / problems in the outline (null until known). */
  done?: number;
  total?: number | null;
}

export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  publish(ev: LiveEvent) {
    this.emitter.emit("event", ev);
  }
  subscribe(fn: (ev: LiveEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}

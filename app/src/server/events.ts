// In-process pub/sub for live progress (SSE). Purely a UI convenience: nothing
// here is authoritative; the database is.
import { EventEmitter } from "node:events";

export interface LiveEvent {
  type: "job" | "lesson" | "provider";
  lessonId?: string | null;
  jobId?: string;
  task?: string;
  status?: string;
  chars?: number;
  error?: unknown;
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

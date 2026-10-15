// Live generation progress from the server's "job" and "lesson" events (relayed by App from the
// shared /api/events stream), and the streaming preview of text being written. A preview is only
// a display aid: the validated block replaces it, and nothing in it is ever saved.
import { useCallback, useEffect, useRef, useState } from "react";

export const JOB_EVENT = "learn:job";
export const LESSON_EVENT = "learn:lesson";

/** Server-sent "job" event (see src/server/events.ts). */
export interface JobEvent {
  type: "job";
  jobId: string;
  task: string;
  status: "running" | "completed" | "failed";
  lessonId?: string | null;
  conceptId?: string;
  /** Source analysis: the lecture being read. */
  lectureId?: string;
  setId?: string;
  problemId?: string;
  stepId?: string;
  coachingId?: string;
  /** Follow-up answers: the turn being answered and its thread. */
  followUpId?: string;
  threadId?: string;
  chars?: number;
  /** Text of the response's fields so far; null once withheld. */
  preview?: Record<string, string> | null;
  /** This output won't be used; another attempt is on its way. */
  revising?: boolean;
  error?: { code: string; message: string };
}

export function relayJobEvent(ev: JobEvent) {
  window.dispatchEvent(new CustomEvent<JobEvent>(JOB_EVENT, { detail: ev }));
}

/** Server-sent "followup" event: a follow-up turn changed status (pending, waiting, failed, ready). */
export interface FollowUpEvent {
  type: "followup";
  threadId: string;
  followUpId: string;
  status: string;
  lessonId?: string | null;
}
export const FOLLOWUP_EVENT = "learn:followup";

export function relayFollowUpEvent(ev: FollowUpEvent) {
  window.dispatchEvent(new CustomEvent<FollowUpEvent>(FOLLOWUP_EVENT, { detail: ev }));
}

/** Calls `fn` for every follow-up event (latest `fn`, without resubscribing). */
export function useFollowUpEvents(fn: (ev: FollowUpEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const on = (e: Event) => ref.current((e as CustomEvent<FollowUpEvent>).detail);
    window.addEventListener(FOLLOWUP_EVENT, on);
    return () => window.removeEventListener(FOLLOWUP_EVENT, on);
  }, []);
}

// ── Follow-up activity: an answer being written, or a question typed but not sent ──
// Pages read it so nothing moves on underneath the learner (a lesson's Continue waits for the answer).

type Activity = { scope: string; answering: boolean; unsent: boolean };
const activity = new Map<string, Activity>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function reportFollowUpActivity(id: string, a: Activity | null) {
  const cur = activity.get(id);
  if (a === null ? !cur : cur && cur.scope === a.scope && cur.answering === a.answering && cur.unsent === a.unsent) return;
  if (a) activity.set(id, a);
  else activity.delete(id);
  notify();
}

/** Whether any follow-up box in `scope` (all boxes when omitted) is answering, or holds unsent text. */
export function useFollowUpActivity(scope?: string): { answering: boolean; unsent: boolean } {
  const read = () => {
    let answering = false;
    let unsent = false;
    for (const a of activity.values()) {
      if (scope !== undefined && a.scope !== scope) continue;
      answering ||= a.answering;
      unsent ||= a.unsent;
    }
    return { answering, unsent };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const on = () => setState((s) => {
      const n = read();
      return n.answering === s.answering && n.unsent === s.unsent ? s : n;
    });
    listeners.add(on);
    on();
    return () => void listeners.delete(on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  return state;
}

export function relayLessonEvent(ev: { type: "lesson"; lessonId?: string | null }) {
  window.dispatchEvent(new CustomEvent(LESSON_EVENT, { detail: ev }));
}

/** Calls `fn` for every job event (latest `fn`, without resubscribing). */
export function useJobEvents(fn: (ev: JobEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const on = (e: Event) => ref.current((e as CustomEvent<JobEvent>).detail);
    window.addEventListener(JOB_EVENT, on);
    return () => window.removeEventListener(JOB_EVENT, on);
  }, []);
}

export interface LivePreview {
  /** Field → text so far, or null when there is nothing to show. */
  fields: Record<string, string> | null;
  /** The output is being revised (failed checks, or withheld): the preview was cleared. */
  revising: boolean;
  /** The stream finished and validated; the committed block is on its way. */
  done: boolean;
  /** The latest matching event (for ids such as conceptId). */
  event: JobEvent | null;
}

const EMPTY: LivePreview = { fields: null, revising: false, done: false, event: null };

/**
 * The streaming preview of the generation `match` selects. A failed attempt that will be retried
 * shows "revising" (preview cleared); a final failure clears everything. `reset` clears it once the
 * validated block is on screen.
 */
export function useLivePreview(match: (ev: JobEvent) => boolean): LivePreview & { reset: () => void } {
  const [state, setState] = useState<LivePreview>(EMPTY);
  const matcher = useRef(match);
  matcher.current = match;
  useJobEvents((ev) => {
    if (!matcher.current(ev)) return;
    if (ev.status === "running") {
      if (ev.preview) setState({ fields: ev.preview, revising: false, done: false, event: ev });
      else if (ev.revising) setState({ fields: null, revising: true, done: false, event: ev });
    } else if (ev.status === "completed") setState((s) => ({ ...s, revising: false, done: true, event: ev }));
    else setState(ev.revising ? { fields: null, revising: true, done: false, event: ev } : EMPTY);
  });
  const reset = useCallback(() => setState(EMPTY), []);
  return { ...state, reset };
}

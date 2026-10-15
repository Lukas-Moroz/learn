// Keeps a practice view current: practice events from the server (relayed by App from /api/events),
// a refetch when the tab becomes visible again (events missed while asleep), and an optional slow poll.
import { useEffect, useRef } from "react";
import type { PracticeEvent } from "./api.ts";

export const PRACTICE_EVENT = "learn:practice";

/** Called by App for every practice event on the shared EventSource. */
export function relayPracticeEvent(ev: PracticeEvent) {
  window.dispatchEvent(new CustomEvent<PracticeEvent>(PRACTICE_EVENT, { detail: ev }));
}

/**
 * Runs `refresh` (coalesced: at most one call per 400ms burst) when a matching event arrives,
 * when the window regains focus or visibility, and every `pollMs` while set (and the tab is visible).
 */
export function usePracticeLive(refresh: () => unknown, { match, pollMs }: { match: (ev: PracticeEvent) => boolean; pollMs: number | null }) {
  const fn = useRef(refresh);
  fn.current = refresh;
  const matcher = useRef(match);
  matcher.current = match;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fn.current();
      }, 400);
    };
    const onEvent = (e: Event) => {
      if (matcher.current((e as CustomEvent<PracticeEvent>).detail)) soon();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") soon();
    };
    window.addEventListener(PRACTICE_EVENT, onEvent);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(PRACTICE_EVENT, onEvent);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fn.current();
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
}

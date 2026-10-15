// Honest progress while something is generated: an elapsed-time hint (only once it is slow),
// skeletons laid out like the content that replaces them, and the live preview of a question
// being written (its stem; the options appear only once the whole question has validated).
import { useEffect, useState } from "react";
import { Writing, Revising } from "./Blocks.tsx";
import { PreviewMarkdown } from "./Markdown.tsx";

/** Whole seconds since `active` became true (0 while inactive). */
export function useElapsed(active: boolean): number {
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setStart(null);
      return;
    }
    const t0 = Date.now();
    setStart(t0);
    setNow(t0);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return start === null ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

/** True once `active` has stayed true for `ms` (so a skeleton doesn't flash for instant content). */
export function useDelayed(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return on;
}

export function formatElapsed(s: number): string {
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** " · 14 s" after ten seconds of `active`; nothing before (a quick step needs no clock). */
export function Elapsed({ active = true, after = 10 }: { active?: boolean; after?: number }) {
  const s = useElapsed(active);
  if (s < after) return null;
  return (
    <span className="elapsed muted" aria-hidden>
      {" "}
      · {formatElapsed(s)}
    </span>
  );
}

/** Grey placeholder lines (decorative). */
export function SkeletonLines({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton-lines ${className}`} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" style={{ width: i === lines - 1 ? "62%" : i % 2 ? "92%" : "100%" }} />
      ))}
    </div>
  );
}

/**
 * A question being written, laid out like the QuestionCard that replaces it: the stem as it
 * streams (or a skeleton until it starts), and placeholder options. The options and the answer
 * are never previewed; they arrive with the validated question.
 */
export function QuestionPreview({ stem, revising = false, kicker = "Question", options = 4 }: { stem?: string | null; revising?: boolean; kicker?: string; options?: number }) {
  return (
    <div className="question preview" aria-busy="true" aria-live="off" aria-label="Question being written">
      <div className="row">
        <span className="kicker">{kicker}</span>
        {!revising && <Writing />}
      </div>
      {revising ? (
        <Revising what="the question" />
      ) : (
        <div className="stem">{stem ? <PreviewMarkdown text={stem} /> : <SkeletonLines lines={2} />}</div>
      )}
      <div className="options" aria-hidden>
        {Array.from({ length: options }, (_, i) => (
          <div key={i} className="option skeleton-option">
            <span className="key">{i + 1}</span>
            <span className="skeleton-line" style={{ width: `${70 - ((i * 13) % 30)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

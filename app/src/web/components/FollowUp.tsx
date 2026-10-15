// "Ask a follow-up": a question box under something the learner just answered or read, and the
// thread of questions and answers below it. The answer streams in as it is written (a practice
// preview was leak-checked by the server first); nothing here moves the page on by itself.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { FollowUpTargetKind, FollowUpThreadView, FollowUpTurnView } from "../../shared/followup.ts";
import { api, ApiError, errorMessage } from "../api.ts";
import { reportFollowUpActivity, useFollowUpEvents, useLivePreview } from "../liveJobs.ts";
import { RefChip, Revising, Writing } from "./Blocks.tsx";
import { Elapsed } from "./Progress.tsx";
import { Markdown, PreviewMarkdown } from "./Markdown.tsx";
import type { SourceTarget } from "./SourceDrawer.tsx";
import { useShell } from "./TopBar.tsx";

const draftKey = (kind: string, id: string) => `learn:followup-draft:${kind}:${id}`;
function loadDraft(kind: string, id: string): string {
  try {
    return localStorage.getItem(draftKey(kind, id)) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(kind: string, id: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(draftKey(kind, id), text);
    else localStorage.removeItem(draftKey(kind, id));
  } catch {
    // storage unavailable: the draft lives in component state only
  }
}

/** The fresher of two copies of a thread (a slow page refetch must not hide a question just asked). */
function fresher(a: FollowUpThreadView | null, b: FollowUpThreadView | null): FollowUpThreadView | null {
  if (!a || !b) return a ?? b;
  const score = (t: FollowUpThreadView) => t.turns.length * 100 + t.turns.filter((x) => x.status === "ready").length * 10 + t.turns.filter((x) => x.status !== "pending").length;
  return score(b) >= score(a) ? b : a;
}

const unanswered = (t: FollowUpTurnView) => t.status === "pending" || t.status === "waiting";

export function FollowUpBox({
  kind,
  targetId,
  thread: initial,
  openSource,
  scope,
  collapsible = false,
  label = "Ask a follow-up",
  placeholder = "What's still unclear? Ask about this answer, the idea behind it, or a step you'd like explained…",
}: {
  kind: FollowUpTargetKind;
  targetId: string;
  thread: FollowUpThreadView | null | undefined;
  openSource: (t: SourceTarget) => void;
  /** Activity scope (a step id, a lesson id) so the page can hold back while an answer is coming. */
  scope: string;
  /** Start as a small "Ask a follow-up" button (lessons, where every block has one). */
  collapsible?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const ids = useId();
  const { status: shell } = useShell();
  const [thread, setThread] = useState<FollowUpThreadView | null>(initial ?? null);
  const [text, setText] = useState(() => loadDraft(kind, targetId));
  const [open, setOpen] = useState(() => !collapsible || Boolean(initial?.turns.length) || loadDraft(kind, targetId).trim() !== "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;

  useEffect(() => setThread((t) => fresher(t, initial ?? null)), [initial]);
  useEffect(() => saveDraft(kind, targetId, text), [kind, targetId, text]);

  const turns = thread?.turns ?? [];
  const waitingTurn = turns.find(unanswered);
  const answering = busy || turns.some((t) => t.status === "pending");
  useEffect(() => {
    reportFollowUpActivity(ids, { scope, answering, unsent: text.trim() !== "" });
  }, [ids, scope, answering, text]);
  useEffect(() => () => reportFollowUpActivity(ids, null), [ids]);

  // The answer as it is being written.
  const live = useLivePreview((ev) => ev.task === "follow_up" && Boolean(threadRef.current) && ev.threadId === threadRef.current!.id);
  const resetLive = live.reset;

  const refresh = useCallback(async () => {
    const id = threadRef.current?.id;
    if (!id) return;
    try {
      const t = await api.followUpThread(id);
      setThread((cur) => fresher(cur, t));
      return t;
    } catch {
      return undefined;
    }
  }, []);
  useFollowUpEvents((ev) => {
    if (ev.threadId !== threadRef.current?.id) return;
    refresh().then((t) => {
      if (!t || t.turns.some((x) => x.status === "pending")) return;
      resetLive();
      const last = t.turns.at(-1);
      if (last?.status === "ready" && ev.status === "ready") setAnnounce("Answer ready.");
    });
  });

  const ask = async () => {
    const question = text.trim();
    if (busy) return;
    if (!question) {
      setError("Type a question first.");
      field.current?.focus();
      return;
    }
    if (waitingTurn) {
      setError("Your last question is still waiting for its answer. Ask the next one once it's there.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await api.askFollowUp(kind, targetId, question);
      resetLive();
      setThread((cur) => fresher(cur, t));
      setText("");
    } catch (e) {
      setError(e instanceof ApiError && e.paused ? `AI generation is paused: ${e.paused.reason}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (turnId: string) => {
    setError(null);
    try {
      const t = await api.retryFollowUp(turnId);
      resetLive();
      setThread((cur) => fresher(cur, t));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // ⌘/Ctrl + Enter asks; it never reaches the page (a lesson's own ⌘/Ctrl + Enter means "Continue").
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      ask();
    }
  };

  if (!open) {
    return (
      <div className="followup collapsed">
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => field.current?.focus());
          }}
        >
          {label}
        </button>
      </div>
    );
  }

  const answerOf = (t: FollowUpTurnView, latest: boolean) => {
    if (t.status === "ready") {
      return (
        <>
          <Markdown text={t.answer ?? ""} />
          {t.refs.length > 0 && (
            <div className="provenance">
              <span className="kicker">From the lecture</span>
              {t.refs.map((r, i) => (
                <RefChip key={i} r={r} open={openSource} />
              ))}
            </div>
          )}
        </>
      );
    }
    if (t.status === "pending") {
      if (latest && live.revising) return <Revising what="the answer" />;
      if (latest && live.fields?.answer)
        return (
          <div className="preview" aria-live="off" aria-busy="true">
            <PreviewMarkdown text={live.fields.answer} />
            <Writing />
          </div>
        );
      return (
        <p className="working small">
          <span className="spinner" aria-hidden />
          <span className="grow">
            Thinking about your question…
            <Elapsed />
          </span>
        </p>
      );
    }
    const paused = t.status === "waiting" && shell?.paused;
    return (
      <div className="guide-state">
        <p className="small guide-wait">
          {t.status === "waiting" ? (
            <>
              <b>Waiting for AI.</b> {paused ? shell!.paused!.reason : t.error} Your question is saved and will be answered once a provider is available.
            </>
          ) : (
            <>
              <b>Couldn't answer this one.</b> {t.error}
            </>
          )}
        </p>
        {!paused && (
          <button type="button" className="btn small" onClick={() => retry(t.id)}>
            Try again
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="followup" aria-labelledby={`${ids}-label`}>
      {turns.length > 0 && (
        <ol className="fu-thread">
          {turns.map((t, i) => (
            <li key={t.id} className="fu-turn">
              <div className="fu-q">
                <span className="kicker">You asked</span>
                <p>{t.question}</p>
              </div>
              <div className="fu-a">{answerOf(t, i === turns.length - 1)}</div>
            </li>
          ))}
        </ol>
      )}
      <form
        className="fu-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <label className="answer-label" id={`${ids}-label`} htmlFor={`${ids}-q`}>
          {turns.length ? "Ask another follow-up" : label}
        </label>
        <textarea
          id={`${ids}-q`}
          ref={field}
          value={text}
          rows={2}
          maxLength={2000}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          aria-describedby={`${ids}-help${error ? ` ${ids}-err` : ""}`}
        />
        <div className="row fu-actions">
          <span className="hint grow" id={`${ids}-help`}>
            {waitingTurn ? "You can ask the next question once this one is answered." : "⌘/Ctrl + Enter to ask · Math works with $…$"}
          </span>
          <button type="submit" className="btn small" disabled={busy || Boolean(waitingTurn)} aria-busy={busy}>
            {busy ? "Asking…" : "Ask"}
          </button>
        </div>
        {error && (
          <p className="form-error" id={`${ids}-err`} role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="sr-only" role="status">
        {announce}
      </div>
    </section>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AttemptView, QuestionView } from "../../shared/schemas.ts";
import { Markdown, spokenText } from "./Markdown.tsx";

export interface Answer {
  selected: string[];
  dontKnow: boolean;
  confidence: "sure" | "unsure" | "guess" | null;
  note?: string;
}

export interface FeedbackInfo {
  message: string;
  reasoning: { verdict: string; summary: string; issues: string[] } | null;
  reasoningStatus: string;
  mastery?: { status: string; reasons: string[] };
  misconceptions?: string[];
}

const PURPOSE: Record<string, string> = {
  probe: "What do you already know?",
  check: "Check your understanding",
  transfer: "Same idea, new setting",
  review: "Retrieval practice",
};
const STATUS_LABEL: Record<string, [string, string]> = {
  not_assessed: ["Not assessed", ""],
  developing: ["Developing", "warn"],
  demonstrated: ["Demonstrated", "good"],
  needs_review: ["Needs review", "warn"],
  deferred: ["Set aside for now", "warn"],
};
const VERDICT: Record<string, string> = { sound: "Your reasoning holds up", partially_sound: "Your reasoning is partly there", flawed: "Your reasoning has a flaw", off_topic: "Your reasoning missed the point" };

function loadDraft(id: string): Partial<Answer> | null {
  try {
    const raw = localStorage.getItem(`learn:draft:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDraft(id: string, a: Partial<Answer> | null) {
  try {
    if (a) localStorage.setItem(`learn:draft:${id}`, JSON.stringify(a));
    else localStorage.removeItem(`learn:draft:${id}`);
  } catch {
    // storage unavailable: drafts are a convenience only
  }
}

/** One plain-language sentence on what the learner has shown and what comes next. */
export function nextStep(status: string, reasons: string[]): string {
  const r = reasons.join(" ");
  if (status === "demonstrated") return "You understand this idea and can use it. It will come back briefly in review so it sticks.";
  if (status === "needs_review") return "It has been a while since you used this idea; a quick review question will refresh it.";
  if (status === "deferred") return "You've set this idea aside for now. Your progress is saved, and you can revisit it later.";
  if (status === "not_assessed") return "We haven't checked this idea yet.";
  if (/misconception/i.test(r)) return "There's a mix-up to clear up; next we'll look at it directly.";
  if (/evidence of understanding/.test(r)) return "Next we'll build up the core idea and check it again. An answer you're sure of counts most.";
  if (/reasoning was flawed/.test(r)) return "Your choice was right, but your explanation didn't hold up; next we'll work on the why.";
  if (/application to a scenario/.test(r)) return "You recognized this idea; next we'll use it on a concrete problem.";
  if (/unfamiliar context/.test(r)) return "You recognized this idea; next we'll test it in a new situation.";
  if (/not yet confident/.test(r)) return "You got it right but weren't sure; another question will build your confidence.";
  return "A few more questions will show how well this idea has settled.";
}

/** Focus without the browser's own scroll, then place `el` just below the sticky header (`nearest`: only if it isn't already in view). */
export function bringIntoView(el: HTMLElement, focus: HTMLElement | null = el, mode: "start" | "nearest" = "start") {
  if (focus) {
    if (!focus.hasAttribute("tabindex") && !focus.matches("a[href], button, input, select, textarea")) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
  }
  const top = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + 12;
  const r = el.getBoundingClientRect();
  if (mode === "nearest" && r.top >= top && r.top < innerHeight - 120) return;
  window.scrollTo({ top: window.scrollY + r.top - top });
}

export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS_LABEL[status] ?? [status, ""];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function QuestionCard({
  question,
  feedback,
  onSubmit,
  disabled,
  autoFocus,
  job,
  onCancelJob,
  kicker,
  allowNote = true,
}: {
  question: QuestionView;
  feedback?: FeedbackInfo;
  onSubmit: (a: Answer) => Promise<unknown>;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The lesson's running generation job, if any, for stage-specific progress while submitting. */
  job?: { id: string; task: string } | null;
  onCancelJob?: (jobId: string) => void;
  /** Heading above the stem (defaults to one for the question's purpose). */
  kicker?: string;
  /** Offer optional written reasoning (it needs an AI to evaluate). */
  allowNote?: boolean;
}) {
  const attempt: AttemptView | undefined = question.attempt;
  const draft = !attempt && !question.skipped ? loadDraft(question.id) : null;
  const [selected, setSelected] = useState<string[]>(draft?.selected ?? []);
  const [dontKnow, setDontKnow] = useState(draft?.dontKnow ?? false);
  const [confidence, setConfidence] = useState<Answer["confidence"]>(draft?.confidence ?? null);
  const [note, setNote] = useState(draft?.note ?? "");
  const [showNote, setShowNote] = useState(Boolean(draft?.note));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const group = useRef<HTMLDivElement>(null);
  const feedbackCard = useRef<HTMLDivElement>(null);
  const lastAttempt = useRef(attempt?.id);

  useEffect(() => {
    if (question.skipped) saveDraft(question.id, null);
    else if (!attempt) saveDraft(question.id, { selected, dontKnow, confidence, note });
  }, [selected, dontKnow, confidence, note, attempt, question.id, question.skipped]);
  useEffect(() => {
    if (autoFocus && !attempt && !question.skipped && card.current) bringIntoView(card.current, card.current, "nearest");
  }, [autoFocus, attempt, question.skipped]);
  useEffect(() => {
    if (attempt && attempt.id !== lastAttempt.current && feedbackCard.current) bringIntoView(feedbackCard.current, feedbackCard.current);
    lastAttempt.current = attempt?.id;
  }, [attempt?.id]);

  const locked = Boolean(attempt) || question.skipped || busy || disabled;
  const ready = dontKnow || (selected.length > 0 && confidence !== null);

  const toggle = (value: string) => {
    if (locked) return;
    setDontKnow(false);
    setSelected((s) => (question.multiSelect ? (s.includes(value) ? s.filter((v) => v !== value) : [...s, value]) : [value]));
  };
  // "I don't know" is one more radio in a single-choice question (choosing it again keeps it), a toggle in a multi-select one.
  const chooseDontKnow = () => {
    if (locked) return;
    setDontKnow((d) => (question.multiSelect ? !d : true));
    setSelected([]);
  };
  const n = question.options.length;
  const pick = (i: number, moveFocus: boolean) => {
    if (i === n) chooseDontKnow();
    else toggle(question.options[i].value);
    if (moveFocus) radios.current[i]?.focus();
  };
  const checkedIndex = dontKnow ? n : question.options.findIndex((o) => selected.includes(o.value));
  // Roving tabindex (W3C radio group): one Tab stop; arrows move and select.
  const tabStop = (i: number) => (question.multiSelect ? undefined : i === (checkedIndex < 0 ? 0 : checkedIndex) ? 0 : -1);
  const submit = async () => {
    if (!ready || locked) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ selected: dontKnow ? [] : selected, dontKnow, confidence: dontKnow ? null : confidence, ...(note.trim() ? { note: note.trim() } : {}) });
      saveDraft(question.id, null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onGroupKey = (e: KeyboardEvent) => {
    if (question.multiSelect || locked || e.altKey || e.metaKey || e.ctrlKey) return;
    const cur = radios.current.indexOf(e.target as HTMLButtonElement);
    if (cur < 0) return;
    const to = { ArrowDown: cur + 1, ArrowRight: cur + 1, ArrowUp: cur - 1, ArrowLeft: cur - 1, Home: 0, End: n }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    pick((to + n + 1) % (n + 1), true);
  };

  // Shortcuts never take Enter or Space, so buttons, links and the text box keep their native behaviour.
  const onKey = (e: KeyboardEvent) => {
    if (locked) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      submit();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("textarea, input, select, [contenteditable]")) return;
    const inGroup = Boolean(group.current?.contains(document.activeElement));
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
      e.preventDefault();
      pick(Number(e.key) - 1, inGroup);
    } else if (e.key === "0" || e.key === "d") {
      e.preventDefault();
      pick(n, inGroup);
    } else if (e.key === "s" || e.key === "u" || e.key === "g") {
      if (!dontKnow) setConfidence(({ s: "sure", u: "unsure", g: "guess" } as const)[e.key]);
    } else if (e.key === "r" && allowNote) {
      e.preventDefault();
      setShowNote(true);
    }
  };

  const optionClass = (value: string) => {
    if (!attempt) return selected.includes(value) ? "option selected" : "option";
    const isKey = attempt.correctValues.includes(value);
    const chosen = attempt.selected.includes(value);
    if (isKey) return "option correct";
    if (chosen) return "option wrong";
    return "option";
  };
  const mark = (value: string) => {
    if (!attempt) return null;
    if (attempt.correctValues.includes(value)) return <span className="mark" style={{ color: "var(--good)" }} aria-label="correct answer">✓</span>;
    if (attempt.selected.includes(value)) return <span className="mark" style={{ color: "var(--bad)" }} aria-label="your answer, incorrect">✗</span>;
    return null;
  };

  // Math-only labels have no usable text for assistive tech; give them a spoken name.
  const optionName = (label: string, value: string, i: number) => {
    if (!label.includes("$")) return undefined;
    const spoken = spokenText(label) || `Option ${String.fromCharCode(65 + i)}: ${label}`;
    const state = !attempt ? "" : attempt.correctValues.includes(value) ? ", correct answer" : attempt.selected.includes(value) ? ", your answer, incorrect" : "";
    return spoken + state;
  };
  const stemId = `stem-${question.id}`;

  const verdictClass = !attempt ? "" : attempt.dontKnow ? "dk" : attempt.correct ? "good" : "bad";
  const verdictText = !attempt ? "" : attempt.dontKnow ? "You said you don't know yet" : attempt.correct ? "Correct" : "Not quite";

  return (
    <div className="question" ref={card} tabIndex={-1} onKeyDown={onKey} role="group" aria-label="Question">
      <div className="row">
        <span className="kicker">{kicker ?? PURPOSE[question.purpose] ?? "Question"}</span>
        {question.context === "novel" && <span className="badge optional">Unfamiliar context</span>}
        {question.multiSelect && <span className="badge">Select all that apply</span>}
      </div>
      <div className="stem" id={stemId}>
        <Markdown text={question.stem} />
      </div>
      <div ref={group} role={question.multiSelect ? "group" : "radiogroup"} aria-labelledby={stemId} onKeyDown={onGroupKey}>
        <div className="options">
          {question.options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                radios.current[i] = el;
              }}
              type="button"
              className={optionClass(o.value)}
              onClick={() => toggle(o.value)}
              disabled={locked}
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={attempt ? attempt.selected.includes(o.value) : selected.includes(o.value)}
              aria-label={optionName(o.label, o.value, i)}
              tabIndex={tabStop(i)}
            >
              <span className="key" aria-hidden>
                {i + 1}
              </span>
              <span className="label">
                <Markdown text={o.label} inline />
              </span>
              {mark(o.value)}
            </button>
          ))}
        </div>
        <div className="idk">
          <button
            ref={(el) => {
              radios.current[n] = el;
            }}
            type="button"
            className={`option ${(attempt ? attempt.dontKnow : dontKnow) ? "selected" : ""}`}
            onClick={chooseDontKnow}
            disabled={locked}
            role={question.multiSelect ? "checkbox" : "radio"}
            aria-checked={attempt ? attempt.dontKnow : dontKnow}
            tabIndex={tabStop(n)}
          >
            <span className="key" aria-hidden>
              0
            </span>
            <span className="label">I don't know yet</span>
          </button>
        </div>
      </div>

      {!attempt && !question.skipped && (
        <>
          <div className="controls">
            <div>
              <div className="hint" id={`conf-${question.id}`}>
                How sure are you?
              </div>
              <div className="segmented" role="group" aria-labelledby={`conf-${question.id}`}>
                {(["sure", "unsure", "guess"] as const).map((c) => (
                  <button key={c} type="button" aria-pressed={confidence === c} onClick={() => setConfidence(c)} disabled={locked || dontKnow}>
                    {c === "sure" ? "Sure" : c === "unsure" ? "Unsure" : "Guess"}
                  </button>
                ))}
              </div>
            </div>
            <div className="spacer" />
            {allowNote && !showNote && (
              <button type="button" className="btn ghost small" onClick={() => setShowNote(true)} disabled={locked}>
                + Explain your reasoning (optional)
              </button>
            )}
            <button type="button" className="btn primary" onClick={submit} disabled={!ready || locked} aria-describedby={!ready ? `answer-help-${question.id}` : undefined}>
              {busy ? "Checking…" : "Check answer"}
            </button>
          </div>
          {allowNote && showNote && (
            <div style={{ marginTop: "0.8rem" }}>
              <label className="hint" htmlFor={`note-${question.id}`}>
                Why do you think so? Optional. Your reasoning is evaluated separately from your choice.
              </label>
              <textarea id={`note-${question.id}`} value={note} onChange={(e) => setNote(e.target.value)} disabled={locked} placeholder="In your own words…" autoFocus />
            </div>
          )}
          {!ready && <p className="hint" id={`answer-help-${question.id}`} aria-live="polite">{selected.length ? "Choose how sure you are, then check your answer." : "Choose an answer and how sure you are, or choose “I don't know yet”."}</p>}
          <details className="question-details small">
            <summary>Keyboard shortcuts</summary>
            <p className="hint">1–{n} choose{question.multiSelect ? "" : " · ↑↓ move"} · 0 I don't know · S/U/G confidence{allowNote ? " · R reasoning" : ""} · ⌘/Ctrl + Enter check answer</p>
          </details>
          {busy && note.trim() && (
            <div className="working small" aria-live="polite" style={{ marginTop: "0.6rem" }}>
              <span className="spinner" aria-hidden />
              <span style={{ flex: 1 }}>
                Reading your written reasoning… Your choice is graded on its own; the reasoning is evaluated separately and can take up to a minute.
              </span>
              {job?.task === "evaluate_reasoning" && onCancelJob && (
                <button type="button" className="btn small ghost" onClick={() => onCancelJob(job.id)}>
                  Skip reasoning check
                </button>
              )}
            </div>
          )}
          {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
        </>
      )}

      {question.skipped && !attempt && <p className="muted small" role="status">Skipped for now · your progress is saved.</p>}
      {attempt && (
        <div className={`feedback ${verdictClass}`} ref={feedbackCard} tabIndex={-1} aria-label="Answer feedback" aria-live="polite">
          <div className="verdict">
            {verdictText}
            {attempt.confidence && <span className="muted small"> · you said {attempt.confidence}</span>}
          </div>
          {feedback?.message && <Markdown text={feedback.message} />}
          <div className="sub">
            <span className="kicker">Why this answer works</span>
            <Markdown text={attempt.explanation} />
          </div>
          {attempt.note && (
            <details className="sub question-details">
              <summary>Your reasoning and feedback</summary>
              <p style={{ margin: "0.2rem 0" }}>{attempt.note}</p>
              {(feedback?.reasoning ?? attempt.reasoning) ? (
                <ReasoningVerdict r={(feedback?.reasoning ?? attempt.reasoning)!} />
              ) : (
                <p className="muted small">{(feedback?.reasoningStatus ?? attempt.reasoningStatus) === "pending" ? "Your reasoning hasn't been evaluated yet; it will be checked later." : "Your reasoning could not be evaluated."}</p>
              )}
            </details>
          )}
          {feedback?.mastery && (
            <details className="sub small question-details">
              <summary>Your progress on this concept</summary>
              <div className="row">
                <span className="muted">Understanding:</span> <StatusBadge status={feedback.mastery.status} />
              </div>
              <p className="next-step">{nextStep(feedback.mastery.status, feedback.mastery.reasons)}</p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningVerdict({ r }: { r: { verdict: string; summary: string; issues: string[] } }) {
  const cls = r.verdict === "sound" ? "good" : r.verdict === "partially_sound" ? "warn" : "bad";
  return (
    <div>
      <span className={`badge ${cls}`}>{VERDICT[r.verdict] ?? r.verdict}</span>
      <Markdown text={r.summary} />
    </div>
  );
}

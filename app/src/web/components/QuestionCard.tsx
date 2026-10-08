import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AttemptView, QuestionView } from "../../shared/schemas.ts";
import { Markdown } from "./Markdown.tsx";

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
  deferred: ["Set aside for review", "warn"],
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
}: {
  question: QuestionView;
  feedback?: FeedbackInfo;
  onSubmit: (a: Answer) => Promise<unknown>;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const attempt: AttemptView | undefined = question.attempt;
  const draft = !attempt ? loadDraft(question.id) : null;
  const [selected, setSelected] = useState<string[]>(draft?.selected ?? []);
  const [dontKnow, setDontKnow] = useState(draft?.dontKnow ?? false);
  const [confidence, setConfidence] = useState<Answer["confidence"]>(draft?.confidence ?? null);
  const [note, setNote] = useState(draft?.note ?? "");
  const [showNote, setShowNote] = useState(Boolean(draft?.note));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!attempt) saveDraft(question.id, { selected, dontKnow, confidence, note });
  }, [selected, dontKnow, confidence, note, attempt, question.id]);
  useEffect(() => {
    if (autoFocus && !attempt) card.current?.focus({ preventScroll: true });
  }, [autoFocus, attempt]);

  const locked = Boolean(attempt) || busy || disabled;
  const ready = dontKnow || (selected.length > 0 && confidence !== null);

  const toggle = (value: string) => {
    if (locked) return;
    setDontKnow(false);
    setSelected((s) => (question.multiSelect ? (s.includes(value) ? s.filter((v) => v !== value) : [...s, value]) : [value]));
  };
  const chooseDontKnow = () => {
    if (locked) return;
    setDontKnow((d) => !d);
    setSelected([]);
  };
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

  const onKey = (e: KeyboardEvent) => {
    if (locked) return;
    const inText = (e.target as HTMLElement).tagName === "TEXTAREA";
    if (inText) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= question.options.length) {
      e.preventDefault();
      toggle(question.options[Number(e.key) - 1].value);
    } else if (e.key === "0" || e.key === "d") {
      chooseDontKnow();
    } else if (e.key === "s" || e.key === "u" || e.key === "g") {
      setConfidence(({ s: "sure", u: "unsure", g: "guess" } as const)[e.key]);
    } else if (e.key === "r") {
      e.preventDefault();
      setShowNote(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
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

  const verdictClass = !attempt ? "" : attempt.dontKnow ? "dk" : attempt.correct ? "good" : "bad";
  const verdictText = !attempt ? "" : attempt.dontKnow ? "You said you don't know yet" : attempt.correct ? "Correct" : "Not quite";

  return (
    <div className="question" ref={card} tabIndex={-1} onKeyDown={onKey} aria-label="Question">
      <div className="row">
        <span className="kicker">{PURPOSE[question.purpose] ?? "Question"}</span>
        {question.context === "novel" && <span className="badge optional">Unfamiliar context</span>}
        {question.multiSelect && <span className="badge">Select all that apply</span>}
      </div>
      <div className="stem">
        <Markdown text={question.stem} />
      </div>
      <div className="options" role={question.multiSelect ? "group" : "radiogroup"}>
        {question.options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            className={optionClass(o.value)}
            onClick={() => toggle(o.value)}
            disabled={locked}
            role={question.multiSelect ? "checkbox" : "radio"}
            aria-checked={attempt ? attempt.selected.includes(o.value) : selected.includes(o.value)}
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
          type="button"
          className={`option ${(attempt ? attempt.dontKnow : dontKnow) ? "selected" : ""}`}
          onClick={chooseDontKnow}
          disabled={locked}
          role={question.multiSelect ? "checkbox" : "radio"}
          aria-checked={attempt ? attempt.dontKnow : dontKnow}
        >
          <span className="key" aria-hidden>
            0
          </span>
          <span className="label">I don't know</span>
        </button>
      </div>

      {!attempt && (
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
            {!showNote && (
              <button type="button" className="btn ghost small" onClick={() => setShowNote(true)} disabled={locked}>
                + Explain your reasoning (optional)
              </button>
            )}
            <button type="button" className="btn primary" onClick={submit} disabled={!ready || locked}>
              {busy ? "Checking…" : "Submit"}
            </button>
          </div>
          {showNote && (
            <div style={{ marginTop: "0.8rem" }}>
              <label className="hint" htmlFor={`note-${question.id}`}>
                Why do you think so? Optional. Your reasoning is evaluated separately from your choice.
              </label>
              <textarea id={`note-${question.id}`} value={note} onChange={(e) => setNote(e.target.value)} disabled={locked} placeholder="In your own words…" autoFocus />
            </div>
          )}
          <div className="hint" style={{ marginTop: "0.6rem" }}>
            Keys: 1–{question.options.length} choose · 0 I don't know · S/U/G confidence · R reasoning · Enter submit
          </div>
          {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
        </>
      )}

      {attempt && (
        <div className={`feedback ${verdictClass}`} aria-live="polite">
          <div className="verdict">
            {verdictText}
            {attempt.confidence && <span className="muted small"> · you said {attempt.confidence}</span>}
          </div>
          {feedback?.message && <Markdown text={feedback.message} />}
          <div className="sub">
            <Markdown text={attempt.explanation} />
          </div>
          {attempt.note && (
            <div className="sub">
              <span className="kicker">Your reasoning</span>
              <p style={{ margin: "0.2rem 0" }}>{attempt.note}</p>
              {(feedback?.reasoning ?? attempt.reasoning) ? (
                <ReasoningVerdict r={(feedback?.reasoning ?? attempt.reasoning)!} />
              ) : (
                <p className="muted small">{(feedback?.reasoningStatus ?? attempt.reasoningStatus) === "pending" ? "Your reasoning will be evaluated when an AI provider is available." : "Your reasoning could not be evaluated."}</p>
              )}
            </div>
          )}
          {feedback?.mastery && (
            <div className="sub small row">
              <span className="muted">Understanding:</span> <StatusBadge status={feedback.mastery.status} />
              {feedback.mastery.status !== "demonstrated" && feedback.mastery.reasons[0] && <span className="muted">{feedback.mastery.reasons[0]}</span>}
            </div>
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

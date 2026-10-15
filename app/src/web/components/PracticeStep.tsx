import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PracticeAttemptView, PracticeStepView } from "../../shared/practice.ts";
import { api, ApiError, errorMessage } from "../api.ts";
import { answerText, blankGrid, editableMask, emptyCells, fitGrid, percent, sortedAttempts, type Grid } from "../practice.ts";
import { RefChip } from "./Blocks.tsx";
import { Markdown, spokenText } from "./Markdown.tsx";
import { GridEditor, GridExpected, GridResult } from "./PracticeGrid.tsx";
import { useFollowUpActivity } from "../liveJobs.ts";
import { FollowUpBox } from "./FollowUp.tsx";
import { CoachingBlock } from "./PracticeGuide.tsx";
import { Elapsed } from "./Progress.tsx";
import { bringIntoView } from "./QuestionCard.tsx";
import type { SourceTarget } from "./SourceDrawer.tsx";
import { useShell } from "./TopBar.tsx";
import { stepDone } from "../practice.ts";

type Confidence = "sure" | "unsure" | "guess";
const CONFIDENCE: [Confidence, string][] = [
  ["sure", "Sure"],
  ["unsure", "Unsure"],
  ["guess", "Guess"],
];

/** What the learner has typed for one step; kept across failed submits, and in localStorage when available. */
interface Draft {
  text: string;
  choice: string[];
  grid: Grid | null;
  confidence: Confidence | null;
}

const draftKey = (stepId: string) => `learn:practice-draft:${stepId}`;
function loadDraft(stepId: string): Partial<Draft> | null {
  try {
    const raw = localStorage.getItem(draftKey(stepId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDraft(stepId: string, d: Draft | null) {
  try {
    if (d) localStorage.setItem(draftKey(stepId), JSON.stringify(d));
    else localStorage.removeItem(draftKey(stepId));
  } catch {
    // storage unavailable: drafts in component state still survive a failed submit
  }
}

function blank(step: PracticeStepView): Draft {
  const t = step.input.table;
  return { text: "", choice: [], grid: t ? blankGrid(t.rowLabels.length, t.colLabels.length, t.given) : null, confidence: null };
}
/** A stored draft fitted to the step as it is now (the table's shape or options may have changed). */
function fromStored(step: PracticeStepView, d: Partial<Draft> | null): Draft | null {
  if (!d || typeof d !== "object") return null;
  const t = step.input.table;
  const options = step.input.choice?.options.map((o) => o.value) ?? [];
  return {
    text: typeof d.text === "string" ? d.text : "",
    choice: Array.isArray(d.choice) ? d.choice.filter((v) => options.includes(v)) : [],
    grid: t ? fitGrid(d.grid, t.rowLabels.length, t.colLabels.length, t.given) : null,
    confidence: d.confidence === "sure" || d.confidence === "unsure" || d.confidence === "guess" ? d.confidence : null,
  };
}
/** "Try again" starts from the previous answer, so a table only needs its wrong cells fixed. Confidence is asked afresh. */
function fromAttempt(step: PracticeStepView, a: PracticeAttemptView): Draft {
  const t = step.input.table;
  const v = a.value;
  const flat = Array.isArray(v) && !v.some(Array.isArray) ? (v as string[]) : [];
  return {
    text: typeof v === "string" ? v : "",
    choice: step.kind === "choice" ? flat : [],
    grid: t ? fitGrid(v, t.rowLabels.length, t.colLabels.length, t.given) : null,
    confidence: null,
  };
}

/** The kind of input actually rendered: falls back to a text box if the step lacks its table or options. */
function inputKind(step: PracticeStepView) {
  if (step.kind === "table" && step.input.table) return "table";
  if (step.kind === "choice" && step.input.choice) return "choice";
  return step.kind === "free" ? "free" : step.kind === "table" || step.kind === "choice" ? "text" : step.kind;
}

function filled(step: PracticeStepView, d: Draft): boolean {
  const kind = inputKind(step);
  if (kind === "choice") return d.choice.length > 0;
  if (kind === "table") {
    const t = step.input.table!;
    const { empty, total } = emptyCells(d.grid ?? [], editableMask(t.rowLabels.length, t.colLabels.length, t.given));
    return empty < total;
  }
  return d.text.trim() !== "";
}

function valueOf(step: PracticeStepView, d: Draft): string | string[] | string[][] {
  const kind = inputKind(step);
  if (kind === "choice") return d.choice;
  if (kind === "table") return d.grid!.map((row) => row.map((v) => v.trim()));
  return kind === "free" ? d.text : d.text.trim();
}

interface Verdict {
  cls: "good" | "bad" | "warn" | "dk" | "pending";
  icon: string;
  text: string;
}
/** Verdict of one attempt in words, with an icon so it never relies on color alone. */
export function verdictOf(a: PracticeAttemptView | undefined): Verdict {
  if (!a) return { cls: "dk", icon: "?", text: "Solution shown" };
  if (a.dontKnow) return { cls: "dk", icon: "?", text: "You said you don't know yet" };
  if (a.overridden) return { cls: "good", icon: "✓", text: "Counted as correct" };
  if (a.gradingStatus === "pending") return { cls: "pending", icon: "…", text: "Checking your explanation…" };
  if (a.gradingStatus === "failed" || a.correct === null) return { cls: "dk", icon: "!", text: "Couldn't be checked automatically" };
  if (a.correct) return { cls: "good", icon: "✓", text: "Correct" };
  if (a.score !== null && a.score > 0) return { cls: "warn", icon: "◐", text: `Partly right · ${percent(a.score)}` };
  return { cls: "bad", icon: "✗", text: "Not quite" };
}

const BADGE: Record<string, [string, string]> = {
  correct: ["✓ Correct", "good"],
  partial: ["◐ Partly right", "warn"],
  incorrect: ["✗ Not quite", "bad"],
  revealed: ["? Solution shown", ""],
  dont_know: ["? Not yet", ""],
  pending: ["… Checking", ""],
  skipped: ["↪ Skipped", ""],
};

export function StepBadge({ status }: { status: string }) {
  const b = BADGE[status];
  return b ? <span className={`badge ${b[1]}`}>{b[0]}</span> : null;
}

/** Paused AI only blocks extraction, written-explanation grading and coaching; say so plainly. */
function failMessage(e: unknown): string {
  if (e instanceof ApiError && e.paused)
    return `AI generation is paused: ${e.paused.reason} Written explanations and coaching wait for a provider; numbers, sequences, tables and multiple choice are still checked right away, and the solution can always be shown.`;
  return errorMessage(e);
}

/**
 * Starts a lesson on one of the problem's concepts. With several concepts the learner picks one
 * (the step view doesn't say which concepts a step exercises, so the problem's list is offered).
 */
export function LearnConcept({ problemId, concepts, label = "Learn this concept", className = "btn" }: { problemId: string; concepts: { id: string; name: string }[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const ids = useId();

  const learn = async (conceptId?: string) => {
    if (busy) return;
    setBusy(conceptId ?? "problem");
    setError(null);
    try {
      const { lessonId } = await api.learnProblem(problemId, conceptId);
      location.hash = `#/lesson/${lessonId}`;
    } catch (e) {
      setError(e instanceof ApiError && e.paused ? `AI generation is paused: ${e.paused.reason} New lessons need a provider; your practice is saved.` : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const err = error && (
    <p className="form-error learn-error" role="alert">
      {error}
    </p>
  );
  if (concepts.length <= 1) {
    const c = concepts[0];
    return (
      <span className="learn-pick">
        <button type="button" className={className} onClick={() => learn(c?.id)} disabled={Boolean(busy)} aria-busy={Boolean(busy)}>
          {busy ? "Preparing lesson…" : label}
          {c && <span className="sr-only">: {c.name}</span>}
        </button>
        {err}
      </span>
    );
  }
  return (
    <span className="learn-pick">
      <button ref={toggle} type="button" className={className} aria-expanded={open} aria-controls={`${ids}-concepts`} onClick={() => setOpen((o) => !o)}>
        {label}…
      </button>
      <span
        id={`${ids}-concepts`}
        className="learn-list"
        role="group"
        aria-label="Choose a concept to learn"
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }}
      >
        <span className="hint">Learn which concept?</span>
        {concepts.map((c) => (
          <button key={c.id} type="button" className="btn small" onClick={() => learn(c.id)} disabled={Boolean(busy)} aria-busy={busy === c.id}>
            {busy === c.id ? "Preparing lesson…" : c.name}
          </button>
        ))}
      </span>
      {err}
    </span>
  );
}

/**
 * One gradable step: prompt, the right input for its kind, then the verdict. A miss keeps the key
 * hidden and shows compact coaching (diagnosis, core idea, follow-up box; the full explanation and
 * check one click away); any other answer gets a follow-up box under the verdict. The worked
 * solution appears once the step is completed or the learner asks for it.
 */
export function PracticeStepCard({
  step,
  index,
  count,
  problemId,
  concepts,
  onUpdate,
  openSource,
  next,
}: {
  step: PracticeStepView;
  index: number;
  count: number;
  problemId: string;
  concepts: { id: string; name: string }[];
  onUpdate: (s: PracticeStepView) => void;
  openSource: (t: SourceTarget) => void;
  /** Where to go after completing or skipping this step. */
  next?: { label: string; go: () => void } | null;
}) {
  const { status: shell } = useShell();
  const ids = useId();
  const attempts = useMemo(() => sortedAttempts(step), [step]);
  const last = attempts.at(-1);
  const [retrying, setRetrying] = useState(false);
  const answering = retrying || (attempts.length === 0 && !step.reveal && step.status !== "skipped");
  const [draft, setDraft] = useState<Draft>(() => fromStored(step, loadDraft(step.id)) ?? blank(step));
  const [busy, setBusy] = useState<null | "submit" | "dontknow" | "reveal" | "override" | "skip">(null);
  const [error, setError] = useState<{ message: string; field: "answer" | "confidence" | null } | null>(null);
  const [hint, setHint] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Coaching is optional: opening it never blocks retrying or moving on.
  const [fullOpen, setFullOpen] = useState<Record<string, boolean>>({});
  const followUps = useFollowUpActivity(step.id);
  const card = useRef<HTMLElement>(null);
  const verdictRef = useRef<HTMLParagraphElement>(null);
  const confGroup = useRef<HTMLDivElement>(null);
  const overrideBtn = useRef<HTMLButtonElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"verdict" | "field" | "override" | null>(null);

  const kind = inputKind(step);
  const options = step.input.choice?.options ?? [];
  const multi = step.input.choice?.multiSelect ?? false;
  const unit = step.input.unit;
  const labelId = `${ids}-label`;
  const promptId = `${ids}-prompt`;
  const helpId = `${ids}-help`;
  const errorId = `${ids}-error`;
  const fieldId = `${ids}-field`;

  useEffect(() => {
    if (answering) saveDraft(step.id, filled(step, draft) || draft.confidence ? draft : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, answering, step.id]);

  // Focus moves after the view has re-rendered: to the verdict after an answer, to the first field on "Try again".
  useEffect(() => {
    const what = focusAfter.current;
    focusAfter.current = null;
    if (what === "verdict" && verdictRef.current) bringIntoView(verdictRef.current.closest<HTMLElement>(".feedback") ?? verdictRef.current, verdictRef.current);
    if (what === "field") focusField();
    if (what === "override") overrideBtn.current?.focus();
  });
  useEffect(() => {
    if (confirming) confirmBtn.current?.focus();
  }, [confirming]);

  const firstField = () => card.current?.querySelector<HTMLElement>(".step-answer input, .step-answer textarea") ?? null;
  const focusField = () => {
    const el = firstField();
    if (el) bringIntoView(el, el, "nearest");
  };

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (error?.field === "answer" && !("confidence" in patch)) setError(null);
  };
  const toggleChoice = (value: string) => update({ choice: multi ? (draft.choice.includes(value) ? draft.choice.filter((v) => v !== value) : [...draft.choice, value]) : [value] });
  const setConfidence = (confidence: Confidence) => {
    setDraft((d) => ({ ...d, confidence }));
    if (error?.field === "confidence") setError(null);
  };

  const submit = async (dontKnow: boolean) => {
    if (busy) return;
    if (!dontKnow && !filled(step, draft)) {
      setError({ message: kind === "choice" ? "Choose an answer, or “I don't know”." : kind === "table" ? "Fill in at least one cell, or choose “I don't know”." : "Enter an answer, or choose “I don't know”.", field: "answer" });
      focusField();
      return;
    }
    if (!dontKnow && !draft.confidence) {
      setError({ message: "Choose how sure you are: Sure, Unsure or Guess.", field: "confidence" });
      confGroup.current?.querySelector("button")?.focus();
      return;
    }
    setBusy(dontKnow ? "dontknow" : "submit");
    setError(null);
    try {
      const s = await api.attemptStep(step.id, dontKnow ? { dontKnow: true, confidence: null } : { value: valueOf(step, draft), dontKnow: false, confidence: draft.confidence });
      saveDraft(step.id, null);
      setRetrying(false);
      setConfirming(false);
      setHint(false);
      focusAfter.current = "verdict";
      onUpdate(s);
    } catch (e) {
      setError({ message: failMessage(e), field: null });
    } finally {
      setBusy(null);
    }
  };

  const reveal = async () => {
    if (busy) return;
    setBusy("reveal");
    setError(null);
    try {
      const s = await api.revealStep(step.id);
      focusAfter.current = "verdict";
      onUpdate(s);
    } catch (e) {
      setError({ message: failMessage(e), field: null });
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    if (busy) return;
    setBusy("skip");
    setError(null);
    try {
      onUpdate(await api.skipStep(step.id));
      setRetrying(false);
      next?.go();
    } catch (e) {
      setError({ message: errorMessage(e), field: null });
    } finally {
      setBusy(null);
    }
  };

  const override = async () => {
    if (busy || !overrideTarget) return;
    setBusy("override");
    setError(null);
    try {
      const s = await api.overrideAttempt(overrideTarget.id);
      setConfirming(false);
      focusAfter.current = "verdict";
      onUpdate(s);
    } catch (e) {
      setError({ message: errorMessage(e), field: null });
    } finally {
      setBusy(null);
    }
  };

  const tryAgain = () => {
    const stored = fromStored(step, loadDraft(step.id));
    setDraft((d) => stored ?? (last && !last.dontKnow && last.value != null ? fromAttempt(step, last) : { ...d, confidence: null }));
    setRetrying(true);
    setConfirming(false);
    setError(null);
    focusAfter.current = "field";
  };

  // ⌘/Ctrl + Enter submits from anywhere in the step. Plain keys never touch Enter or Space, so buttons keep
  // their native behaviour; letter and digit shortcuts apply only outside text fields.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (busy) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      submit(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("textarea, select, [contenteditable]") || (t instanceof HTMLInputElement && t.type !== "radio" && t.type !== "checkbox")) return;
    const k = e.key.toLowerCase();
    if (kind === "choice" && /^[1-8]$/.test(k) && options[Number(k) - 1]) {
      e.preventDefault();
      toggleChoice(options[Number(k) - 1].value);
      card.current?.querySelectorAll<HTMLInputElement>(".step-answer input")[Number(k) - 1]?.focus();
    } else if (k === "s" || k === "u" || k === "g") {
      e.preventDefault();
      setConfidence(k === "s" ? "sure" : k === "u" ? "unsure" : "guess");
    }
  };

  const describedBy = (...extra: string[]) => [promptId, ...extra, error?.field === "answer" ? errorId : ""].filter(Boolean).join(" ");
  const input = () => {
    switch (kind) {
      case "table":
        return (
          <GridEditor
            table={step.input.table!}
            values={draft.grid!}
            onChange={(grid) => update({ grid })}
            labelledBy={labelId}
            describedBy={error?.field === "answer" ? errorId : undefined}
            disabled={Boolean(busy)}
          />
        );
      case "choice":
        return (
          <>
            {multi && <span className="badge">Select all that apply</span>}
            <div className="options" role={multi ? "group" : "radiogroup"} aria-labelledby={promptId} aria-describedby={error?.field === "answer" ? errorId : undefined}>
              {options.map((o, i) => {
                const checked = draft.choice.includes(o.value);
                return (
                  <label key={o.value} className={`option ${checked ? "selected" : ""}`}>
                    <input
                      className="sr-only"
                      type={multi ? "checkbox" : "radio"}
                      name={`${ids}-choice`}
                      value={o.value}
                      checked={checked}
                      onChange={() => toggleChoice(o.value)}
                      disabled={Boolean(busy)}
                      aria-label={o.label.includes("$") ? spokenText(o.label) : undefined}
                    />
                    <span className="key" aria-hidden>
                      {i + 1}
                    </span>
                    <span className="label">
                      <Markdown text={o.label} inline />
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        );
      case "free":
        return (
          <>
            <label className="answer-label" htmlFor={fieldId}>
              Your explanation<span className="sr-only"> for {step.label}</span>
            </label>
            <textarea
              id={fieldId}
              value={draft.text}
              onChange={(e) => update({ text: e.target.value })}
              maxLength={6000}
              rows={5}
              placeholder="In your own words…"
              aria-describedby={describedBy(helpId)}
              aria-invalid={error?.field === "answer" ? true : undefined}
              disabled={Boolean(busy)}
            />
            <div className="hint" id={helpId}>
              Checked against the key ideas of the solution. Math works with $…$.
            </div>
          </>
        );
      default:
        return (
          <>
            <label className="answer-label" htmlFor={fieldId}>
              Your answer<span className="sr-only"> for {step.label}</span>
            </label>
            <div className="answer-line">
              <input
                id={fieldId}
                type="text"
                className="answer-input"
                value={draft.text}
                onChange={(e) => update({ text: e.target.value })}
                maxLength={kind === "number" ? 120 : 600}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={describedBy(kind === "number" || kind === "sequence" ? helpId : "")}
                aria-invalid={error?.field === "answer" ? true : undefined}
                disabled={Boolean(busy)}
              />
              {unit && <span className="unit">{unit}</span>}
            </div>
            {kind === "number" && (
              <div className="hint" id={helpId}>
                Accepted: 3/64, 0.047, 2^-3, log2(6)
              </div>
            )}
            {kind === "sequence" && (
              <div className="hint" id={helpId}>
                Separate with spaces or commas, e.g. 6 4 1 5 2 3 0
              </div>
            )}
          </>
        );
    }
  };

  const v: Verdict = step.status === "skipped" ? { cls: "dk", icon: "↪", text: "Skipped for now" } : verdictOf(last);
  const pending = last?.gradingStatus === "pending";
  const expected = step.reveal?.expected;
  // "Count as correct" needs the key in view: the latest real answer, once the solution is shown.
  const overrideTarget = step.reveal ? [...attempts].reverse().find((a) => !a.dontKnow) : undefined;
  const canOverride = Boolean(overrideTarget && !overrideTarget.overridden && overrideTarget.correct !== true && overrideTarget.gradingStatus !== "pending");
  const canRetry = step.status !== "correct" && !pending;
  const coaching = step.coaching ?? [];
  const latestCoaching = !step.reveal && last && !answering && step.status !== "skipped" ? coaching.at(-1) : undefined;
  const offerSolution = !step.reveal && (step.misses ?? 0) >= 2;
  const earlier = answering ? attempts : attempts.slice(0, -1);
  const table = step.input.table;

  return (
    <section className="step" id={`step-${step.id}`} ref={card} aria-labelledby={labelId}>
      <div className="step-head">
        <span className="kicker">
          Step {index + 1} of {count}
        </span>
        <StepBadge status={step.status} />
        {!step.keyVerified && step.keySource === "solutions" && (
          <span className="badge warn" title="This step's answer key couldn't be matched to a quote in your solutions document; it was derived by AI. Check surprising answers against your notes.">
            AI-derived, not found in your solutions
          </span>
        )}
      </div>
      <h2 className="step-label" id={labelId}>
        {step.label}
      </h2>
      <div className="step-prompt" id={promptId}>
        <Markdown text={step.prompt} />
      </div>

      {(step.hint || answering) && (
        <div className="row step-tools">
          {step.hint && (
            <button type="button" className="btn ghost small" aria-expanded={hint} aria-controls={`${ids}-hint`} onClick={() => setHint((h) => !h)}>
              {hint ? "Hide hint" : "Show hint"}
            </button>
          )}
          {answering && !step.reveal && (
            <button type="button" className="btn ghost small" onClick={reveal} disabled={Boolean(busy)} aria-busy={busy === "reveal"}>
              {busy === "reveal" ? "Opening…" : "Show solution"}
            </button>
          )}
        </div>
      )}
      {step.hint && (
        <div className="aside hint-box" id={`${ids}-hint`} hidden={!hint}>
          <div className="kicker">Hint</div>
          <Markdown text={step.hint} />
        </div>
      )}

      {answering && (
        <form
          className="step-form"
          noValidate
          onKeyDown={onKeyDown}
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          <div className="step-answer">{input()}</div>
          <div className="controls">
            <div>
              <div className="hint" id={`${ids}-conf`}>
                How sure are you?
              </div>
              <div ref={confGroup} className="segmented" role="group" aria-labelledby={`${ids}-conf`} aria-describedby={error?.field === "confidence" ? errorId : undefined}>
                {CONFIDENCE.map(([c, label]) => (
                  <button key={c} type="button" aria-pressed={draft.confidence === c} onClick={() => setConfidence(c)} disabled={Boolean(busy)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="spacer" />
            <button type="button" className="btn ghost" onClick={() => submit(true)} disabled={Boolean(busy)} aria-busy={busy === "dontknow"}>
              {busy === "dontknow" ? "Saving…" : "I don't know yet"}
            </button>
            {retrying && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setRetrying(false);
                  setError(null);
                }}
                disabled={Boolean(busy)}
              >
                Cancel
              </button>
            )}
            <button type="submit" className="btn primary" disabled={Boolean(busy)} aria-busy={busy === "submit"}>
              {busy === "submit" ? "Checking…" : "Check answer"}
            </button>
            <button type="button" className="btn ghost" onClick={skip} disabled={Boolean(busy)} aria-busy={busy === "skip"}>
              {busy === "skip" ? "Skipping…" : "Skip step"} <span aria-hidden>→</span>
            </button>
          </div>
          {error && (
            <p className="form-error" id={errorId} role="alert">
              {error.message}
            </p>
          )}
          <details className="keyboard-help small">
            <summary>Keyboard shortcuts</summary>
            {kind === "choice" ? `1–${options.length} choose · ` : ""}S/U/G confidence (outside text fields) · ⌘/Ctrl + Enter check answer
          </details>
        </form>
      )}

      {answering && !step.reveal && coaching.some((c) => c.status === "ready") && (
        <div className="coach-recall">
          {coaching
            .filter((c) => c.status === "ready")
            .map((c) => (
              <CoachingBlock key={c.id} c={c} step={step} onUpdate={onUpdate} openSource={openSource} earlier />
            ))}
        </div>
      )}

      {!answering && (
        <>
          <div className={`feedback ${v.cls}`} aria-live="polite">
            <p className="verdict" ref={verdictRef} tabIndex={-1}>
              <span className="verdict-icon" aria-hidden>
                {v.icon}
              </span>{" "}
              {v.text}
              {last?.confidence && <span className="muted small"> · you said {last.confidence}</span>}
            </p>
            {step.status === "skipped" && <p className="small">You can return to this step whenever you're ready.</p>}
            {pending && (
              <p className="working small">
                <span className="spinner" aria-hidden />
                <span className="grow">
                  {shell?.paused
                    ? `AI generation is paused (${shell.paused.reason}). Your explanation is saved and will be checked once a provider is available; you can go on to the next step meanwhile.`
                    : "An AI grader is reading your explanation against the solution's key ideas. This usually takes under a minute; you can go on to the next step meanwhile."}
                  {!shell?.paused && <Elapsed />}
                </span>
              </p>
            )}
            {step.reveal && last && (last.gradingStatus === "failed" || (last.correct === null && !last.dontKnow && !pending && !last.overridden)) && (
              <p className="small">Compare your answer with the worked solution below. If it matches, use “Count as correct”.</p>
            )}
            {last?.feedback && <Markdown text={last.feedback} />}

          </div>

          <div className="step-decision" role="group" aria-label="What to do next">
            <div className="row step-actions">
              {canRetry && (
                <button type="button" className={`btn ${stepDone(step) ? "" : "primary"}`} onClick={tryAgain} disabled={Boolean(busy)}>
                  {step.status === "skipped" ? "Try this step" : step.reveal && !attempts.length ? "Try it yourself" : "Try again"}
                </button>
              )}
              {next && (stepDone(step) && !retrying ? (
                <button type="button" className="btn primary" onClick={next.go} disabled={Boolean(busy)}>
                  {next.label} <span aria-hidden>→</span>
                </button>
              ) : (
                <button type="button" className="btn" onClick={skip} disabled={Boolean(busy)} aria-busy={busy === "skip"}>
                  {busy === "skip" ? "Skipping…" : "Skip step"} <span aria-hidden>→</span>
                </button>
              ))}
              {!step.reveal && (
                <button type="button" className="btn ghost" onClick={reveal} disabled={Boolean(busy)} aria-busy={busy === "reveal"}>
                  {busy === "reveal" ? "Opening…" : "Show solution"}
                </button>
              )}
            </div>
            {!stepDone(step) && <p className="hint">Try again, or skip this step and keep going. The explanation below is optional.</p>}
            {next && (followUps.answering || followUps.unsent) && (
              <p className="hint">{followUps.answering ? "Your follow-up will stay here if you move on." : "Your unsent follow-up is saved as a draft."}</p>
            )}
          </div>

          <div className="feedback-answer">
            {kind === "table" && table ? (
              <div className="grid-compare">
                {last && !last.dontKnow && last.value != null && (
                  <GridResult table={table} values={fitGrid(last.value, table.rowLabels.length, table.colLabels.length, table.given)} results={last.cellResults} caption="Your table" />
                )}
                {Array.isArray(expected) && (
                  <GridExpected
                    table={table}
                    expected={expected}
                    values={last && !last.dontKnow ? fitGrid(last.value, table.rowLabels.length, table.colLabels.length, table.given) : null}
                    results={last && !last.dontKnow ? last.cellResults : undefined}
                    caption="Answer key"
                  />
                )}
              </div>
            ) : (
              <dl className="answer-compare">
                {last && !last.dontKnow && last.value != null && (
                  <>
                    <dt>{kind === "free" ? "Your explanation" : "Your answer"}</dt>
                    <dd className={kind === "free" ? "free-answer" : undefined}>
                      {answerText(last.value, step.kind, options)}
                      {unit && kind === "number" ? ` ${unit}` : ""}
                    </dd>
                  </>
                )}
                {typeof expected === "string" && expected && (
                  <>
                    <dt>{kind === "free" ? "Model answer" : "Answer key"}</dt>
                    <dd>
                      <Markdown text={expected} inline={kind !== "free"} />
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>

          {latestCoaching && (
            <>
              {coaching
                .filter((c) => c.id !== latestCoaching.id)
                .map((c) => (
                  <CoachingBlock key={c.id} c={c} step={step} onUpdate={onUpdate} openSource={openSource} earlier />
                ))}
              <CoachingBlock
                key={latestCoaching.id}
                c={latestCoaching}
                step={step}
                onUpdate={onUpdate}
                openSource={openSource}
                fullOpen={Boolean(fullOpen[latestCoaching.id])}
                onFullToggle={(open) => setFullOpen((m) => (Boolean(m[latestCoaching.id]) === open ? m : { ...m, [latestCoaching.id]: open }))}
              />
            </>
          )}

          {step.reveal && (
            <details className="expand solution" open={step.status !== "correct"}>
              <summary>Worked solution</summary>
              <Markdown text={step.reveal.solution} />
              {step.reveal.solutionRefs.length > 0 && (
                <div className="provenance">
                  In the solutions:{" "}
                  {step.reveal.solutionRefs.map((r, i) => (
                    <RefChip key={i} r={r} open={openSource} />
                  ))}
                </div>
              )}
            </details>
          )}

          {!latestCoaching && (
            <FollowUpBox
              kind="practice_step"
              targetId={step.id}
              thread={step.followUp}
              openSource={openSource}
              scope={step.id}
              collapsible
              placeholder={
                step.reveal
                  ? "Ask anything about this step: why the answer is what it is, another way to get it, where it shows up in the lecture…"
                  : "Ask about the idea or the method behind this step (the answer itself stays hidden until you've solved it)…"
              }
            />
          )}

          {offerSolution && (
            <p className="small offer-solution">
              You've tried this step {step.misses} times. It's fine to look at the worked solution now; working through it is learning too.
            </p>
          )}
          <details className="expand step-more">
            <summary>More help and grading options</summary>
            <div className="row step-actions">
            {canOverride && !confirming && (
              <button ref={overrideBtn} type="button" className="btn ghost" onClick={() => setConfirming(true)} disabled={Boolean(busy)}>
                Count as correct
              </button>
            )}
            <LearnConcept problemId={problemId} concepts={concepts} className="btn ghost" />
            </div>
          {confirming && (
            <div
              className="confirm"
              role="group"
              aria-labelledby={`${ids}-confirm`}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                setConfirming(false);
                focusAfter.current = "override";
              }}
            >
              <p id={`${ids}-confirm`}>Count this attempt as correct? Use this when your answer is equivalent to the key, for example the same value written another way.</p>
              <div className="row">
                <button ref={confirmBtn} type="button" className="btn primary small" onClick={override} disabled={Boolean(busy)} aria-busy={busy === "override"}>
                  {busy === "override" ? "Saving…" : "Yes, count it"}
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setConfirming(false);
                    focusAfter.current = "override";
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          </details>
          {error && (
            <p className="form-error" role="alert">
              {error.message}
            </p>
          )}
        </>
      )}

      {earlier.length > 0 && (
        <details className="history attempts">
          <summary>
            <span className="kicker">{answering ? "Your attempts" : "Earlier attempts"}</span> <span className="muted small">{earlier.length}</span>
          </summary>
          <ol className="attempt-list">
            {earlier.map((a) => {
              const av = verdictOf(a);
              const text = answerText(a.value, step.kind, options);
              return (
                <li key={a.id}>
                  <span className={`verdict-icon ${av.cls}`} aria-hidden>
                    {av.icon}
                  </span>{" "}
                  <b>{av.text}</b>
                  {text && <span className={kind === "free" ? "free-answer" : undefined}> · {text}</span>}
                  <span className="muted small"> · {new Date(a.createdAt).toLocaleString()}</span>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </section>
  );
}

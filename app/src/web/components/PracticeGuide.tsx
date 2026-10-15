// Guided practice UI: the warm-up before a problem, and the coaching block shown under a step
// after a wrong answer or "I don't know": compact first (diagnosis, the core idea, a follow-up box), then the full
// explanation, worked example and check question behind "Show the full explanation".
import { useEffect, useId, useRef, useState } from "react";
import type { PracticeCoachingView, PracticePrimerView, PracticeProblemView, PracticeStepView } from "../../shared/practice.ts";
import { api, ApiError, errorMessage } from "../api.ts";
import { useLivePreview } from "../liveJobs.ts";
import { RefChip, Revising, Writing } from "./Blocks.tsx";
import { FollowUpBox } from "./FollowUp.tsx";
import { Markdown, PreviewMarkdown } from "./Markdown.tsx";
import { QuestionCard, type Answer } from "./QuestionCard.tsx";
import { Elapsed, QuestionPreview, SkeletonLines } from "./Progress.tsx";
import type { SourceTarget } from "./SourceDrawer.tsx";
import { useShell } from "./TopBar.tsx";

const STRATEGY: Record<string, string> = {
  first_principles: "From first principles",
  contrasting_cases: "Contrasting cases",
  worked_example: "Step by step",
  analogy: "An analogy",
  visual: "A picture of it",
  derivation: "Deriving it",
};

function Refs({ refs, open, label = "From the lecture" }: { refs: PracticeCoachingView["refs"]; open: (t: SourceTarget) => void; label?: string }) {
  if (!refs.length) return null;
  return (
    <div className="provenance">
      <span className="kicker">{label}</span>
      {refs.map((r, i) => (
        <RefChip key={i} r={r} open={open} />
      ))}
    </div>
  );
}

/** "Preparing…", "Waiting for AI…" or "Couldn't prepare…", with Retry when it can help. */
function GuideState({ status, error, what, onRetry, skeleton = 0 }: { status: string; error: string | null; what: string; onRetry?: () => Promise<unknown>; skeleton?: number }) {
  const { status: shell } = useShell();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const retry = onRetry && (status === "failed" || (status === "waiting" && !shell?.paused)) && (
    <button
      type="button"
      className="btn small"
      disabled={busy}
      aria-busy={busy}
      onClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await onRetry();
        } catch (e) {
          setErr(e instanceof ApiError && e.paused ? `AI generation is paused: ${e.paused.reason}` : errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Retrying…" : "Retry explanation"}
    </button>
  );
  return (
    <div className="guide-state" role="status">
      {status === "pending" ? (
        <>
          <p className="working small">
            <span className="spinner" aria-hidden />
            <span className="grow">
              Preparing {what}… This usually takes under a minute.
              <Elapsed />
            </span>
          </p>
          {skeleton > 0 && <SkeletonLines lines={skeleton} />}
        </>
      ) : (
        <p className="small guide-wait">
          <b>{status === "failed" ? `Couldn't prepare ${what}.` : "Waiting for AI."}</b> {shell?.paused && status === "waiting" ? shell.paused.reason : error}{" "}
          {status === "waiting" && `It will appear once a provider is available.`}
        </p>
      )}
      {retry}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/**
 * Coaching after a miss, compact first: what may have gone wrong and the core idea in two
 * sentences, then a follow-up box (ask exactly what is unclear), then the full explanation,
 * worked example and check question one click away. The step's key never appears here.
 */
export function CoachingBlock({
  c,
  step,
  onUpdate,
  openSource,
  earlier = false,
  fullOpen = false,
  onFullToggle,
}: {
  c: PracticeCoachingView;
  step: PracticeStepView;
  onUpdate: (s: PracticeStepView) => void;
  openSource: (t: SourceTarget) => void;
  /** An earlier round, shown collapsed (in full: it was the explanation then). */
  earlier?: boolean;
  /** The optional explanation disclosure is open. It never gates the next attempt. */
  fullOpen?: boolean;
  onFullToggle?: (open: boolean) => void;
}) {
  const ids = useId();
  const headingId = `${ids}-coach`;
  const answered = c.check?.attempt;
  // The explanation as it is being written (each preview was leak-checked by the server first).
  const live = useLivePreview((ev) => ev.coachingId === c.id && ev.task === "practice_coach");
  // Its check question, written once the explanation is committed: the stem streams (leak-checked first).
  const checkLive = useLivePreview((ev) => ev.coachingId === c.id && ev.task === "practice_coach_check");
  const streaming = c.status === "pending" && !earlier && (live.fields || live.revising);
  // Announced once when the finished explanation replaces the preview (the preview itself is not announced).
  const [announce, setAnnounce] = useState("");
  const wasStatus = useRef(c.status);
  useEffect(() => {
    if (wasStatus.current !== "ready" && c.status === "ready" && !earlier) setAnnounce("Explanation ready.");
    wasStatus.current = c.status;
  }, [c.status, earlier]);
  const submit = async (a: Answer) => {
    try {
      onUpdate(await api.answerCoachingCheck(c.id, { selected: a.selected, dontKnow: a.dontKnow, confidence: a.confidence }));
    } catch (e) {
      throw new Error(errorMessage(e));
    }
  };
  const followUp = (
    <FollowUpBox
      kind="practice_coaching"
      targetId={c.id}
      thread={c.followUp}
      openSource={openSource}
      scope={step.id}
      collapsible
      placeholder="Ask about exactly what's unclear: the idea, the diagnosis, or how to start the step (the answer itself stays hidden until you've solved it)…"
    />
  );
  const full = (
    <>
      <div className="coach-part">
        <h4 className="kicker">
          The idea{c.strategy && STRATEGY[c.strategy] ? <span className="muted"> · {STRATEGY[c.strategy]}</span> : null}
        </h4>
        <Markdown text={c.explanation} />
        <Refs refs={c.refs} open={openSource} />
        {c.provenance === "supplementary" && <p className="muted small">Supplementary explanation, not quoted from your lecture.</p>}
      </div>
      <div className="aside coach-example">
        <h4 className="kicker">Worked example on different data</h4>
        <Markdown text={c.example} />
      </div>
      {!c.check && c.checkStatus === "pending" && <QuestionPreview stem={checkLive.fields?.["check.stem"]} revising={checkLive.revising} kicker="Optional quick check" />}
      {!c.check && c.checkStatus !== "ready" && c.checkStatus !== "pending" && (
        <GuideState status={c.checkStatus} error={c.checkError} what="a question to check the idea" onRetry={async () => onUpdate(await api.retryCoaching(step.id))} />
      )}
      {c.check && (
        <QuestionCard
          question={c.check}
          kicker="Optional quick check"
          allowNote={false}
          onSubmit={submit}
          feedback={
            answered
              ? {
                  message: answered.correct ? "That's the idea. Now use it on the step." : answered.dontKnow ? "That's fine: read the worked example once more, then try the step." : "Compare with the worked example above, then try the step.",
                  reasoning: null,
                  reasoningStatus: "none",
                }
              : undefined
          }
        />
      )}
      {answered && (
        <div className="aside hint-box coach-next">
          <h4 className="kicker">When you retry</h4>
          <Markdown text={c.nextHint} />
        </div>
      )}
    </>
  );

  if (earlier) {
    return (
      <details className="expand coach earlier">
        <summary>Earlier explanation (round {c.round})</summary>
        {c.status === "ready" ? (
          <>
            <div className="coach-part">
              <h4 className="kicker">What may have gone wrong</h4>
              <Markdown text={c.diagnosis} />
            </div>
            {full}
            {c.followUp && c.followUp.turns.length > 0 && followUp}
          </>
        ) : (
          <GuideState status={c.status} error={c.error} what="an explanation for this step" onRetry={async () => onUpdate(await api.retryCoaching(step.id))} />
        )}
      </details>
    );
  }

  const body = streaming ? (
    live.revising || !live.fields ? (
      <Revising />
    ) : (
      <div className="preview" aria-live="off" aria-busy="true">
        <div className="coach-part">
          <h4 className="kicker">
            What may have gone wrong <Writing />
          </h4>
          {live.fields.diagnosis && <PreviewMarkdown text={live.fields.diagnosis} />}
        </div>
        {live.fields.summary && (
          <div className="coach-part coach-core">
            <h4 className="kicker">The core idea</h4>
            <PreviewMarkdown text={live.fields.summary} />
          </div>
        )}
        {live.fields.explanation && <p className="muted small">The full explanation is being written…</p>}
      </div>
    )
  ) : c.status !== "ready" ? (
    <>
      <GuideState status={c.status} error={c.error} what="an explanation for this step" skeleton={3} onRetry={async () => onUpdate(await api.retryCoaching(step.id))} />
      {followUp}
    </>
  ) : (
    <>
      <div className="coach-part">
        <h4 className="kicker">What may have gone wrong</h4>
        <Markdown text={c.diagnosis} />
      </div>
      <div className="coach-part coach-core">
        <h4 className="kicker">The core idea</h4>
        <Markdown text={c.summary || c.explanation.trim().split(/\n\s*\n/)[0] || ""} />
        {!fullOpen && <Refs refs={c.refs} open={openSource} />}
      </div>
      <details className="expand coach-full" open={fullOpen} onToggle={(e) => onFullToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>See explanation and example</summary>
        {full}
      </details>
      {followUp}
    </>
  );
  return (
    <section className="coach" aria-labelledby={headingId}>
      <h3 className="coach-title" id={headingId}>
        {c.round > 1 ? "Another way to understand it" : "Help with this step"}
      </h3>
      {body}
      <div className="sr-only" role="status">
        {announce}
      </div>
    </section>
  );
}

/** The warm-up before a problem: one probe at a time; a miss opens a short explanation. */
export function PrimerCard({
  problem,
  onUpdate,
  openSource,
  onStart,
}: {
  problem: PracticeProblemView;
  onUpdate: (p: PracticeProblemView) => void;
  openSource: (t: SourceTarget) => void;
  /** Go to the problem's first step. */
  onStart: () => void;
}) {
  const primer: PracticePrimerView = problem.primer;
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => !primer.done);
  if (primer.status === "none" || primer.status === "skipped" || primer.status === "not_started") return null;

  const skip = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onUpdate(await api.skipPrimer(problem.id));
      onStart();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // Probes come one at a time: the next appears once the previous is answered.
  const shown = primer.probes.filter((p, i) => i === 0 || primer.probes[i - 1].question.attempt);

  const card = (
    <section className="card primer" aria-labelledby={`${ids}-title`}>
      <div className="row">
        <h2 id={`${ids}-title`} className="grow">
          Warm-up
        </h2>
        {!primer.done && (
          <button type="button" className="btn ghost small" onClick={skip} disabled={busy} aria-busy={busy}>
            {busy ? "Skipping…" : "Skip warm-up"}
          </button>
        )}
      </div>
      <p className="muted small">
        {primer.done
          ? "Warm-up done. The problem's first step is open below."
          : "An optional check of the ideas you'll use. You can skip it and start the problem whenever you like."}
      </p>
      {primer.status !== "ready" ? (
        <GuideState status={primer.status} error={primer.error} what="a short warm-up" skeleton={2} onRetry={async () => onUpdate(await api.startPrimer(problem.id))} />
      ) : (
        shown.map((p) => {
          const a = p.question.attempt;
          return (
            <div key={p.index} className="probe">
              <p className="small why">
                <b>{p.concept.name}.</b> <Markdown text={p.why} inline />
              </p>
              <QuestionCard
                question={p.question}
                kicker={`Warm-up ${p.index + 1} of ${primer.probes.length}`}
                allowNote={false}
                autoFocus={p.index > 0}
                onSubmit={async (ans) => {
                  try {
                    onUpdate(await api.answerProbe(problem.id, p.index, { selected: ans.selected, dontKnow: ans.dontKnow, confidence: ans.confidence }));
                  } catch (e) {
                    throw new Error(errorMessage(e));
                  }
                }}
                feedback={a ? { message: a.correct ? "" : "Here is the idea in short; the problem relies on it.", reasoning: null, reasoningStatus: "none" } : undefined}
              />
              {a && p.teach && (
                <details className="expand teach" open={a.correct !== true}>
                  <summary>The idea: {p.concept.name}</summary>
                  <Markdown text={p.teach} />
                  <Refs refs={p.refs} open={openSource} />
                </details>
              )}
            </div>
          );
        })
      )}
      {!primer.done && primer.status === "ready" && (
        <div className="row" style={{ marginTop: "0.8rem" }}>
          <button type="button" className="btn" onClick={skip} disabled={busy} aria-busy={busy}>
            {busy ? "Skipping…" : "Skip warm-up and start problem"} <span aria-hidden>→</span>
          </button>
        </div>
      )}
      {primer.done && primer.status === "ready" && (
        <div className="row" style={{ marginTop: "0.8rem" }}>
          <button type="button" className="btn primary" onClick={() => { setExpanded(false); onStart(); }}>
            Start step 1 <span aria-hidden>→</span>
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
  // Once done, the warm-up folds away so the problem's data stays close to the step being worked.
  // Stays open (the learner folds it), so its questions don't vanish once answered.
  return (
    <details className="primer-done" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>{primer.done ? "Warm-up complete" : "Optional warm-up"}</summary>
      {card}
    </details>
  );
}

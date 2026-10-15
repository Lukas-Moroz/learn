import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PracticeSetView } from "../../shared/practice.ts";
import { api, ApiError, errorMessage } from "../api.ts";
import { TopBar, useShell } from "../components/TopBar.tsx";
import { problemLabel } from "../practice.ts";
import { usePracticeLive } from "../practiceLive.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A practice set: its problems with progress, filling in live while the documents are being read. */
export function PracticeSetPage({ setId }: { setId: string }) {
  const { status } = useShell();
  const [set, setSet] = useState<PracticeSetView | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteBtn = useRef<HTMLButtonElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const ids = useId();

  const load = useCallback(
    () =>
      api.practiceSet(setId).then(
        (s) => {
          setSet(s);
          setLoadError(null);
        },
        // A failed background refresh keeps the last good view; only a first load shows the error.
        (e) => setLoadError({ message: errorMessage(e), missing: e instanceof ApiError && e.status === 404 }),
      ),
    [setId],
  );
  useEffect(() => {
    load();
  }, [load]);
  usePracticeLive(load, { match: (ev) => ev.setId === setId, pollMs: set?.status === "extracting" ? 8000 : null });
  useEffect(() => {
    if (confirmDelete) confirmBtn.current?.focus();
  }, [confirmDelete]);

  const retry = async () => {
    setBusy("retry");
    setActionError(null);
    try {
      setSet(await api.retryPractice(setId));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("delete");
    setActionError(null);
    try {
      await api.deletePractice(setId);
      location.hash = "#/";
    } catch (e) {
      setActionError(errorMessage(e));
      setBusy(null);
    }
  };

  if (!set) {
    return (
      <>
        <TopBar crumbs={<b>Exam practice</b>} />
        <main className="page reading practice">
          {loadError ? (
            <div className="banner bad" role="alert">
              <span className="grow">
                <b>{loadError.missing ? "This practice set no longer exists." : "Couldn't load this practice set."}</b> {loadError.missing ? "" : loadError.message}
              </span>
              {loadError.missing ? (
                <a className="btn small" href="#/">
                  Back to home
                </a>
              ) : (
                <button className="btn small" onClick={load}>
                  Retry
                </button>
              )}
            </div>
          ) : (
            <p className="working" role="status">
              <span className="spinner" aria-hidden /> Loading practice set…
            </p>
          )}
        </main>
      </>
    );
  }

  const steps = set.problems.reduce((n, p) => n + p.stepCount, 0);
  const answered = set.problems.reduce((n, p) => n + p.answered, 0);
  const correct = set.problems.reduce((n, p) => n + p.correct, 0);
  const skipped = set.problems.reduce((n, p) => n + p.skipped, 0);
  const next = set.problems.find((p) => p.completed < p.stepCount);
  const remaining = set.status === "extracting" && set.progress.total ? Math.max(0, set.progress.total - set.problems.length) : 0;

  return (
    <>
      <TopBar crumbs={<b>{set.title}</b>} />
      <main className="page reading practice">
        <a className="back-link small" href="#/">
          <span aria-hidden>←</span> Home
        </a>
        <div className="kicker" style={{ marginTop: "0.8rem" }}>
          Exam practice
        </div>
        <h1>{set.title}</h1>
        <p className="muted small key-note">
          Problems from <b>{set.problemTitle}</b>.{" "}
          {set.keySource === "solutions" ? (
            set.solutionSourceId === set.problemSourceId ? (
              "Answers are checked against the solutions in the same document."
            ) : (
              <>
                Answers are checked against <b>{set.solutionTitle ?? "your solutions document"}</b>.
              </>
            )
          ) : null}
          {set.keySource === "solutions" && set.unverifiedSteps > 0 && (
            <>
              {" "}
              <span className="badge warn">AI-derived keys</span> {set.unverifiedSteps} {set.unverifiedSteps === 1 ? "step's answer was" : "steps' answers were"} not found in
              your solutions; {set.unverifiedSteps === 1 ? "it is" : "they are"} AI-derived and marked on the step.
            </>
          )}
          {set.keySource === "generated" && (
            <>
              <span className="badge warn">AI answer key</span> No solutions document was given, so the answer key was written by AI and is unverified. Check surprising answers against your notes.
            </>
          )}
        </p>

        {set.status === "extracting" && (
          <div className="banner info" role="status">
            <span className="spinner" aria-hidden />
            <span className="grow">
              <b>{set.progress.total ? `Reading problems: ${set.progress.done} of ${set.progress.total}` : "Finding the problems…"}</b>
              <br />
              <span className="small">Problems appear here as they're ready, and you can start on any of them now.</span>
            </span>
          </div>
        )}
        {set.status === "extracting" && status?.paused && (
          <div className="banner warn" role="status" style={{ marginTop: "0.8rem" }}>
            <span className="grow small">
              <b>AI generation is paused.</b> {status.paused.reason} Reading the rest of the problems resumes when a provider is available. Problems already read can be practised; numbers, sequences, tables and multiple choice are checked without AI.
            </span>
          </div>
        )}
        {set.status === "failed" && (
          <div className="banner bad" role="alert">
            <span className="grow">
              <b>Couldn't finish reading the documents.</b> {set.error ?? ""}
              {set.problems.length > 0 && <span className="small"> The problems read so far can still be practised.</span>}
            </span>
            <button className="btn small primary" onClick={retry} disabled={busy === "retry"} aria-busy={busy === "retry"}>
              {busy === "retry" ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {actionError && (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        )}

        {steps > 0 && (
          <section className="card practice-progress" aria-labelledby={`${ids}-progress`}>
            <div className="row">
              <div className="grow">
                <h2 className="kicker" id={`${ids}-progress`} style={{ margin: 0 }}>
                  Your progress
                </h2>
                <div>
                  {answered} of {plural(steps, "step")} answered · {correct} correct
                  {skipped > 0 && ` · ${skipped} skipped`}
                </div>
              </div>
              {next ? (
                <a className="btn primary" href={`#/practice/${set.id}/${next.id}`}>
                  {answered > 0 || skipped > 0 ? "Continue" : "Start"}: {problemLabel(next.number)}
                </a>
              ) : skipped > 0 && (
                <a className="btn" href={`#/practice/${set.id}/${set.problems.find((p) => p.skipped > 0)!.id}`}>Revisit skipped steps</a>
              )}
            </div>
            <div className="meter" role="progressbar" aria-label="Steps answered" aria-valuemin={0} aria-valuemax={steps} aria-valuenow={answered}>
              <div style={{ width: `${steps ? (answered / steps) * 100 : 0}%` }} />
            </div>
          </section>
        )}

        <h2 className="section-title">Problems</h2>
        {set.problems.length === 0 && set.status === "ready" ? (
          <div className="notice">No problems were found in this document. If it does contain problems, try setting it up again; the outline may have been misread.</div>
        ) : set.problems.length === 0 && set.status === "extracting" ? (
          <p className="muted">The first problem will appear here in a moment.</p>
        ) : (
          <ol className="problem-list">
            {set.problems.map((p) => {
              const done = p.stepCount > 0 && p.completed >= p.stepCount;
              return (
                <li key={p.id}>
                  <a href={`#/practice/${set.id}/${p.id}`} className="problem-link">
                    <span className="problem-number">{problemLabel(p.number)}</span>
                    <span className="problem-title">{p.title}</span>
                  </a>
                  <span className="muted small">
                    {p.answered === 0 && p.skipped === 0 ? `${plural(p.stepCount, "step")} · not started` : `${p.answered} of ${plural(p.stepCount, "step")} answered · ${p.correct} correct`}
                    {p.skipped > 0 && ` · ${p.skipped} skipped`}
                  </span>
                  {done && <span className={`badge ${p.correct === p.stepCount ? "good" : ""}`}>{p.correct === p.stepCount ? "✓ All correct" : p.skipped > 0 ? "Skipped steps to revisit" : "Done"}</span>}
                </li>
              );
            })}
            {remaining > 0 && (
              <li className="pending-problems muted small" aria-hidden>
                {plural(remaining, "more problem")} on the way…
              </li>
            )}
          </ol>
        )}

        <div className="danger-zone">
          {!confirmDelete ? (
            <button ref={deleteBtn} className="btn ghost small" onClick={() => setConfirmDelete(true)}>
              Remove this practice set
            </button>
          ) : (
            <div
              className="confirm"
              role="group"
              aria-labelledby={`${ids}-delete`}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                setConfirmDelete(false);
                requestAnimationFrame(() => deleteBtn.current?.focus());
              }}
            >
              <p id={`${ids}-delete`}>Remove “{set.title}” and all your answers in it? This can't be undone.</p>
              <div className="row">
                <button ref={confirmBtn} className="btn small danger" onClick={remove} disabled={busy === "delete"} aria-busy={busy === "delete"}>
                  {busy === "delete" ? "Removing…" : "Remove"}
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    setConfirmDelete(false);
                    requestAnimationFrame(() => deleteBtn.current?.focus());
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

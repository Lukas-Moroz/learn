import { useEffect, useId, useState, type FormEvent } from "react";
import type { PracticeCandidates, PracticeSetSummary, PracticeSetView } from "../../shared/practice.ts";
import { api, ApiError, errorMessage, type CourseSummary } from "../api.ts";
import { Modal } from "./Modal.tsx";
import { useShell } from "./TopBar.tsx";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line of status for a practice set, as shown on its course card. */
export function setStatusLine(s: Pick<PracticeSetSummary, "status" | "progress" | "problemCount" | "stepCount" | "answered" | "correct">): string {
  if (s.status === "extracting") return s.progress.total ? `Reading problems: ${s.progress.done} of ${s.progress.total}` : "Finding the problems…";
  if (s.status === "failed") return "Couldn't finish reading the documents";
  if (s.stepCount === 0) return "No problems found";
  return `${plural(s.problemCount, "problem")} · ${s.answered} of ${plural(s.stepCount, "step")} answered · ${s.correct} correct`;
}

/** The "Exam practice" part of a course card: its practice sets, and the action that sets one up. */
export function PracticeArea({ course, onChange }: { course: CourseSummary; onChange: () => void }) {
  const sets = course.practice ?? [];
  const [setup, setSetup] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  if (course.lectures.length === 0 && sets.length === 0) return null;

  const retry = async (id: string) => {
    setRetrying(id);
    setError(null);
    try {
      await api.retryPractice(id);
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="practice-area" role="group" aria-labelledby={`${ids}-head`}>
      <h4 className="kicker" id={`${ids}-head`}>
        Exam practice
      </h4>
      {sets.map((s, i) => (
        <div className="lecture-row practice-row" key={s.id}>
          <div className="lecture-main">
            <span className="title" id={`${ids}-s${i}`}>
              {s.title}
              {s.keySource === "generated" && (
                <span className="badge warn" style={{ marginLeft: 6 }} title="No solutions document: the answer key was written by AI and is unverified">
                  AI answer key
                </span>
              )}
            </span>
            <span className="muted small practice-status">
              {s.status === "extracting" && <span className="spinner inline" aria-hidden />}
              {setStatusLine(s)}
            </span>
            {s.status === "failed" && s.error && <span className="form-error">{s.error}</span>}
          </div>
          {s.status === "failed" ? (
            <button className="btn small" onClick={() => retry(s.id)} disabled={retrying === s.id} aria-busy={retrying === s.id} aria-describedby={`${ids}-s${i}`}>
              {retrying === s.id ? "Retrying…" : "Retry"}
            </button>
          ) : (
            <a className="btn small primary" href={`#/practice/${s.id}`} aria-describedby={`${ids}-s${i}`}>
              {s.status === "extracting" ? "Open" : s.answered > 0 ? "Continue" : "Practice"}
            </a>
          )}
        </div>
      ))}
      <button className="btn small" onClick={() => setSetup(true)} style={{ marginTop: sets.length ? "0.5rem" : 0 }}>
        Set up exam practice
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {setup && (
        <PracticeSetupDialog
          courseId={course.id}
          courseTitle={course.title}
          onClose={() => setSetup(false)}
          onCreated={(s) => {
            setSetup(false);
            onChange();
            location.hash = `#/practice/${s.id}`;
          }}
        />
      )}
    </div>
  );
}

/** Pick the problem document (study guide) and an optional solutions document; suggested pairs are preselected. */
export function PracticeSetupDialog({ courseId, courseTitle, onClose, onCreated }: { courseId: string; courseTitle: string; onClose: () => void; onCreated: (s: PracticeSetView) => void }) {
  const { openSettings } = useShell();
  const [cands, setCands] = useState<PracticeCandidates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState("");
  const [solution, setSolution] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; paused: boolean } | null>(null);
  const ids = useId();

  useEffect(() => {
    let stale = false;
    setLoadError(null);
    api.practiceCandidates(courseId).then(
      (c) => {
        if (stale) return;
        setCands(c);
        const inPractice = new Set(c.sources.filter((s) => s.inPractice).map((s) => s.id));
        const pick = c.suggested.find((s) => !inPractice.has(s.problemSourceId)) ?? c.suggested[0];
        if (pick) {
          setProblem(pick.problemSourceId);
          setSolution(pick.solutionSourceId ?? "");
        }
      },
      (e) => !stale && setLoadError(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
  }, [courseId, attempt]);

  const sources = cands?.sources ?? [];
  const nameOf = (id: string | null) => sources.find((s) => s.id === id)?.title ?? "";
  const suggestion = cands?.suggested.find((s) => s.problemSourceId === problem && (s.solutionSourceId ?? "") === solution);
  const shownTitle = title ?? suggestion?.title ?? nameOf(problem);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!problem) {
      setError({ message: "Choose the document that contains the problems.", paused: false });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createPractice(courseId, { problemSourceId: problem, solutionSourceId: solution || null, ...(shownTitle.trim() ? { title: shownTitle.trim() } : {}) }));
    } catch (err) {
      const paused = err instanceof ApiError && err.paused;
      setError({ message: paused ? `AI generation is paused: ${paused.reason} Reading the documents needs an AI provider.` : errorMessage(err), paused: Boolean(paused) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal label="Set up exam practice" className="dialog" onClose={onClose}>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="kicker">{courseTitle}</div>
          <h2 style={{ margin: "0.2rem 0 0.3rem" }}>Set up exam practice</h2>
        </div>
        <button className="btn small" onClick={onClose} aria-label="Close">
          <span aria-hidden>✕</span>
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Learn reads both documents once and turns each problem into steps you can check.
      </p>

      {loadError ? (
        <div className="banner bad small" role="alert">
          <span className="grow">
            <b>Couldn't load this course's documents.</b> {loadError}
          </span>
          <button className="btn small" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
        </div>
      ) : !cands ? (
        <p className="working" role="status">
          <span className="spinner" aria-hidden /> Loading documents…
        </p>
      ) : sources.length === 0 ? (
        <div className="notice">This course has no documents yet. Upload the study guide (and its solutions, if you have them) to the course first.</div>
      ) : (
        <form className="practice-setup" onSubmit={submit} noValidate>
          {cands.suggested.length > 0 && (
            <fieldset className="suggestions">
              <legend className="kicker">Suggested</legend>
              {cands.suggested.map((s, i) => {
                const checked = s === suggestion;
                return (
                  <label key={i} className={`option ${checked ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name={`${ids}-suggested`}
                      checked={checked}
                      onChange={() => {
                        setProblem(s.problemSourceId);
                        setSolution(s.solutionSourceId ?? "");
                      }}
                    />
                    <span className="label">
                      <b>{s.title}</b>
                      <br />
                      <span className="muted small">
                        {nameOf(s.problemSourceId)}
                        {s.solutionSourceId === s.problemSourceId ? " · solutions in the same document" : s.solutionSourceId ? ` + ${nameOf(s.solutionSourceId)}` : " · no solutions document"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          <div className="field">
            <label className="field-label" htmlFor={`${ids}-problem`}>
              Problems
            </label>
            <select
              id={`${ids}-problem`}
              value={problem}
              onChange={(e) => {
                setProblem(e.target.value);
                if (problem && solution === problem) setSolution(e.target.value); // "same document" follows the problem document
                setError(null);
              }}
              aria-invalid={error && !problem ? true : undefined}
            >
              {!problem && <option value="">Choose a document…</option>}
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {plural(s.pageCount, "page")}
                  {s.inPractice ? " (already in practice)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-solution`}>
              Solutions <span className="muted">(optional)</span>
            </label>
            <select id={`${ids}-solution`} value={solution} onChange={(e) => setSolution(e.target.value)}>
              <option value="">No solutions document</option>
              {problem && <option value={problem}>Solutions are in the same document</option>}
              {sources
                .filter((s) => s.id !== problem)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {plural(s.pageCount, "page")}
                  </option>
                ))}
            </select>
          </div>
          {!solution && problem && (
            <div className="banner warn small" role="note">
              <span>
                <b>No solutions document.</b> Learn will write the answer key itself. It's AI-generated and unverified, so check surprising answers against your notes.
              </span>
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-title`}>
              Title
            </label>
            <input id={`${ids}-title`} type="text" value={shownTitle} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Exam 2 practice" />
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error.message}{" "}
              {error.paused && (
                <button type="button" className="btn small" onClick={openSettings}>
                  Providers
                </button>
              )}
            </div>
          )}
          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>
              {busy ? "Starting…" : "Start reading"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

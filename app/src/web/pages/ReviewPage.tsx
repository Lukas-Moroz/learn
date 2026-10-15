import { useCallback, useEffect, useRef, useState } from "react";
import type { QuestionView } from "../../shared/schemas.ts";
import { api, errorMessage, type ReviewItem } from "../api.ts";
import { bringIntoView, QuestionCard, StatusBadge, type FeedbackInfo } from "../components/QuestionCard.tsx";
import { TopBar } from "../components/TopBar.tsx";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Spaced retrieval practice. Works offline: stored questions, deterministic grading. */
export function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, { q: QuestionView; fb: FeedbackInfo }>>({});
  const [skipped, setSkipped] = useState<Record<string, true>>({});
  const [submitting, setSubmitting] = useState(false);
  /** Index of the question in view; equal to the due count once the session is finished. */
  const [pos, setPos] = useState(0);
  const summary = useRef<HTMLDivElement>(null);
  const questionSection = useRef<HTMLElement>(null);
  const load = useCallback(() => {
    setError(null);
    api.review().then(
      // Stored questions keep the purpose they had in their lesson ("What do you already know?"); here they are retrieval practice.
      (r) => setItems(r.map((it) => ({ ...it, question: { ...it.question, purpose: "review" } }))),
      (e) => setError(errorMessage(e)),
    );
  }, []);
  useEffect(load, [load]);
  const due = items?.filter((i) => i.due) ?? [];
  const later = items?.filter((i) => !i.due) ?? [];
  const finished = due.length > 0 && pos >= due.length;
  useEffect(() => {
    if (finished && summary.current) bringIntoView(summary.current);
  }, [finished]);

  const current = due[pos];
  const done = current ? answered[current.question.id] : undefined;
  useEffect(() => {
    const section = questionSection.current;
    if (section) bringIntoView(section, section.querySelector<HTMLElement>(".question"));
  }, [current?.question.id]);
  const results = due.map((it) => answered[it.question.id]).filter(Boolean);
  const skippedItems = due.filter((it) => skipped[it.question.id]);
  const correct = results.filter((r) => r.q.attempt?.correct === true).length;
  const unknown = results.filter((r) => r.q.attempt?.dontKnow).length;
  const demonstrated = results.filter((r) => r.fb.mastery?.status === "demonstrated").length;
  const history = due.filter((it, i) => i !== pos && (answered[it.question.id] || skipped[it.question.id]));
  const next = due.findIndex((it, i) => i > pos && !answered[it.question.id] && !skipped[it.question.id]);
  const goNext = () => setPos(next < 0 ? due.length : next);
  const skip = () => {
    if (!current || submitting || done) return;
    // Skipping is navigation only; it must not submit an "I don't know" attempt.
    setSkipped((s) => ({ ...s, [current.question.id]: true }));
    goNext();
  };
  const revisitSkipped = () => {
    const first = due.findIndex((it) => skipped[it.question.id]);
    if (first < 0) return;
    setSkipped({});
    setPos(first);
  };

  return (
    <>
      <TopBar crumbs={<b>Review</b>} />
      <main className="page reading">
        <h1>Review</h1>
        <p className="muted">
          A quick check of concepts you've studied. Answer one at a time, or skip a question and come back to it later.
        </p>
        {error ? (
          <div className="banner bad" role="alert">
            <span style={{ flex: 1 }}>
              <b>Couldn't load your review queue.</b> {error}
            </span>
            <button className="btn small" onClick={load}>
              Retry
            </button>
          </div>
        ) : items === null ? (
          <p className="working" role="status">
            <span className="spinner" aria-hidden="true" /> Loading your review queue…
          </p>
        ) : due.length === 0 ? (
          <div className="notice">Nothing is due right now.</div>
        ) : (
          <>
            <p className="review-count">
              <b>{plural(due.length, "concept")} due today.</b>{" "}
              <span className="muted">
                {results.length} of {due.length} answered
                {skippedItems.length > 0 && ` · ${skippedItems.length} skipped`}
              </span>
            </p>
            {current && (
              <section key={current.question.id} ref={questionSection} aria-labelledby="review-current">
                <div className="row" style={{ marginBottom: "0.6rem", flexWrap: "wrap" }}>
                  <div style={{ flex: 1 }}>
                    <div className="kicker">Question {pos + 1} of {due.length}</div>
                    <div className="row" style={{ marginTop: "0.2rem" }}>
                      <b id="review-current">{current.name}</b> <StatusBadge status={done?.fb.mastery?.status ?? current.status} />
                    </div>
                  </div>
                  {!done && (
                    <button className="btn ghost small" onClick={skip} disabled={submitting} title="Leave this question due and move on without answering">
                      Skip question
                    </button>
                  )}
                </div>
                <QuestionCard
                  question={done?.q ?? current.question}
                  feedback={done?.fb}
                  onSubmit={async (a) => {
                    setSubmitting(true);
                    try {
                      const r = await api.answerReview(current.question.id, a);
                      setAnswered((s) => ({ ...s, [current.question.id]: { q: { ...current.question, attempt: r.attempt }, fb: { message: r.message, reasoning: null, reasoningStatus: r.attempt.reasoningStatus, mastery: r.mastery } } }));
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                />
                {done && (
                  <div className="continue-bar" style={{ margin: "1rem 0 0" }}>
                    <button className="btn primary" onClick={goNext} autoFocus>
                      {next >= 0 ? "Next question" : "Finish review"}
                    </button>
                  </div>
                )}
              </section>
            )}
            {finished && (
              <div className="card review-summary" ref={summary} tabIndex={-1} role="status">
                <h2 style={{ marginTop: 0 }}>{skippedItems.length ? "Review finished" : "Review complete"}</h2>
                {results.length > 0 ? (
                  <p>
                    You answered {plural(results.length, "question")}: {correct} correct
                    {results.length - correct - unknown > 0 && `, ${results.length - correct - unknown} not quite`}
                    {unknown > 0 && `, ${unknown} you didn't know yet`}.
                  </p>
                ) : <p>No answers recorded this time.</p>}
                {demonstrated > 0 && <p className="muted small">{plural(demonstrated, "concept")} now demonstrated; next review after a longer gap.</p>}
                {correct < results.length && <p className="muted small">Missed concepts stay in your review queue for another try.</p>}
                {skippedItems.length > 0 && <p className="muted small">{plural(skippedItems.length, "question")} skipped. Skipped questions stay due for another time.</p>}
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {skippedItems.length > 0 && <button className="btn primary" onClick={revisitSkipped}>Review skipped questions</button>}
                  <a className="btn" href="#/">Back to home</a>
                </div>
              </div>
            )}
            {history.length > 0 && (
              <details className="expand" style={{ marginTop: "1.5rem" }}>
                <summary>Session history ({history.length})</summary>
                {history.map((it) => {
                  const result = answered[it.question.id];
                  return result ? (
                    <details key={it.question.id} className="expand">
                      <summary>{it.name} · {result.q.attempt?.dontKnow ? "Didn't know yet" : result.q.attempt?.correct ? "Correct" : "Not quite"}</summary>
                      <QuestionCard question={result.q} feedback={result.fb} onSubmit={async () => undefined} />
                    </details>
                  ) : (
                    <p key={it.question.id} className="muted small">{it.name} · Skipped</p>
                  );
                })}
              </details>
            )}
          </>
        )}
        {later.length > 0 && (
          <>
            <div className="section-title">Coming up</div>
            {later.map((it) => (
              <div className="concept-row" key={it.conceptId}>
                <span style={{ flex: 1 }}>{it.name}</span>
                <StatusBadge status={it.status} />
                <span className="muted small">{it.nextReviewAt ? new Date(it.nextReviewAt).toLocaleDateString() : ""}</span>
              </div>
            ))}
          </>
        )}
      </main>
    </>
  );
}

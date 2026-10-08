import { useEffect, useState } from "react";
import type { QuestionView } from "../../shared/schemas.ts";
import { api, type ReviewItem } from "../api.ts";
import { QuestionCard, StatusBadge, type FeedbackInfo } from "../components/QuestionCard.tsx";
import { TopBar } from "../components/TopBar.tsx";

/** Spaced retrieval practice. Works offline: stored questions, deterministic grading. */
export function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [answered, setAnswered] = useState<Record<string, { q: QuestionView; fb: FeedbackInfo }>>({});
  useEffect(() => {
    api.review().then(setItems);
  }, []);
  const due = items?.filter((i) => i.due) ?? [];
  const later = items?.filter((i) => !i.due) ?? [];
  return (
    <>
      <TopBar crumbs={<b>Review</b>} />
      <main className="page reading">
        <h1>Review</h1>
        <p className="muted">
          Retrieval practice on concepts you've studied, scheduled with growing gaps (1, 3, 7, 21… days). Optional, and it works without an AI provider.
        </p>
        {items === null ? null : due.length === 0 ? (
          <div className="notice">Nothing is due right now.</div>
        ) : (
          <div className="stream">
            {due.map((it) => {
              const done = answered[it.question.id];
              return (
                <section key={it.conceptId}>
                  <div className="row" style={{ marginBottom: "0.4rem" }}>
                    <b>{it.name}</b> <StatusBadge status={done?.fb.mastery?.status ?? it.status} />
                  </div>
                  <QuestionCard
                    question={done?.q ?? it.question}
                    feedback={done?.fb}
                    onSubmit={async (a) => {
                      const r = await api.answerReview(it.question.id, a);
                      setAnswered((s) => ({ ...s, [it.question.id]: { q: { ...it.question, attempt: r.attempt }, fb: { message: r.message, reasoning: null, reasoningStatus: r.attempt.reasoningStatus, mastery: r.mastery } } }));
                    }}
                  />
                </section>
              );
            })}
          </div>
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

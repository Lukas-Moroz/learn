// Spaced retrieval practice outside lessons. Works fully offline: questions are
// stored, grading is deterministic, and written reasoning is evaluated later if no
// provider is available.
import { grade } from "../../shared/grading.ts";
import { computeMastery, evidenceFromAttempt, nextReviewAt } from "../../shared/mastery.ts";
import { AttemptInput } from "../../shared/schemas.ts";
import type { Repo } from "../db/repo.ts";
import { feedbackMessage } from "./engine.ts";
import { attemptView, questionView } from "./view.ts";

export function reviewQueue(repo: Repo, now = new Date()) {
  const items = [];
  for (const id of repo.conceptsWithEvidence()) {
    const evidence = repo.evidenceFor(id);
    const m = computeMastery(id, evidence, { central: false, activeMisconceptions: repo.activeMisconceptions(id), now });
    const questions = repo.questionsForConcept(id);
    if (!questions.length) continue;
    const due = m.status === "needs_review" || (m.status === "developing" && repo.activeMisconceptions(id).length > 0);
    // Least recently asked first, so review varies the situation.
    const lastAsked = new Map<string, string>();
    for (const q of questions) {
      const a = repo.attemptsForQuestion(q.id);
      lastAsked.set(q.id, a.length ? a[a.length - 1].created_at : "");
    }
    const q = [...questions].sort((a, b) => (lastAsked.get(a.id)! || a.created_at).localeCompare(lastAsked.get(b.id)! || b.created_at))[0];
    items.push({
      conceptId: id,
      name: repo.getConcept(id)!.name,
      status: m.status,
      due,
      nextReviewAt: nextReviewAt(evidence),
      question: questionView(q, undefined),
    });
  }
  return items.sort((a, b) => Number(b.due) - Number(a.due) || (a.nextReviewAt ?? "").localeCompare(b.nextReviewAt ?? ""));
}

export function answerReview(repo: Repo, questionId: string, raw: unknown, now = new Date()) {
  const input = AttemptInput.parse(raw);
  const q = repo.getQuestion(questionId);
  if (!q) throw new Error("Question not found");
  const g = grade(q.options, q.correct, input);
  const note = input.note?.trim() || null;
  return repo.tx(() => {
    const attempt = repo.insertAttempt({
      question_id: q.id,
      lesson_id: null,
      selected: input.dontKnow ? [] : input.selected,
      dont_know: input.dontKnow,
      confidence: input.dontKnow ? null : input.confidence,
      note,
      correct: g.correct,
      misconceptions: g.misconceptions,
      reasoning_status: note ? "pending" : "none",
      reasoning: null,
    });
    repo.addEvidence(
      q.concept_id,
      null,
      attempt.id,
      evidenceFromAttempt({ kind: q.kind, context: q.context, purpose: "review", correct: g.correct, confidence: attempt.confidence, reasoning: null }, now.toISOString()),
    );
    for (const m of g.misconceptions) repo.recordMisconception(q.concept_id, m, null, attempt.confidence);
    const m = computeMastery(q.concept_id, repo.evidenceFor(q.concept_id), { central: false, activeMisconceptions: repo.activeMisconceptions(q.concept_id), now });
    return {
      attempt: attemptView(q, attempt),
      message: feedbackMessage(g.correct, attempt.confidence, null, g.misconceptions[0] ?? null),
      mastery: { status: m.status, reasons: m.reasons },
    };
  });
}

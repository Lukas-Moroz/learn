// Follow-up questions: after any answer (practice step, coaching round, or lesson block) the
// learner can ask a free-text question and get a short, focused answer before moving on.
// Shared contract between server and client; AI output is validated here.
import { z } from "zod";
import { PracticeRef } from "./practice.ts";
import type { Provenance, SourceRef } from "./schemas.ts";

/** What a thread hangs off: a practice step, one coaching round of a step, or a lesson block (explanation or answer feedback). */
export const FollowUpTargetKind = z.enum(["practice_step", "practice_coaching", "lesson_block"]);
export type FollowUpTargetKind = z.infer<typeof FollowUpTargetKind>;

/** AI task "follow_up": a conversational answer to exactly what was asked. */
export const FollowUpAnswer = z.object({
  /** Markdown with $…$ math; short and aimed at the question. */
  answer: z.string().min(1).max(4000),
  /** Lecture pages from the input excerpts ({doc, page, quote}); checked like every other ref. */
  refs: z.array(PracticeRef).max(4).default([]),
});
export type FollowUpAnswer = z.infer<typeof FollowUpAnswer>;

export const FollowUpAsk = z.object({
  kind: FollowUpTargetKind,
  id: z.string().min(1).max(100),
  question: z.string().trim().min(1, "Type a question first.").max(2000, "Keep the question under 2000 characters."),
});
export type FollowUpAsk = z.infer<typeof FollowUpAsk>;

/** "pending": being answered; "waiting": no AI provider right now (retried on resume); "failed": the answer didn't pass the checks. */
export type FollowUpStatus = "pending" | "waiting" | "failed" | "ready";

export interface FollowUpTurnView {
  id: string;
  question: string;
  /** null until it is answered. */
  answer: string | null;
  refs: SourceRef[];
  provenance: Provenance;
  status: FollowUpStatus;
  error: string | null;
  createdAt: string;
}

export interface FollowUpThreadView {
  id: string;
  kind: FollowUpTargetKind;
  targetId: string;
  /** Oldest first. */
  turns: FollowUpTurnView[];
}

// Deterministic follow-up answers for the mock provider. Long enough to stream in several chunks,
// citing the first lecture excerpt that mentions the concept (copied exactly, so the quote verifies).
// Like a careful model it never echoes the question or names a key while the key is hidden.
import { lectureRef } from "./practice.ts";

type Excerpt = { doc: number; page: number; text: string };

export function followUp(input: {
  question?: string;
  keyStatus?: "open" | "hidden";
  key?: { expected: unknown };
  thread?: unknown[];
  concepts?: { name: string; definition: string }[];
  about?: { concept?: { name: string; definition: string } | null };
  openQuestion?: unknown;
  lecture?: { excerpts: Excerpt[] } | null;
}) {
  const concept = input.concepts?.[0] ?? input.about?.concept ?? { name: "this idea", definition: "the idea this part rests on." };
  const n = (input.thread?.length ?? 0) + 1;
  const open = input.keyStatus !== "hidden";
  const asked = open && !input.openQuestion && input.question ? ` You asked: “${input.question.replace(/\s+/g, " ").slice(0, 140)}”.` : "";
  const key =
    open && input.key ? ` The answer for this step is ${typeof input.key.expected === "string" ? input.key.expected : "the table shown with the solution"}, and the worked solution shows each move.` : "";
  const hidden = open ? "" : " I won't give the step's answer away: use this idea when you try the step again.";
  return {
    answer: `*(Mock follow-up ${n})*${asked}\n\n**${concept.name}.** ${concept.definition}${key}${hidden}\n\nStart from what is always true here, then ask what the question is really asking for before computing anything; that usually shows the next move.`,
    refs: lectureRef(input.lecture?.excerpts, concept.name),
  };
}

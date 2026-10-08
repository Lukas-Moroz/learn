// Prompt builders. Each task sends *focused* context (never the whole course
// history) and asks for one JSON object that is validated against a zod schema.
import { z } from "zod";
import {
  ExplanationContent,
  ObjectivePlan,
  QuestionContent,
  ReasoningEvaluation,
  SourceAnalysis,
} from "../../shared/schemas.ts";
import { teachingPrinciples } from "./principles.ts";

/** Bump when a prompt changes in a way that should invalidate cached outputs. */
export const PROMPT_VERSION = {
  analyze_source: "analyze-v1",
  plan_objective: "plan-v1",
  explain: "explain-v1",
  question: "question-v1",
  evaluate_reasoning: "reasoning-v1",
} as const;

export type Task = keyof typeof PROMPT_VERSION;

export const TASK_SCHEMAS = {
  analyze_source: SourceAnalysis,
  plan_objective: ObjectivePlan,
  explain: ExplanationContent,
  question: QuestionContent,
  evaluate_reasoning: ReasoningEvaluation,
} satisfies Record<Task, z.ZodTypeAny>;

const ROLE = `You are the content engine of a personal tutoring application. The application, not you, decides what happens next in the lesson and keeps all learner state. Your job is to produce one piece of high-quality teaching content, exactly as specified.`;

const OUTPUT_RULES = `Output rules:
- Respond with ONE JSON object and nothing else (no Markdown fences, no commentary).
- Markdown string fields may use $…$ for inline math and $$…$$ for display math (LaTeX). Escape backslashes as JSON requires.
- Never invent citations. "refs" may only point to page/slide numbers that appear in the provided source excerpts, and a "quote" must be copied exactly from that page's text. If the content is your own supplementary explanation, leave "refs" empty.`;

const TASK_RULES: Record<Task, string> = {
  analyze_source: `Task: analyse an imported document so a learning path can be built from it.
- Decide whether it is a research paper, lecture slides/notes, or other.
- For a paper: state the research question and motivation, give a short overview, and list contributions, methods, experiments and conclusions.
- For lectures: describe the structure (sections with page/slide ranges), the major concepts and the intended progression. Do NOT paraphrase every slide.
- "concepts": the ideas a learner must understand. Include important prerequisite concepts that the document assumes but does not teach (role "background", pages []). Mark each concept "central" (needed to understand the source), "background" (useful foundation) or "optional" (deeper exploration). Give a real definition, not a list of properties. Prefer the names already used in "knownConcepts" when a concept is the same idea, and set "sense" when a common name is used in a domain-specific way.
- "prerequisites" lists names of other concepts in your list.
- "learningPath": concept names in teaching order: foundations first, then the document's own order. Every name must appear in "concepts".`,
  plan_objective: `Task: plan a learning path for a stated learning objective with no source document.
- List the concepts needed, from the lowest foundations up to the objective, with real definitions and prerequisite links.
- Mark the objective's own concepts "central" and foundations "background".
- "learningPath": names in teaching order, foundations first.`,
  explain: `Task: write one explanation block for one concept.
- Follow the requested "strategy" (first_principles, worked_example, analogy, contrasting_cases, visual, derivation). If "avoidStrategies" lists approaches that already failed, take a genuinely different conceptual route, not a rewording.
- Motivate first: why is this concept needed right now, and what problem does it solve? Build it from things the learner already knows ("learner.known"), and state the dependency edges explicitly in "connections".
- If "purpose" is "remediate": address the learner's specific misunderstanding ("learner.misconceptions", "learner.recentAttempts") head-on. Say what the tempting wrong idea is, why it is tempting, and precisely where it breaks. Do not claim certainty about why the learner erred; phrase it as the likely confusion.
- If "purpose" is "detour": say briefly why this prerequisite matters for "detourFor" before teaching it.
- If "purpose" is "return": reconnect the prerequisite just learned to the original concept.
- Equations: only when they carry the idea. Explain why the equation exists, what each term means in this context, how the terms interact, what changes when a term grows, shrinks or is removed, and the assumptions. Put any full derivation in "equation.derivation" (optional, shown collapsed).
- If you use an analogy you MUST say where it stops being accurate ("analogy.breaksDown").
- "diagram" (optional) is Mermaid source for a small dependency or flow diagram (≤ 7 nodes) when structure is clearer as a picture.
- Keep it focused: one concept, readable in two or three minutes.`,
  question: `Task: write ONE multiple-choice question that tests the underlying idea of a concept, not recognition of wording.
- Use the requested "kind": conceptual (basic check), causal (why X leads to Y), application (apply to a new scenario), multi_step (a short multi-step problem), diagnose_explanation (find the flaw in a stated explanation), compare (distinguish related concepts), plain_language (choose the best plain explanation), assumptions (identify assumptions/limitations), why_alternative_fails.
- "context": "novel" means the scenario must come from a domain unlike the one the concept was taught in (transfer). "original" may use the source's setting but with a fresh situation.
- Do NOT reuse phrases from "recentExplanation". Do NOT reuse any scenario in "avoid", and make the question meaningfully different from every question listed there (a different situation, not a paraphrase).
- Build the options per the quiz-construction procedure above: write the correct claim first, then mutate it into each distractor so all options share the same skeleton, length and register. No justification inside any option; no asymmetric bold. Every distractor must be a specific, realistic misconception, named in its "misconception" field. If "targetMisconceptions" is given, include distractors that would reveal them.
- Do not include an "I don't know" option (the app adds one). Avoid trick wording.
- "correct" is the option value (or values when multiSelect is true). "explanation" says why the correct answer is right and what each tempting distractor gets wrong.
- "rubric.keyIdeas": the ideas a sound written justification would mention; "rubric.commonFlaws": tell-tale signs of flawed reasoning.
- "difficulty": 1 (recall) to 5 (hard multi-step).`,
  evaluate_reasoning: `Task: evaluate the learner's optional written reasoning for a multiple-choice answer.
- Judge the REASONING on its own merits, independently of whether the selected option was correct. A correct choice backed by incorrect reasoning is "flawed"; a wrong choice with mostly sound reasoning but a slip may be "partially_sound".
- Use the rubric as a guide, but credit any valid line of reasoning.
- If the reasoning reveals a specific misconception, name it concisely in "misconception.label" (a short noun phrase usable as an identifier) and describe it. Do not guess a misconception that the text does not show.
- "summary": one or two sentences addressed to the learner, kind and precise.`,
};

function schemaText(task: Task): string {
  const schema = z.toJSONSchema(TASK_SCHEMAS[task], { io: "input", unrepresentable: "any" });
  return JSON.stringify(schema);
}

export function buildPrompt(task: Task, input: unknown): { instructions: string; user: string } {
  const instructions = [
    ROLE,
    "Teaching principles (from the learner's own teaching skill; follow them):",
    teachingPrinciples(),
    TASK_RULES[task],
    OUTPUT_RULES,
    `JSON Schema for your response:\n${schemaText(task)}`,
  ].join("\n\n");
  const user = `TASK: ${task}\n\nINPUT (JSON):\n${JSON.stringify(input, null, 1)}`;
  return { instructions, user };
}

/** Parse the INPUT JSON back out of a user message (used by the mock provider). */
export function parsePromptInput(user: string): { task: string; input: any } {
  const task = /^TASK: (\w+)/.exec(user)?.[1] ?? "";
  const idx = user.indexOf("INPUT (JSON):\n");
  return { task, input: idx >= 0 ? JSON.parse(user.slice(idx + "INPUT (JSON):\n".length)) : {} };
}

/** Extract a JSON object from model text, tolerating code fences and stray prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error("response did not contain a JSON object");
}

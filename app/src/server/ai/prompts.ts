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
import { FollowUpAnswer } from "../../shared/followup.ts";
import { PracticeCoachCheck, PracticeCoaching, PracticeGrade, PracticeOutline, PracticePrimer, PracticeProblemContent } from "../../shared/practice.ts";
import { teachingPrinciples } from "./principles.ts";

/** Bump when a prompt changes in a way that should invalidate cached outputs. */
export const PROMPT_VERSION = {
  analyze_source: "analyze-v2",
  plan_objective: "plan-v1",
  explain: "explain-v2",
  question: "question-v2",
  evaluate_reasoning: "reasoning-v1",
  practice_outline: "practice-outline-v2",
  practice_problem: "practice-problem-v1",
  grade_practice: "practice-grade-v1",
  practice_primer: "practice-primer-v1",
  practice_coach: "practice-coach-v3",
  practice_coach_check: "practice-coach-check-v1",
  follow_up: "follow-up-v1",
} as const;

export type Task = keyof typeof PROMPT_VERSION;

export const TASK_SCHEMAS = {
  analyze_source: SourceAnalysis,
  plan_objective: ObjectivePlan,
  explain: ExplanationContent,
  question: QuestionContent,
  evaluate_reasoning: ReasoningEvaluation,
  practice_outline: PracticeOutline,
  practice_problem: PracticeProblemContent,
  grade_practice: PracticeGrade,
  practice_primer: PracticePrimer,
  practice_coach: PracticeCoaching,
  practice_coach_check: PracticeCoachCheck,
  follow_up: FollowUpAnswer,
} satisfies Record<Task, z.ZodTypeAny>;

const ROLE = `You are the content engine of a personal tutoring application. The application, not you, decides what happens next in the lesson and keeps all learner state. Your job is to produce one piece of high-quality teaching content, exactly as specified.`;

const OUTPUT_RULES = `Output rules:
- Respond with ONE JSON object and nothing else (no Markdown fences, no commentary).
- Markdown string fields may use $…$ for inline math and $$…$$ for display math (LaTeX). Escape backslashes as JSON requires.
- Never invent citations. "refs" may only point to page/slide numbers that appear in the provided source excerpts, and a "quote" must be copied exactly from that page's text. If the content is your own supplementary explanation, leave "refs" empty.`;

const QRULES = `- Every question follows the quiz-construction procedure above: the stem is self-contained (it states every value, sequence and setup it depends on, and never points at something the learner cannot see, such as "the problem above" or "this cell"); write the correct claim first, then mutate it into each distractor so all options share the same skeleton, length and register; no justification inside any option; no asymmetric bold; every distractor is a specific, realistic misconception named in its "misconception" field; no "I don't know" option (the app adds one). "scenario" is a short hidden label without data. The app shuffles options, so the question's "explanation" names options by their content, never by letter, value or position.
- "refs": cite only pages from "lecture.excerpts", as {"doc", "page", "quote"} where "doc" is the excerpt's document number and "quote" is a short phrase (about 5–20 words) copied character for character from that page. Leave "refs" empty when the excerpts don't support what you wrote.`;

const TASK_RULES: Record<Task, string> = {
  analyze_source: `Task: analyse an imported document so a learning path can be built from it.
- Decide whether it is a research paper, lecture slides/notes, or other.
- For a paper: state the research question and motivation, give a short overview, and list contributions, methods, experiments and conclusions.
- For lectures: describe the structure (sections with page/slide ranges), the major concepts and the intended progression. Do NOT paraphrase every slide.
- "concepts": the ideas a learner must understand. Include important prerequisite concepts that the document assumes but does not teach (role "background", pages []). Mark each concept "central" (needed to understand the source), "background" (useful foundation) or "optional" (deeper exploration). Give a real definition, not a list of properties. Prefer the names already used in "knownConcepts" when a concept is the same idea.
- "sense": leave it out almost always. Set it ONLY to disambiguate a genuine homonym, a name whose meaning differs across fields (e.g. "kernel": operating systems vs machine learning), and then make it the field name ("operating systems"). Never use it to describe the concept or how this course uses it; that belongs in "interpretation".
- Pages marked "[page N: no extractable text …]" or "[page N: only a short fragment …]" are figures, handwriting or title slides whose content could not be read. Do not describe or guess what they show. You may include them in a section's or concept's page range when the neighbouring pages make clear what they belong to.
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
- Keep it focused: one concept, readable in two or three minutes.
- "refs": cite only "source" pages whose text you actually drew on, and give every ref a "quote": a short phrase (about 5–20 words) copied character for character from that page's text. The app checks each quote against the page; a ref without a verified quote counts only as a related page, and the block is then labelled supplementary. If the excerpt pages don't support what you wrote, leave "refs" empty.`,
  question: `Task: write ONE multiple-choice question that tests the underlying idea of a concept, not recognition of wording.
- The learner sees ONLY the stem and the options. The stem must be self-contained: state every value, sequence, score, table, parameter and setup the question depends on (the sequences, the scoring scheme, the numbers in the cell being asked about). Never point at something the learner cannot see ("this cell", "the matrix above", "the example from the lecture") unless the stem itself shows it.
- "scenario" is a short hidden label for the situation (a few words, e.g. "weather forecast with two-day memory"), used only so later questions avoid repeating it. It is never shown to the learner, so never put data there that the stem lacks.
- Use the requested "kind": conceptual (basic check), causal (why X leads to Y), application (apply to a new scenario), multi_step (a short multi-step problem), diagnose_explanation (find the flaw in a stated explanation), compare (distinguish related concepts), plain_language (choose the best plain explanation), assumptions (identify assumptions/limitations), why_alternative_fails.
- "context": "novel" means the scenario must come from a domain unlike the one the concept was taught in (transfer). "original" may use the source's setting but with a fresh situation.
- Do NOT reuse phrases from "recentExplanation". Do NOT reuse any scenario in "avoid", and make the question meaningfully different from every question listed there (a different situation, not a paraphrase).
- Build the options per the quiz-construction procedure above: write the correct claim first, then mutate it into each distractor so all options share the same skeleton, length and register. No justification inside any option; no asymmetric bold. Every distractor must be a specific, realistic misconception, named in its "misconception" field. If "targetMisconceptions" is given, include distractors that would reveal them.
- Do not include an "I don't know" option (the app adds one). Avoid trick wording.
- "correct" is the option value (or values when multiSelect is true). "explanation" says why the correct answer is right and what each tempting distractor gets wrong. The app shuffles and numbers the options for display, so never refer to an option by its value, letter or position ("option B", "(C)", "the second choice"); name it by its content instead.
- "rubric.keyIdeas": the ideas a sound written justification would mention; "rubric.commonFlaws": tell-tale signs of flawed reasoning.
- "difficulty": 1 (recall) to 5 (hard multi-step).
- "refs": only "source" pages the question is actually built on, each with a "quote": a short phrase copied character for character from that page's text. Leave "refs" empty for a question that doesn't use the source.`,
  evaluate_reasoning: `Task: evaluate the learner's optional written reasoning for a multiple-choice answer.
- Judge the REASONING on its own merits, independently of whether the selected option was correct. A correct choice backed by incorrect reasoning is "flawed"; a wrong choice with mostly sound reasoning but a slip may be "partially_sound".
- Use the rubric as a guide, but credit any valid line of reasoning.
- If the reasoning reveals a specific misconception, name it concisely in "misconception.label" (a short noun phrase usable as an identifier) and describe it. Do not guess a misconception that the text does not show.
- "summary": one or two sentences addressed to the learner, kind and precise. Refer to options by their content, never by value, letter or position.`,
  practice_outline: `Task: find the separate problems in an exam study guide or problem set ("problemDocument"), and where each one is answered in its solution document ("solutionDocument", may be null).
- "problems": every problem (or problem set) in document order. "number" is the problem's own identifier as printed, without the word "Problem" (e.g. "7"). "title" names its topic (e.g. "Levenshtein distance"). "problemPages": the pages it occupies in the problem document. "solutionPages": the pages of the solution document that answer it.
- Lettered parts (a), (b), … belong to their problem; they are not separate problems.
- Use only page numbers that appear in the provided documents. With a solution document, every problem needs its "solutionPages" (find where it is answered, even if the numbering differs). With no solution document, leave every "solutionPages" empty. Skip cover pages, scope tables and instructions that contain no problem.
- If "solutionDocument.sameAsProblemDocument" is true, one document holds both the problems and their solutions: "problemPages" are where a problem is stated and "solutionPages" where it is solved, both as page numbers of that document.
- "title": the name of the document as a whole (e.g. "Exam 2 Study Guide").`,
  practice_problem: `Task: turn ONE exam-practice problem into gradable steps with an answer key, so the learner can work it step by step and be checked automatically. "problemPages" holds the problem; "solutionPages" the official solution (when "keySource" is "solutions").
Key fidelity:
- keySource "solutions": copy every answer faithfully from the solution pages. Never silently "correct" the key. If a key value looks inconsistent, still use the key's value and say what looks wrong in that step's "solution".
- keySource "generated": no solution document exists. Solve the problem yourself, carefully, and begin every step's "solution" with "AI-generated key (no official solution was provided)."
Steps:
- One gradable thing per step, in the problem's own order, labelled by part: "(a)", "(b) matrix", "(b) traceback", "(c) explanation". Labels are unique.
- Split computations from explanations. A computed value is its own step of kind "number", "sequence", "table", "choice" or "text". An explanation, justification, derivation or recurrence is a separate step of kind "free", with "keyIdeas" (the points a full-credit answer makes) and "modelAnswer".
- "number": "value" is the key's value; prefer exact forms ("3/64", "log2(6)", "-2") to rounded decimals. Use only digits, + - * / ^, parentheses, fractions, log2(), log10(), ln(), sqrt(). Units go in "unit", never in the value. If the key gives only a rounded decimal, copy it and set "tolerance" to half a unit in its last place.
- "sequence": an ordered list of entries (a suffix array, a state path, occurrence positions); set "ordered": false when order does not matter (e.g. the set of all occurrence positions).
- "table": every DP, Viterbi or score matrix. Use the problem's exact row and column labels, including the ε (empty prefix) boundary row and column. "cells" has one row per row label and one entry per column label. Put backpointers in a separate table or step, written as the predecessor state or as "diag", "up" or "left". "given" (same shape, null where the learner writes) holds only values the problem itself prints. Use null in "cells" for cells that are not graded (e.g. "—").
- "choice": picking among named alternatives (which model, which source is larger). "correct" is an option value.
- "text": a short exact answer (a word, or an alignment row such as "AC-T"), with every accepted spelling in "accepted".
- Legitimate alternatives (another valid convention, tied optimal tracebacks, equivalent forms) go in "alternatives" (number, sequence) or are separated by " | " inside a table cell.
- "intro" restates ALL given data (sequences, scoring scheme, probability tables, conventions such as 0- or 1-based positions) so every step can be answered without the PDF. Use Markdown tables for given matrices.
- "prompt" says exactly what to enter and in what form (e.g. "Enter the suffix array as positions separated by spaces", "Fill every cell, including the boundary row and column").
- "solution": the worked solution for this step, from the solution pages (Markdown, $…$ math). "hint": a nudge that does not give the answer away.
- "solutionRefs": pages of the SOLUTION document, only from "solutionPages", where the step is answered; a "quote" must be copied exactly from that page. Leave empty when keySource is "generated".
- "concepts": the 1–6 concepts the problem exercises, with real definitions; reuse a name from "knownConcepts" when it is the same idea. Each step's "concepts" lists names from this list.
- "keywords": distinctive terms that slides teaching this would contain ("suffix array", "Viterbi", "traceback", "log-odds").`,
  practice_primer: `Task: write a short warm-up before the learner starts an exam-practice problem. The learner may be meeting this material cold, so first find out whether they hold the ideas the problem ASSUMES (Phase 1 "Probe" of the teaching skill), the way a tutor would before diving in.
- Write 1 or 2 probes ("probes"), each one multiple-choice question on a PREREQUISITE idea the problem takes for granted, not on the problem's own answer. For a suffix-array search problem that would be ideas like what a suffix array stores, how binary search over sorted items works, or what a half-open interval [lo, hi) contains. Order them foundation first.
- "concept": prefer a name from "concepts" (the problem's concepts and their known prerequisites). You may name a new, more basic prerequisite instead; then give its real "definition". Never probe a concept listed in "alreadyDemonstrated".
- The question is a probe: it tests whether the idea is understood (kind "conceptual", "causal" or "application"), on small data of its own, and never reuses the problem's data or reveals any of the problem's answers.
- "why": one sentence telling the learner why this problem needs the idea.
- "teach": a short conceptual explanation of the idea (Principle i, unconditional truths first; then why it has to be this way), shown only if the learner misses the probe. Ground it in "lecture.excerpts" when they cover it. Markdown with $…$ math, readable in under a minute.
${QRULES}`,
  practice_coach: `Task: the learner just got one step of a worked exam problem wrong (or said "I don't know"). Write a coaching block that pauses to rebuild their understanding, so they can retry the step themselves. Do NOT give them the answer.
- "key" and "solution" are for your eyes only: use them to understand what the step needs and where the learner went wrong. Never state the step's answer, any value of the key, or the solution's final numbers, anywhere in your output ("forbiddenValues" lists values the app will reject).
- "diagnosis": the likely misunderstanding behind this answer ("learner"), phrased tentatively ("It looks like…", "One common reason…"). Use "learner.wrongCells" for tables and "learner.feedback" from the grader. For "I don't know", name the idea the step rests on instead.
- "summary": the core idea the step needs, in at most TWO sentences, plain and concrete. The learner sees the diagnosis and this summary first; the full explanation is one click away, so the summary must stand on its own. No answer, no key values.
- "explanation": a conceptual explanation from first principles of the idea the step needs (Principle i and ii of the teaching skill): start from what is unconditionally true, then motivate each move so it feels discovered. Ground it in the lecture ("lecture.excerpts") where possible, citing those pages in "refs". Use the requested "strategy"; if "priorCoaching" lists earlier rounds for this step, they did not work: take a genuinely different route (not a rewording) and do not repeat their example.
- "example": a fully worked mini-example on DIFFERENT, SMALLER data than the problem (e.g. shorter strings, fewer symbols, a 2×2 table) that exercises exactly the same idea, every step shown. It must not reproduce the problem's data or the key's values.
- "nextHint": one or two sentences on what to look at when retrying the step, without the answer.
- Do not write a check question: the app asks for one separately, once this explanation is shown.
- "refs": cite only pages from "lecture.excerpts", as {"doc", "page", "quote"} where "doc" is the excerpt's document number and "quote" is a short phrase (about 5–20 words) copied character for character from that page. Leave "refs" empty when the excerpts don't support what you wrote.`,
  practice_coach_check: `Task: the learner just read a coaching block ("coaching": its explanation and worked mini-example) after missing one step of a worked exam problem. Write ONE multiple-choice question ("check") on the mini-example's idea (or a small variant of it), so they can confirm the idea landed before retrying the step.
- The learner sees ONLY the stem and the options; the stem must be self-contained. Restate the mini-example's data the question needs, never "the example above".
- It tests the idea the step needs, on the mini-example's own small data. Never use the problem's data and never write any of "forbiddenValues" (the step's answers): the app rejects a question that does.
- Do NOT reuse a scenario or stem from "avoid" (earlier check questions for this step).
- "kind": usually "application" or "conceptual"; "context": "original"; "difficulty": 1–3.
${QRULES}
- "refs": leave empty.`,
  follow_up: `Task: the learner just answered something (an exam-practice step, a coaching round, or a lesson question or explanation) and asked a follow-up question ("question"). Answer it, like a tutor talking to them before they move on.
- Answer exactly what was asked, conversationally and concisely: usually 2 to 6 sentences, a short list or a tiny worked example only when it helps. No preamble ("Great question"), no recap of everything they have already been shown, no new topics.
- Follow the teaching principles: start from what is unconditionally true and motivate each move so it feels discovered. If the question reveals a misunderstanding, name it gently and show precisely where it breaks.
- Use the context: "about" (what they were working on), "learner" (their attempts and how they were graded), "shown" (the feedback, coaching or explanation they have already seen) and "thread" (earlier questions and your answers in this conversation). Build on it; don't repeat it.
- "keyStatus" says what you may reveal:
  - "hidden": the learner has NOT finished this step yet. "hiddenKey" is for your eyes only, to understand what the step needs. Never state, confirm, hint at or narrow down the answer, any value in "hiddenKey.forbiddenValues", or the solution's final results, even if asked directly ("is it 2.5?"). Explain the idea or the method instead, on different, smaller data, and tell them that trying the step themselves is the next move. The app rejects an answer that gives the key away.
  - "open": the step is finished (answered correctly, counted as correct, or the solution was shown). Discuss the answer and the worked solution freely.
- "openQuestion" (lessons only), when present, is a question the learner has NOT answered yet. Never reveal or hint which of its options is correct, and never write its correct option's wording ("openQuestion.doNotSay"); the app rejects an answer that does. Help with the underlying idea instead.
- "refs": cite only pages from "lecture.excerpts", as {"doc", "page", "quote"} where "doc" is the excerpt's document number and "quote" is a short phrase (about 5–20 words) copied character for character from that page. Cite when your answer draws on a page; leave "refs" empty when it doesn't, or when there are no excerpts.`,
  grade_practice: `Task: grade the learner's written answer to one step of a worked exam problem.
- Compare the answer with "keyIdeas" and "modelAnswer". Credit any valid reasoning, even if phrased differently or reached by another correct route; never require the model answer's wording.
- "verdict": "correct" if every key idea is made (or an equally valid alternative is given), "partial" if some are, "incorrect" if none are or the answer contradicts the key.
- "covered": 0-based indices of the key ideas the answer makes.
- "feedback": one to three sentences addressed to the learner, kind and precise: what is right, and what is missing or wrong. Do not just restate the model answer.
- "misconception": only if the text shows a specific wrong idea, as a short noun-phrase label and a description. A missing idea is not a misconception.`,
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

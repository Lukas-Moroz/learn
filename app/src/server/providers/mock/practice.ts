// Deterministic exam-practice fixtures for the mock provider. They read the real prompt
// input (page numbers and page text), so outlines and citations pass the same validation
// as live output: an edit-distance problem (table, number, explanation) and an entropy
// problem (sequence, numbers, choice). Anything else gets a one-step placeholder.

type Page = { page: number; text: string };

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const HEADING = /^(?:problem(?:\s+set)?|question|exercise)\s+(\d+[a-z]?)\b\s*[:.)–-]?\s*(.*)$/i;

/** Problem number → title and pages, from "Problem 2: Entropy"-style headings. */
function scan(pages: Page[]): Map<string, { title: string; pages: number[] }> {
  const out = new Map<string, { title: string; pages: number[] }>();
  let current: string | null = null;
  for (const p of pages) {
    const heading = lines(p.text).map((l) => HEADING.exec(l)).find(Boolean);
    if (heading) {
      current = heading[1];
      if (!out.has(current)) out.set(current, { title: heading[2].slice(0, 80) || `Problem ${current}`, pages: [] });
    }
    if (current && !out.get(current)!.pages.includes(p.page)) out.get(current)!.pages.push(p.page);
  }
  return out;
}

export function practiceOutline(input: { problemDocument: { title?: string; pages: Page[] }; solutionDocument: { pages?: Page[]; sameAsProblemDocument?: boolean } | null }) {
  const all = input.problemDocument?.pages ?? [];
  // One document with both: solutions start at a page headed "Solutions" (or "Answers").
  const split = input.solutionDocument?.sameAsProblemDocument ? all.findIndex((p) => /^(solutions?|answers?|answer key)\b/i.test(lines(p.text)[0] ?? "")) : -1;
  const pages = split >= 0 ? all.slice(0, split) : all;
  const problems = scan(pages);
  const solutionPages = split >= 0 ? all.slice(split) : input.solutionDocument?.pages ?? [];
  const solutions = input.solutionDocument ? scan(solutionPages) : new Map<string, { title: string; pages: number[] }>();
  const list = problems.size
    ? [...problems].map(([number, p]) => ({ number, title: p.title, problemPages: p.pages.slice(0, 12), solutionPages: (solutions.get(number)?.pages ?? []).slice(0, 12) }))
    : pages.map((p, i) => ({ number: String(i + 1), title: lines(p.text)[0]?.slice(0, 80) || `Page ${p.page}`, problemPages: [p.page], solutionPages: [] }));
  return { title: lines(pages[0]?.text ?? "")[0]?.slice(0, 200) || input.problemDocument?.title || "Practice problems", problems: list };
}

interface ProblemInput {
  problem: { number: string; title: string };
  keySource: "solutions" | "generated";
  problemPages: Page[];
  solutionPages: Page[];
}

/** Cite the first solution line matching `pattern` (copied exactly, so the quote verifies). */
function citer(pages: Page[]) {
  return (pattern: RegExp) => {
    for (const p of pages) {
      const ls = lines(p.text).filter((l) => l.length >= 8);
      const line = ls.find((l) => pattern.test(l)) ?? ls[0];
      if (line) return [{ page: p.page, quote: line.slice(0, 200) }];
    }
    return [];
  };
}

export function practiceProblem(input: ProblemInput) {
  const text = (input.problemPages ?? []).map((p) => p.text).join("\n");
  const generated = input.keySource === "generated";
  const note = generated ? "AI-generated key (no official solution was provided). " : "";
  const ref = generated ? () => [] : citer(input.solutionPages ?? []);
  if (/edit distance|levenshtein/i.test(text)) return editDistance(note, ref);
  if (/entropy/i.test(text)) return entropy(note, ref);
  const title = input.problem?.title || `Problem ${input.problem?.number ?? ""}`.trim();
  return {
    title,
    intro: `*(Mock provider: placeholder problem.)*\n\n${lines(text).slice(1, 6).join("\n\n") || title}`,
    steps: [
      {
        label: "(a)",
        prompt: "Work through the problem and explain your answer.",
        key: { kind: "free", modelAnswer: `${note}*(Mock)* See the solution document.`, keyIdeas: [`the main idea of ${title}`] },
        solution: `${note}*(Mock)* See the solution document.`,
        concepts: [title],
        solutionRefs: ref(/./),
      },
    ],
    concepts: [{ name: title.slice(0, 120), definition: `The idea exercised by ${title}.` }],
    keywords: title.split(/\s+/).filter((w) => w.length > 3).slice(0, 5).concat(title).slice(0, 15),
  };
}

function editDistance(note: string, ref: (p: RegExp) => { page: number; quote: string }[]) {
  return {
    title: "Edit distance",
    intro:
      "Let $X = \\text{GCA}$ and $Y = \\text{GAC}$. An insertion, deletion or substitution costs 1; matching equal characters costs 0. $D(i, j)$ is the minimum edit cost between the first $i$ characters of $X$ and the first $j$ characters of $Y$. Rows correspond to $X$, columns to $Y$, and ε is the empty prefix.",
    steps: [
      {
        label: "(a) matrix",
        prompt: "Complete the matrix $D$, including the boundary row and column. $D(0, 0) = 0$ is filled in.",
        key: {
          kind: "table",
          rowLabels: ["ε", "G", "C", "A"],
          colLabels: ["ε", "G", "A", "C"],
          cells: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 1, 1], [3, 2, 1, 2]],
          given: [[0, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]],
        },
        solution: `${note}Initialise $D(i, 0) = i$ and $D(0, j) = j$. Each interior cell is the smallest of the cell above plus 1, the cell to the left plus 1, and the diagonal cell plus 0 (match) or 1 (substitution).`,
        hint: "The boundary row and column count the edits needed from an empty prefix.",
        concepts: ["Edit distance", "Dynamic programming"],
        solutionRefs: ref(/matrix|row/i),
      },
      {
        label: "(b) distance",
        prompt: "Report the edit distance between $X$ and $Y$.",
        key: { kind: "number", value: 2 },
        solution: `${note}The distance is the bottom-right cell, $D(3, 3) = 2$.`,
        concepts: ["Edit distance"],
        solutionRefs: ref(/distance is/i),
      },
      {
        label: "(c) recurrence",
        prompt: "Explain what the three candidates in the recurrence for $D(i, j)$ represent.",
        key: {
          kind: "free",
          modelAnswer: "$D(i-1, j) + 1$ deletes $X_i$; $D(i, j-1) + 1$ inserts $Y_j$; $D(i-1, j-1) + [X_i \\ne Y_j]$ matches or substitutes the last characters.",
          keyIdeas: ["$D(i-1, j) + 1$ deletes $X_i$", "$D(i, j-1) + 1$ inserts $Y_j$", "$D(i-1, j-1) + [X_i \\ne Y_j]$ matches or substitutes the last characters"],
        },
        solution: `${note}The three candidates delete $X_i$, insert $Y_j$, or match/substitute the two last characters.`,
        concepts: ["Edit distance", "Dynamic programming"],
        solutionRefs: ref(/candidates/i),
      },
    ],
    concepts: [
      { name: "Edit distance", definition: "The minimum number of insertions, deletions and substitutions that turn one string into another (Levenshtein distance)." },
      { name: "Dynamic programming", definition: "Solving a problem by filling a table of overlapping subproblems, each computed from smaller ones by a recurrence." },
    ],
    keywords: ["edit distance", "Levenshtein", "dynamic programming", "recurrence"],
  };
}

function entropy(note: string, ref: (p: RegExp) => { page: number; quote: string }[]) {
  return {
    title: "Entropy",
    intro:
      "A source emits $a$ and $b$ with probability $\\tfrac14$ each, and $c, d, e, f$ with probability $\\tfrac18$ each. Self-information is $I(x) = -\\log_2 p(x)$; entropy is expected self-information, $H(X) = -\\sum_x p(x) \\log_2 p(x)$.",
    steps: [
      {
        label: "(a) self-information",
        prompt: "Give the self-information, in bits, of $a, b, c, d, e, f$ in that order (separate the values with spaces or commas).",
        key: { kind: "sequence", value: ["2", "2", "3", "3", "3", "3"], ordered: true },
        solution: `${note}$I(a) = I(b) = -\\log_2 \\tfrac14 = 2$ bits; the other four are $-\\log_2 \\tfrac18 = 3$ bits.`,
        concepts: ["Self-information"],
        solutionRefs: ref(/self-information/i),
      },
      {
        label: "(b) entropy",
        prompt: "Compute the source entropy $H(X)$.",
        key: { kind: "number", value: "2.5", unit: "bits" },
        solution: `${note}$H(X) = 2 \\cdot \\tfrac14 \\cdot 2 + 4 \\cdot \\tfrac18 \\cdot 3 = 2.5$ bits.`,
        hint: "Weight each symbol's self-information by its probability.",
        concepts: ["Entropy", "Self-information"],
        solutionRefs: ref(/H\(X\)/),
      },
      {
        label: "(c) uniform entropy",
        prompt: "Compute the entropy of a uniform source on the same six symbols.",
        key: { kind: "number", value: "log2(6)", unit: "bits" },
        solution: `${note}$H = \\log_2 6 \\approx 2.585$ bits.`,
        concepts: ["Entropy"],
        solutionRefs: ref(/uniform/i),
      },
      {
        label: "(d) comparison",
        prompt: "Which source has the greater entropy?",
        key: {
          kind: "choice",
          options: [
            { value: "uniform", label: "The uniform source" },
            { value: "skewed", label: "The first source" },
            { value: "equal", label: "Both have the same entropy" },
          ],
          correct: "uniform",
        },
        solution: `${note}The uniform source, by $\\log_2 6 - 2.5 \\approx 0.085$ bits: on a fixed alphabet, the uniform distribution maximises entropy.`,
        concepts: ["Entropy"],
        solutionRefs: ref(/larger|greater/i),
      },
    ],
    concepts: [
      { name: "Self-information", definition: "The information content of an event, $-\\log_2 P(E)$ bits: the rarer the event, the more information observing it carries." },
      { name: "Entropy", definition: "The expected self-information of a random variable, $H(X) = -\\sum_x p(x) \\log_2 p(x)$: the average number of bits needed per symbol." },
    ],
    keywords: ["entropy", "self-information", "expected information", "uniform distribution"],
  };
}

const STOP = new Set(["that", "with", "from", "this", "into", "their", "they", "them", "then", "than", "each", "both", "which"]);

/** Grade by overlap with each key idea's words (5-letter stems, so "deletes" ≈ "deletion"). */
export function gradePractice(input: { keyIdeas: string[]; answer: string }) {
  const answer = String(input.answer ?? "").toLowerCase();
  const ideas = input.keyIdeas ?? [];
  const covered = ideas
    .map((idea, i) => {
      const stems = [...new Set((idea.replace(/\$[^$]*\$/g, " ").toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)))];
      const hits = stems.filter((s) => answer.includes(s)).length;
      return stems.length && hits * 2 >= stems.length ? i : -1;
    })
    .filter((i) => i >= 0);
  const misconception = /transpos|swap/.test(answer)
    ? { label: "counts a transposition as one edit", description: "Treats swapping two adjacent characters as a single operation, but this edit model allows only insertions, deletions and substitutions." }
    : undefined;
  const verdict = covered.length === ideas.length && !misconception ? "correct" : covered.length ? "partial" : "incorrect";
  const missing = ideas.filter((_, i) => !covered.includes(i));
  const feedback =
    verdict === "correct"
      ? "*(Mock)* You made every key point."
      : verdict === "partial"
        ? `*(Mock)* You covered ${covered.length} of ${ideas.length} key points. Still missing: ${missing[0]}.`
        : "*(Mock)* This doesn't yet make the key points; compare it with the model answer.";
  return { verdict, covered, feedback: feedback.slice(0, 800), ...(misconception ? { misconception } : {}) };
}

// ── Guided practice ─────────────────────────────────────────────────────────

type Excerpt = { doc: number; page: number; text: string };

/** A quote copied exactly from the first excerpt page that mentions `term` (or the first page). */
export function lectureRef(excerpts: Excerpt[] | undefined, term: string) {
  const list = excerpts ?? [];
  const page = list.find((e) => e.text.toLowerCase().includes(term.toLowerCase())) ?? list[0];
  const line = page && lines(page.text).find((l) => l.length >= 12);
  return page && line ? [{ doc: page.doc, page: page.page, quote: line.slice(0, 120) }] : [];
}

/** A definition question with options of similar length, so it passes the same shape checks as live output. */
function definitionQuestion(name: string, definition: string, n: number) {
  const def = definition.replace(/\$[^$]*\$/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    stem: `Before starting the problem: which statement describes what “${name}” means?`,
    kind: "conceptual",
    context: "original",
    scenario: `warm-up ${name} ${n}`.slice(0, 120),
    options: [
      { value: "def", label: `It is ${def}` },
      { value: "reverse", label: `It is the reverse of the usual meaning of ${name}`.slice(0, 90), misconception: `inverts the meaning of ${name}` },
      { value: "neighbour", label: `It is a neighbouring idea often confused with ${name}`.slice(0, 90), misconception: `confuses ${name} with a neighbouring idea` },
    ],
    correct: "def",
    explanation: `*(Mock)* “${name}” means: ${definition}`,
    rubric: { keyIdeas: [`the definition of ${name}`], commonFlaws: [] },
    difficulty: 1,
    refs: [],
  };
}

export function practicePrimer(input: { concepts?: { name: string; definition: string; role: string }[]; lecture?: { excerpts: Excerpt[] } | null }) {
  // Foundations first: known prerequisites, then the problem's own concepts.
  const concepts = [...(input.concepts ?? [])].sort((a, b) => (a.role === b.role ? 0 : a.role === "prerequisite" ? -1 : 1)).slice(0, 2);
  const list = concepts.length ? concepts : [{ name: "Problem decomposition", definition: "Splitting a problem into smaller subproblems whose answers combine into the whole.", role: "prerequisite" }];
  return {
    probes: list.map((c, i) => ({
      concept: c.name,
      ...(concepts.length ? {} : { definition: c.definition }),
      why: `*(Mock)* The problem builds on ${c.name}.`,
      question: definitionQuestion(c.name, c.definition, i),
      teach: `*(Mock)* **${c.name}.** ${c.definition}\n\nEverything in the problem that uses ${c.name} rests on this definition, so it is worth holding exactly.`,
      refs: lectureRef(input.lecture?.excerpts, c.name),
    })),
  };
}

const EDIT_EXAMPLE = {
  example:
    "*(Mock)* Take two one-letter strings, $X = \\text{A}$ and $Y = \\text{B}$.\n\n1. Boundary: $D(0,0) = 0$, $D(1,0) = 1$ (delete A), $D(0,1) = 1$ (insert B).\n2. Interior: $D(1,1) = \\min(D(0,1) + 1,\\ D(1,0) + 1,\\ D(0,0) + 1) = \\min(2, 2, 1) = 1$, a single substitution.\n\nEvery cell asks the same question: which of the three neighbouring smaller problems is cheapest to extend by one move?",
  check: {
    stem: "Two one-letter strings, $X = \\text{A}$ and $Y = \\text{B}$, are compared with insertions, deletions and substitutions that each cost 1. What is the smallest number of edits that turns $X$ into $Y$?",
    kind: "application",
    context: "original",
    options: [
      { value: "one", label: "One edit: a single substitution" },
      { value: "two", label: "Two edits: a deletion then an insertion", misconception: "forgets substitution as a single move" },
      { value: "zero", label: "Zero edits: both strings have length one", misconception: "compares lengths instead of characters" },
    ],
    correct: "one",
    explanation: "A single substitution turns A into B. Deleting then inserting also works but costs two, and equal length alone says nothing about the characters.",
  },
};

const INFO_EXAMPLE = {
  example:
    "*(Mock)* Take a fair coin: heads and tails each have probability one half.\n\n1. Self-information of heads: $-\\log_2 \\tfrac{1}{2} = 1$ bit.\n2. Entropy is the probability-weighted average of self-information: $\\tfrac{1}{2} \\cdot 1 + \\tfrac{1}{2} \\cdot 1 = 1$ bit.\n\nThe rarer an outcome, the more bits it carries; entropy averages them.",
  check: {
    stem: "A fair coin lands heads or tails, each with probability one half. How much self-information, in bits, does observing heads carry?",
    kind: "application",
    context: "original",
    options: [
      { value: "one", label: "One bit of self-information" },
      { value: "half", label: "Half a bit of self-information", misconception: "uses the probability itself as the information" },
      { value: "two", label: "Two bits of self-information", misconception: "counts the outcomes instead of taking the logarithm" },
    ],
    correct: "one",
    explanation: "Self-information is minus the base-2 logarithm of the probability; for one half that is one bit. The probability itself is not the information, and the number of outcomes is not either.",
  },
};

export function practiceCoach(input: {
  problem: { title: string };
  step: { label: string };
  learner: { answer: string; wrongCells?: unknown[] };
  strategy: string;
  round: number;
  concepts?: { name: string; definition: string }[];
  lecture?: { excerpts: Excerpt[] } | null;
}) {
  const concept = input.concepts?.[0] ?? { name: input.problem?.title ?? "this idea", definition: "the idea this step exercises" };
  const info = /entropy|information/i.test(`${input.problem?.title} ${concept.name}`);
  const base = info ? INFO_EXAMPLE : EDIT_EXAMPLE;
  const dk = input.learner?.answer === "I don't know";
  const diagnosis = dk
    ? `*(Mock)* It looks like the idea behind ${input.step?.label} hasn't clicked yet: ${concept.name}.`
    : input.learner?.wrongCells?.length
      ? `*(Mock)* It looks like a few cells may have been built from the wrong neighbouring cells.`
      : `*(Mock)* It looks like the answer may come from a slightly different rule than the one this step needs.`;
  return {
    strategy: input.strategy,
    diagnosis,
    summary: `*(Mock)* ${concept.name}: ${(concept.definition.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)[0] ?? "").replace(/[.!?]+$/, "").slice(0, 200)}.`,
    explanation: `*(Mock, round ${input.round}, ${input.strategy})* **${concept.name}.** ${concept.definition}\n\nStart from what is always true here, then ask what the step is really asking for before computing anything.`,
    example: base.example,
    nextHint: `*(Mock)* When you retry ${input.step?.label}, apply the same rule as in the mini-example, one piece at a time.`,
    refs: lectureRef(input.lecture?.excerpts, concept.name),
  };
}

/** The check question, written after the coaching's explanation and mini-example. */
export function practiceCoachCheck(input: { problem: { title: string }; round: number; concepts?: { name: string; definition: string }[] }) {
  const concept = input.concepts?.[0] ?? { name: input.problem?.title ?? "this idea", definition: "" };
  const info = /entropy|information/i.test(`${input.problem?.title} ${concept.name}`);
  const base = info ? INFO_EXAMPLE : EDIT_EXAMPLE;
  return { check: { ...base.check, scenario: `mini example round ${input.round}`, rubric: { keyIdeas: [concept.name], commonFlaws: [] }, multiSelect: false, difficulty: 2, refs: [] } };
}

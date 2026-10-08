// Deterministic checks that keep questions from testing recognition of wording:
//  - a new question must not be a near-copy of an earlier one on the same concept;
//  - a question must not reuse long phrases from the explanation it follows.
const STOP = new Set(
  "a an the of to in on for and or is are was were be been it its this that these those with as by at from which what when why how does do did if then than into their there they we you your our can could would should will".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$[^$]*\$/g, " math ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function shingles(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity of two questions (stem + options), 0..1, on word bigrams. */
export function questionSimilarity(a: string, b: string): number {
  return jaccard(shingles(tokens(a), 2), shingles(tokens(b), 2));
}

/** Fraction of the question's 4-word phrases that appear verbatim in the explanation. */
export function parrotingScore(question: string, explanation: string): number {
  const q = shingles(tokens(question), 4);
  if (q.size === 0) return 0;
  const e = shingles(tokens(explanation), 4);
  let hit = 0;
  for (const s of q) if (e.has(s)) hit++;
  return hit / q.size;
}

export const SIMILARITY_LIMIT = 0.5;
export const PARROTING_LIMIT = 0.3;

export interface PriorQuestion {
  text: string;
  scenario: string;
}

/** Returns the reason a candidate question is unacceptable, or null if it is fine. */
export function repetitionProblem(
  candidate: { text: string; scenario: string },
  prior: PriorQuestion[],
  recentExplanation: string | null,
): string | null {
  const scen = candidate.scenario.trim().toLowerCase();
  for (const p of prior) {
    if (p.scenario.trim().toLowerCase() === scen) return `reuses the scenario “${p.scenario}” from an earlier question`;
    const sim = questionSimilarity(candidate.text, p.text);
    if (sim >= SIMILARITY_LIMIT) return `is ${Math.round(sim * 100)}% similar to an earlier question`;
  }
  if (recentExplanation) {
    const parrot = parrotingScore(candidate.text, recentExplanation);
    if (parrot >= PARROTING_LIMIT) return `reuses ${Math.round(parrot * 100)}% of its phrasing from the explanation just shown`;
  }
  return null;
}

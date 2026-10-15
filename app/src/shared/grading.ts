// Deterministic multiple-choice grading, ported from the pi `quiz` extension
// (extensions/quiz.ts). The correct answer is keyed by option *value*, never by
// position, so shuffling for display can never desynchronise grading.
import type { QuestionOption } from "./schemas.ts";

export interface GradeResult {
  /** null for "I don't know": a distinct outcome, neither right nor wrong. */
  correct: boolean | null;
  correctValues: string[];
  /** Misconceptions attached to the distractors the learner picked. */
  misconceptions: string[];
}

/** Trim labels/values, default value to label, reject duplicate values. */
export function normalizeOptions(options: { label: string; value?: string; misconception?: string }[]): QuestionOption[] {
  const seen = new Set<string>();
  return options
    .map((o) => ({
      label: o.label.trim(),
      value: (o.value ?? o.label).trim(),
      ...(o.misconception?.trim() ? { misconception: o.misconception.trim() } : {}),
    }))
    .filter((o) => {
      if (!o.label) return false;
      if (seen.has(o.value)) throw new Error(`duplicate option value "${o.value}"`);
      seen.add(o.value);
      return true;
    });
}

/**
 * Models sometimes deliver a multi-select answer as a JSON-stringified array
 * ('["a","b"]'). Parse that back; wrap a plain single value.
 */
export function coerceCorrectAnswer(correct: string | string[]): string[] {
  if (Array.isArray(correct)) return correct.map(String);
  const trimmed = correct.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // not JSON — treat as a literal value
    }
  }
  return [trimmed];
}

/** Resolve correct values against the options; a value matching no option is a hard error. */
export function resolveCorrect(correct: string | string[], options: QuestionOption[]): string[] {
  const values = coerceCorrectAnswer(correct).map((v) => v.trim());
  if (values.length === 0) throw new Error("correct answer is required");
  const known = new Set(options.map((o) => o.value));
  for (const v of values) {
    if (!known.has(v)) {
      throw new Error(`correct answer "${v}" does not match any option value (${[...known].map((k) => `"${k}"`).join(", ")})`);
    }
  }
  return [...new Set(values)];
}

/** Multi-select is an exact-set match, as in the original quiz tool. */
export function isCorrectSelection(selected: string[], correctValues: string[]): boolean {
  const a = new Set(selected);
  const b = new Set(correctValues);
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function grade(
  options: QuestionOption[],
  correctValues: string[],
  attempt: { selected: string[]; dontKnow: boolean },
): GradeResult {
  if (attempt.dontKnow) return { correct: null, correctValues, misconceptions: [] };
  const known = new Set(options.map((o) => o.value));
  for (const v of attempt.selected) if (!known.has(v)) throw new Error(`unknown option "${v}"`);
  const correct = isCorrectSelection(attempt.selected, correctValues);
  const misconceptions = correct
    ? []
    : options
        .filter((o) => attempt.selected.includes(o.value) && !correctValues.includes(o.value) && o.misconception)
        .map((o) => o.misconception!);
  return { correct, correctValues, misconceptions };
}

/** Fisher–Yates over a copy. `random` is injectable so tests are deterministic. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Deterministic PRNG (mulberry32) seeded from a string, for stable per-question shuffles. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Option-shape audit from the teach skill's construction procedure: the correct
 * option must not stand out by length. Returns a reason when it does.
 */
export function optionShapeProblem(options: QuestionOption[], correctValues: string[]): string | null {
  const lengths = options.map((o) => o.label.length);
  const correctLens = options.filter((o) => correctValues.includes(o.value)).map((o) => o.label.length);
  const others = options.filter((o) => !correctValues.includes(o.value)).map((o) => o.label.length);
  if (others.length === 0) return null;
  const maxOther = Math.max(...others);
  const minLen = Math.min(...lengths);
  for (const len of correctLens) {
    if (len > maxOther * 1.6 && len - maxOther > 25) return "correct option is much longer than every distractor";
  }
  if (minLen === 0) return "empty option";
  return null;
}

// Generated explanations tend to cite options by their value ("Option B reverses…"), but the
// learner only sees the shuffled, numbered display order, so such a reference can appear to
// contradict the visible choices.
const VALUE_REF = /\b([Oo]ptions?|[Cc]hoices?|[Aa]nswers?|[Dd]istractors?)\s+\(?([A-H]|[1-9])\)?(?![\w'’])|(?<![\w\\{}$])\(([A-H])\)/g;
const POSITION_REF = /\b(first|second|third|fourth|fifth|last|top|bottom)\s+(option|choice|answer|distractor)\b/i;

/** Rewrite references to option values as the choice number the learner sees (options in display order). */
export function visibleOptionRefs(text: string, displayOrder: QuestionOption[]): string {
  const number = new Map(displayOrder.map((o, i) => [o.value, i + 1]));
  return text.replace(VALUE_REF, (m, word: string | undefined, id: string | undefined, bare: string | undefined) => {
    const n = number.get((id ?? bare)!);
    if (!n) return m;
    return word ? `${word.replace(/s$/, "")} ${n}` : `(choice ${n})`;
  });
}

/** A reference the learner can't resolve after shuffling: a position, or a letter/number that is no option's value. */
export function hiddenOptionReference(text: string, options: QuestionOption[]): string | null {
  const position = POSITION_REF.exec(text);
  if (position) return `refers to "${position[0]}", but options are shuffled for display; refer to the option's text instead`;
  const values = new Set(options.map((o) => o.value));
  for (const m of text.matchAll(VALUE_REF)) {
    if (!values.has((m[2] ?? m[3])!)) return `refers to "${m[0].trim()}", which is not an option value; refer to the option's text instead`;
  }
  return null;
}

// Does generated coaching give a practice step's answer away? A deterministic check run on
// every "practice_coach" output (a hit asks the model for a corrected version). Deliberately
// conservative, so ordinary teaching text passes: only number, sequence and table keys are
// checked; tiny integers (0–2) are ignored; so is any value the problem's own intro already
// shows; sequences and table rows/columns count only as a whole run of at least three values.
import { normalizeOptions, resolveCorrect } from "./grading.ts";
import { cellAlternatives, parseNumber } from "./practice-grading.ts";
import type { AnswerKey } from "./practice.ts";

type Cell = string | number;

const tiny = (n: number) => Number.isInteger(n) && n >= 0 && n <= 2;

/** LaTeX and Unicode spellings → plain forms: \frac{3}{64} → 3/64, \log_2 6 → log2(6), − → -. */
function plain(text: string): string {
  return text
    .replace(/[−–—]/g, "-")
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\?log\s*_\s*\{?\s*(\d+)\s*\}?\s*\(?\s*([\d.]+)\s*\)?/g, "log$1($2)")
    .replace(/\\left|\\right|\\,|\\;|\\!/g, "")
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
}

/** Standalone decimal numbers in a text, with how many decimals each was written with. */
function numbersIn(text: string): { n: number; decimals: number }[] {
  const out: { n: number; decimals: number }[] = [];
  for (const m of plain(text).matchAll(/(?<![\p{L}\p{N}_.])-?\d+(?:\.\d+)?(?![\p{N}_]|\.\d)/gu)) {
    out.push({ n: Number(m[0]), decimals: m[0].split(".")[1]?.length ?? 0 });
  }
  return out;
}

const squash = (s: string) => plain(s).toLowerCase().replace(/\s+/g, "");

/** Is a number key's value written in the text: exactly, as its own expression ("log2(6)"), or rounded to 2+ decimals? */
function mentionsNumber(text: string, value: Cell): boolean {
  const raw = String(value).trim();
  const v = parseNumber(raw);
  if (!/^-?\d+(?:\.\d+)?$/.test(raw) && raw.length >= 3 && squash(text).includes(squash(raw))) return true;
  if (v === null || !Number.isFinite(v)) return false;
  return numbersIn(text).some(({ n, decimals }) => n === v || (decimals >= 2 && Math.abs(Number(v.toFixed(decimals)) - n) < 1e-9));
}

/** Tokens of a text for run matching: numbers and words, separators dropped. */
function tokensOf(text: string): string[] {
  return plain(text)
    .toLowerCase()
    .split(/[\s,;:()[\]{}⟨⟩$&|\\]+|(?<=\d)\.(?!\d)/)
    .map((t) => t.replace(/^[.'"`*_]+|[.'"`*_]+$/g, ""))
    .filter(Boolean);
}

const same = (a: string, b: string) => {
  if (a === b) return true;
  const x = parseNumber(a);
  const y = parseNumber(b);
  return x !== null && y !== null && /^[-\d./]+$/.test(a) && /^[-\d./]+$/.test(b) && Math.abs(x - y) < 1e-9;
};

/** Does the text contain the run as consecutive tokens (in any order when `ordered` is false)? */
function containsRun(text: string, run: string[], ordered = true): boolean {
  const toks = tokensOf(text);
  const want = run.map((r) => String(r).trim().toLowerCase());
  for (let i = 0; i + want.length <= toks.length; i++) {
    const win = toks.slice(i, i + want.length);
    if (ordered) {
      if (win.every((t, j) => same(t, want[j]))) return true;
    } else {
      const left = [...want];
      if (win.every((t) => {
        const k = left.findIndex((w) => same(t, w));
        return k >= 0 && left.splice(k, 1).length === 1;
      })) return true;
    }
  }
  return false;
}

/** A run worth protecting: three or more values, not all tiny integers, and not a plain count 0 1 2 3 … (a DP boundary). */
function distinctive(run: string[]): boolean {
  if (run.length < 3) return false;
  const nums = run.map((r) => parseNumber(r));
  if (nums.every((n) => n !== null && tiny(n))) return false;
  if (nums.every((n) => n !== null && Number.isInteger(n))) {
    const step = nums[1]! - nums[0]!;
    if (Math.abs(step) === 1 && nums.every((n, i) => i === 0 || n! - nums[i - 1]! === step)) return false;
  }
  return true;
}

/** The first alternative of a cell (" | " separates accepted forms). */
const cellText = (c: Cell) => String(cellAlternatives(c)[0] ?? c).trim();

/**
 * The key's values that the text gives away, as display strings (empty when none). `intro` is the
 * problem's own setup: a value it already shows is not a leak.
 */
export function leakedKeyValues(key: AnswerKey, text: string, intro: string): string[] {
  const hits: string[] = [];
  if (key.kind === "number") {
    for (const value of [key.value, ...key.alternatives]) {
      const v = parseNumber(String(value));
      if (v !== null && tiny(v) && /^-?\d+(?:\.0+)?$/.test(String(value).trim())) continue;
      if (mentionsNumber(intro, value)) continue;
      if (mentionsNumber(text, value)) hits.push(String(value));
    }
  } else if (key.kind === "sequence") {
    for (const seq of [key.value, ...key.alternatives]) {
      const run = seq.map((c) => String(c).trim());
      if (!distinctive(run) || containsRun(intro, run, key.ordered)) continue;
      if (containsRun(text, run, key.ordered)) hits.push(run.join(" "));
    }
  } else if (key.kind === "table") {
    const runs: string[][] = [];
    const graded = (r: number, c: number) => key.cells[r]?.[c] != null && key.given?.[r]?.[c] == null;
    key.cells.forEach((row, r) => {
      const run = row.flatMap((c, j) => (graded(r, j) ? [cellText(c!)] : []));
      runs.push(run);
    });
    const cols = Math.max(0, ...key.cells.map((r) => r.length));
    for (let j = 0; j < cols; j++) runs.push(key.cells.flatMap((row, r) => (graded(r, j) ? [cellText(row[j]!)] : [])));
    for (const run of runs) {
      if (!distinctive(run) || containsRun(intro, run)) continue;
      if (containsRun(text, run)) hits.push(run.join(" "));
    }
  }
  return [...new Set(hits)];
}

/** Values the coach must not write, for its prompt (it is told; the check enforces it). */
export function forbiddenValues(key: AnswerKey): string[] {
  if (key.kind === "number") return [key.value, ...key.alternatives].map(String);
  if (key.kind === "sequence") return [key.value, ...key.alternatives].map((s) => s.map(String).join(" "));
  if (key.kind === "table") return key.cells.map((row) => row.map((c) => (c == null ? "—" : cellText(c))).join(" "));
  return [];
}

/** Text compared for verbatim mentions: lower case, Markdown emphasis and code marks dropped, whitespace collapsed. */
function flat(text: string): string {
  return plain(text)
    .toLowerCase()
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the text name `phrase` verbatim (as a whole phrase, not inside a longer word)? */
export function namesVerbatim(text: string, phrase: string): boolean {
  const p = flat(phrase).replace(/[.!?;:,]+$/, "");
  if (p.length < 3) return false;
  const t = flat(text);
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(t);
}

/**
 * Follow-up answers before a step is completed: everything `leakedKeyValues` checks, plus a
 * choice step's correct option and a short-answer step's accepted answers written out verbatim
 * (unless the problem's own text already shows them). Free-text steps have no checkable value.
 */
export function followUpLeaks(key: AnswerKey, text: string, intro: string): string[] {
  const hits = leakedKeyValues(key, text, intro);
  if (key.kind === "choice") {
    const options = normalizeOptions(key.options);
    let correct: Set<string>;
    try {
      correct = new Set(resolveCorrect(key.correct, options));
    } catch {
      correct = new Set();
    }
    for (const o of options) if (correct.has(o.value) && !namesVerbatim(intro, o.label) && namesVerbatim(text, o.label)) hits.push(o.label);
  } else if (key.kind === "text") {
    for (const a of key.accepted) if (a.trim().length >= 4 && !namesVerbatim(intro, a) && namesVerbatim(text, a)) hits.push(a);
  }
  return [...new Set(hits)];
}

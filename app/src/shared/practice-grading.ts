// Deterministic grading for exam-practice steps, plus display helpers. Pure (no I/O),
// so the client can reuse it. Numbers go through a small recursive-descent parser:
// nothing a learner types is ever evaluated as code.
import { grade as gradeSelection, normalizeOptions, resolveCorrect } from "./grading.ts";
import type { AnswerKey } from "./practice.ts";

type Cell = string | number;

export interface StepGrade {
  correct: boolean;
  /** 0..1: tables score the fraction of graded cells, sequences the fraction of matching entries. */
  score: number;
  cellResults?: (boolean | null)[][];
  feedback: string;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const FUNCTIONS: Record<string, (x: number) => number> = {
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  log: Math.log,
  exp: Math.exp,
  ln: Math.log,
  lg: Math.log2,
};
// Longest names first, so "log10" is not read as "log" followed by 10.
const NAMES = [...Object.keys(FUNCTIONS), "pi", "π"].sort((a, b) => b.length - a.length);

/** Unicode operators and log-base spellings → the parser's ASCII forms. */
function normalizeExpression(s: string): string {
  return s
    .replace(/[−–—‒﹣－]/g, "-")
    .replace(/[×·⋅∙✕]/g, "*")
    .replace(/[÷⁄∕]/g, "/")
    .replace(/log\s*(?:_\s*\{?\s*10\s*\}?|₁₀)/gi, "log10")
    .replace(/log\s*(?:_\s*\{?\s*2\s*\}?|₂)/gi, "log2")
    .replace(/√/g, "sqrt")
    .trim();
}

type Token =
  | { kind: "num"; value: number }
  | { kind: "fn"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" | "^" }
  | { kind: "(" }
  | { kind: ")" };

function tokenize(src: string): Token[] | null {
  const s = src.toLowerCase();
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ kind: "num", value: Number(num[0]) });
      i += num[0].length;
    } else if (s.startsWith("**", i)) {
      out.push({ kind: "op", op: "^" });
      i += 2;
    } else if ("+-*/^".includes(ch)) {
      out.push({ kind: "op", op: ch as "+" | "-" | "*" | "/" | "^" });
      i++;
    } else if (ch === "(" || ch === ")") {
      out.push({ kind: ch });
      i++;
    } else {
      const name = NAMES.find((n) => s.startsWith(n, i));
      if (!name) return null;
      out.push(name === "pi" || name === "π" ? { kind: "num", value: Math.PI } : { kind: "fn", name });
      i += name.length;
    }
  }
  return out;
}

/**
 * Evaluate a number as a student would write it: 0.25, -3, 1.5e-3, 7/64, 2^-3, 2**-3,
 * (1/2)(7/8), log2(6), log2 6, ln(2), sqrt(2), with × ÷ and Unicode minus. Returns null
 * for anything else (including division by zero).
 */
export function parseNumber(input: string): number | null {
  const tokens = tokenize(normalizeExpression(String(input)));
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => {
    const t = peek();
    return t?.kind === "op" && t.op === op;
  };
  const fail = (): never => {
    throw new Error("parse");
  };
  /** Every intermediate must be a finite number: no x/0, log of ≤0, sqrt of a negative, or overflow. */
  const finite = (v: number): number => (Number.isFinite(v) ? v : fail());

  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { op: string }).op;
      const r = term();
      v = finite(op === "+" ? v + r : v - r);
    }
    return v;
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = (tokens[pos++] as { op: string }).op;
        const r = unary();
        if (op === "/" && r === 0) fail();
        v = finite(op === "*" ? v * r : v / r);
      } else if (peek()?.kind === "(" || peek()?.kind === "fn") {
        v = finite(v * unary()); // implicit product: (1/2)(7/8), 2log2(3)
      } else return v;
    }
  };
  const unary = (): number => {
    if (isOp("-")) return pos++, -unary();
    if (isOp("+")) return pos++, unary();
    return power();
  };
  const power = (): number => {
    const base = primary();
    if (isOp("^")) {
      pos++;
      const exp = unary(); // right-associative; allows 2^-3
      if (base === 0 && exp <= 0) fail(); // 0^0 and 0^-n are undefined
      return finite(base ** exp);
    }
    return base;
  };
  const primary = (): number => {
    const t = tokens[pos++];
    if (!t) return fail();
    if (t.kind === "num") return finite(t.value);
    if (t.kind === "(") {
      const v = expr();
      if (peek()?.kind !== ")") fail();
      pos++;
      return v;
    }
    if (t.kind === "fn") {
      // log2(6)^2 squares the logarithm; log2 6 applies the function to the next operand.
      const arg = peek()?.kind === "(" ? primary() : power();
      if (t.name !== "exp" && (arg < 0 || (arg === 0 && t.name !== "sqrt"))) fail(); // log of ≤0, sqrt of a negative
      return finite(FUNCTIONS[t.name](arg));
    }
    return fail();
  };

  try {
    const v = expr();
    if (pos !== tokens.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** Precision of a plain decimal literal ("0.016", "-4.193", "1.6e-2"); null for fractions and expressions. */
export function decimalPrecision(input: string): { ulp: number; sig: number; decimals: number } | null {
  const m = /^[-+]?(\d*)(?:\.(\d*))?(?:e([-+]?\d+))?$/i.exec(normalizeExpression(String(input)).replace(/\s+/g, ""));
  if (!m) return null;
  const intPart = m[1] ?? "";
  const frac = m[2] ?? "";
  if (!(intPart + frac).length) return null;
  const decimals = frac.length - Number(m[3] ?? 0);
  return { ulp: 10 ** -decimals, sig: (intPart + frac).replace(/^0+/, "").length, decimals };
}

export type NumberVerdict = "exact" | "rounded" | "too_coarse" | "wrong" | "unreadable";

/**
 * Compare a typed number with a key value. Without a tolerance, it is right when it equals
 * the key, or when it is a decimal with at least two decimals and two significant digits
 * that agrees with the key rounded to the precision typed (key 1/64: 0.0156 and 0.016, not
 * 0.02). A key that is itself a decimal with three or more decimals is treated as rounded.
 */
export function compareNumber(input: string, key: Cell, tolerance?: number): NumberVerdict {
  const k = parseNumber(String(key));
  const x = parseNumber(input);
  if (x === null) return "unreadable";
  if (k === null) return "wrong";
  const diff = Math.abs(x - k);
  // Float noise only, relative to the operands: an absolute floor would let 0 match a key of 1e-10.
  const eps = 1e-9 * Math.max(Math.abs(x), Math.abs(k));
  if (tolerance !== undefined) return diff <= tolerance + eps ? "exact" : "wrong";
  // Without an explicit tolerance, 0 never stands for a nonzero key (nor the reverse).
  if ((x === 0) !== (k === 0)) {
    const typed = decimalPrecision(input);
    return typed && diff <= typed.ulp / 2 ? "too_coarse" : "wrong";
  }
  const keyPrecision = /e/i.test(String(key)) ? null : decimalPrecision(String(key));
  const keyHalf = keyPrecision && keyPrecision.decimals >= 3 ? keyPrecision.ulp / 2 : 0;
  if (diff <= keyHalf + eps) return "exact";
  const typed = decimalPrecision(input);
  if (typed && diff <= typed.ulp / 2 + keyHalf + eps) return typed.decimals >= 2 && typed.sig >= 2 ? "rounded" : "too_coarse";
  return "wrong";
}

const numberOk = (v: NumberVerdict) => v === "exact" || v === "rounded";

/** Information units a number may carry without the key naming them ("2.5 bits per symbol"). */
const INFO_UNIT = /\s*(?:bits?\s*(?:per\s+symbol|\/\s*symbol)|bits?|nats?)\s*$/i;

/** Remove "≈", "=" and a trailing unit ("2.5 bits") before parsing. */
function stripDecoration(input: string, unit?: string): string {
  let s = input.trim().replace(/^[≈~=]+\s*/, "");
  if (/\d/.test(s)) s = s.replace(INFO_UNIT, "") || s;
  if (unit) {
    const u = unit.trim().toLowerCase();
    for (const form of [u, u.replace(/s$/, ""), `${u}s`]) {
      if (form && s.toLowerCase().endsWith(form)) {
        s = s.slice(0, s.length - form.length).trim();
        break;
      }
    }
  }
  return s;
}

function gradeNumber(key: Extract<AnswerKey, { kind: "number" }>, input: string): StepGrade {
  const typed = stripDecoration(input, key.unit);
  const verdicts = [key.value, ...key.alternatives].map((v) => compareNumber(typed, v, key.tolerance));
  if (verdicts.some(numberOk)) return { correct: true, score: 1, feedback: "" };
  if (verdicts.includes("unreadable")) {
    return { correct: false, score: 0, feedback: "That isn't a number the checker can read. Use digits, a fraction such as 3/64, a power such as 2^-5, or log2(…)." };
  }
  if (verdicts.includes("too_coarse")) {
    return { correct: false, score: 0, feedback: "Close, but too rounded to check: give at least two decimal places and two significant digits, or an exact form." };
  }
  return { correct: false, score: 0, feedback: "" };
}

// ── Text and tokens ─────────────────────────────────────────────────────────

const ARROWS: Record<string, string> = { "↖": "diag", diagonal: "diag", "↑": "up", "←": "left" };

/** Case-, whitespace- and punctuation-insensitive form ("-" is kept: it is the gap character). */
export function canonicalText(s: string, caseSensitive = false): string {
  let t = String(s).normalize("NFKC").replace(/[−–—‒﹣－]/g, "-").replace(/∞/g, "inf").replace(/infinity/gi, "inf");
  if (!caseSensitive) t = t.toLowerCase();
  // Products: "T·K^2", "T*K^2", "T×K^2", "T K^2" and "TK^2" read the same. Arrows have one spelling.
  t = t.replace(/[→⟶]/g, "->").replace(/[·⋅∙×✕*]/g, "").replace(/\s+/g, "");
  t = sortBigOTerms(t);
  t = t.replace(/[.,;:!?'"`’‘“”()[\]{}]/g, "");
  return ARROWS[t] ?? t;
}

/**
 * O(k+mlogn) and O(mlogn+k) read the same: when the whole (whitespace-free) answer is one
 * O/Θ/Ω(...) call, its top-level "+" terms are sorted. Anything else is left alone.
 */
function sortBigOTerms(t: string): string {
  const m = /^([oθωΘΩO])\(/.exec(t);
  if (!m || closingIndex(t, 1) !== t.length - 1) return t;
  const inner = t.slice(2, -1);
  const terms: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    if (depth === 0 && ch === "+") {
      terms.push(cur);
      cur = "";
    } else cur += ch;
  }
  terms.push(cur);
  if (terms.length < 2 || terms.some((x) => x === "")) return t;
  return `${m[1]}(${terms.sort().join("+")})`;
}

/** A comparison symbol at the start of a key ("= P", "< P") is part of the answer, not decoration. */
const COMPARISON = /^\s*(?:[=<>≤≥≠≈~]|<=|>=|!=)/;

/** Learner text against a text key: leading "="/"≈" is dropped unless the key itself starts with a comparison. */
function textMatches(typed: string, expected: string): boolean {
  const a = canonicalText(COMPARISON.test(expected) ? typed : stripDecoration(typed));
  return a !== "" && a === canonicalText(expected);
}

/** One value against one expected form: by value when both are numbers, otherwise as text. */
function valueMatches(input: string, expected: Cell): boolean {
  // A numeric key needs a numeric answer: "1.2.3" must not match 123 as stripped text.
  if (isNumericKey(expected)) return numberOk(compareNumber(stripDecoration(String(input)), expected));
  return textMatches(String(input).trim(), String(expected));
}

/** A key value that is a number (or a string that reads as one) is graded by value only. */
function isNumericKey(expected: Cell): boolean {
  return typeof expected === "number" || parseNumber(String(expected)) !== null;
}

const OPEN = "([{⟨";
const CLOSE = ")]}⟩";

/** Index of the bracket closing the one at `start`, or -1. */
function closingIndex(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (OPEN.includes(s[i])) depth++;
    else if (CLOSE.includes(s[i]) && --depth === 0) return i;
  }
  return -1;
}

/** Entries of one list at the top level only: "(1,2), (3,4)" → ["(1,2)", "(3,4)"]; "log2(6) 3" → ["log2(6)", "3"]. */
function topLevelEntries(src: string, mode: "auto" | "separators" | "all" = "auto", keepArrows = false): string[] {
  const norm = normalizeExpression(src);
  const s = keepArrows ? norm.replace(/[ \t]*(->|=>|[→⟶])[ \t]*/g, "$1") : norm.replace(/->|=>|[→⟶]/g, ",");
  // With a comma/semicolon at the top level, whitespace stays inside entries ("1/2 + 1/4, 3").
  let d = 0;
  let hasSep = false;
  for (const ch of s) {
    if (OPEN.includes(ch)) d++;
    else if (CLOSE.includes(ch)) d = Math.max(0, d - 1);
    else if (d === 0 && /[,;]/.test(ch)) hasSep = true;
  }
  const sep = mode === "separators" || (mode === "auto" && hasSep) ? /[,;]/ : /[\s,;]/;
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of s) {
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The list without one bracket pair around all of it ("[1, 2, 3]" → "1, 2, 3"), or null. */
function unwrapList(src: string): string | null {
  const s = normalizeExpression(src);
  return s.length >= 2 && OPEN.includes(s[0]) && closingIndex(s, 0) === s.length - 1 ? s.slice(1, -1) : null;
}

/**
 * Split a sequence the way learners write it: commas, spaces, semicolons or arrows outside
 * brackets, after removing one bracket pair around the whole list. A key array keeps each
 * entry as a unit ("(1,2)", "log2(6)").
 */
export function sequenceTokens(input: string | Cell[]): string[] {
  // Each key-array element is exactly one entry; only strings are tokenized.
  if (Array.isArray(input)) return input.map((v) => String(v).trim()).filter(Boolean);
  return topLevelEntries(unwrapList(input) ?? input);
}

/** Learner readings of a list: with the outer bracket pair removed and, when there is one, as written. */
function typedReadings(input: string, keepArrows = false): string[][] {
  const inner = unwrapList(input);
  const body = inner ?? input;
  const split = (src: string, mode: "auto" | "separators" | "all" = "auto") => topLevelEntries(src, mode, keepArrows);
  const readings = [split(body)];
  // Mixed separators ("1, 2 3"): split on commas/semicolons, then split each piece on whitespace
  // unless it reads as one numeric expression ("1/2 + 1/4"). Also the pure whitespace reading.
  readings.push(split(body, "separators").flatMap((p) => (parseNumber(p) !== null ? [p] : split(p, "all"))));
  readings.push(split(body, "all"));
  // With arrows kept, whole lines are entries too ("(3,3)->(2,2)" one per line).
  if (keepArrows) readings.push(body.split(/\n+/).map((x) => x.trim()).filter(Boolean));
  if (inner !== null) readings.push(split(input));
  // The whole answer as one entry ("1/2 + 1/4" or "log2 6" against a one-entry key).
  const whole = (inner ?? input).trim();
  if (whole && parseNumber(whole) !== null) readings.push([whole]);
  return readings;
}

/** One entry against one key entry: by value when both are numbers, as tuples when both are bracketed, else as text. */
function entryMatches(typed: string, expected: string): boolean {
  const a = stripDecoration(typed);
  const b = String(expected).trim();
  if (isNumericKey(b)) return numberOk(compareNumber(a, b));
  const ia = unwrapList(a);
  const ib = unwrapList(b);
  if (ia !== null && ib !== null) {
    const ea = topLevelEntries(ia);
    const eb = topLevelEntries(ib);
    return ea.length === eb.length && ea.length > 0 && ea.every((x, i) => entryMatches(x, eb[i]));
  }
  if (ia !== null || ib !== null) return false; // a tuple never equals a bare value
  return textMatches(typed, b);
}

/** "FBBB" against F,B,B,B (or the reverse): split a lone word into characters. */
function alignGranularity(a: string[], b: string[]): [string[], string[]] {
  const single = (xs: string[]) => xs.length > 1 && xs.every((x) => x.length === 1 && !/\d/.test(x));
  if (a.length === 1 && single(b) && a[0].length === b.length) return [[...a[0]], b];
  if (b.length === 1 && single(a) && b[0].length === a.length) return [a, [...b[0]]];
  return [a, b];
}

interface SequenceMatch {
  matched: number;
  total: number;
  typedLength: number;
  expectedLength: number;
}

function compareSequence(typed: string[], expected: string[], ordered: boolean): SequenceMatch {
  const [a, b] = alignGranularity(typed, expected);
  const lengths = { total: Math.max(a.length, b.length), typedLength: a.length, expectedLength: b.length };
  let matched = 0;
  if (ordered) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (entryMatches(a[i], b[i])) matched++;
    return { matched, ...lengths };
  }
  // Unordered: each key entry can be used once (maximum bipartite matching).
  const owner: (number | null)[] = b.map(() => null);
  const assign = (i: number, seen: Set<number>): boolean => {
    for (let j = 0; j < b.length; j++) {
      if (seen.has(j) || !entryMatches(a[i], b[j])) continue;
      seen.add(j);
      if (owner[j] === null || assign(owner[j]!, seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < a.length; i++) if (assign(i, new Set())) matched++;
  return { matched, ...lengths };
}

function gradeSequence(key: Extract<AnswerKey, { kind: "sequence" }>, input: string): StepGrade {
  const readings = typedReadings(input);
  const arrowReadings = typedReadings(input, true);
  const results = [key.value, ...key.alternatives].flatMap((expected) => {
    const exp = sequenceTokens(expected);
    // A key entry containing an arrow ("(3,3)->(2,2)") is one entry: don't split the answer on arrows.
    const hasArrow = exp.some((e) => /->|=>|[→⟶]/.test(e));
    const r = (hasArrow ? arrowReadings : readings).map((typed) => compareSequence(typed, exp, key.ordered));
    // Only readings whose length fits the key can accept (so an ambiguous split never pads or
    // drops entries); a fully matching one wins, else the first fitting one reports.
    const fit = r.filter((x) => x.typedLength === x.expectedLength);
    return [fit.find((x) => x.total > 0 && x.matched === x.total) ?? fit[0] ?? r[0]];
  });
  if (results.some((r) => r.total > 0 && r.matched === r.total)) return { correct: true, score: 1, feedback: "" };
  const ratio = (r: SequenceMatch) => (r.total ? r.matched / r.total : 0);
  const best = results.reduce((a, b) => (ratio(b) > ratio(a) ? b : a));
  const main = results[0];
  const exp0 = sequenceTokens(key.value);
  const unreadable = exp0.length > 0 && exp0.every(isNumericKey) && readings[0].some((t) => parseNumber(stripDecoration(t)) === null);
  if (unreadable) return { correct: false, score: ratio(best), feedback: "Couldn't read this number: every entry must be a number, such as 3, 1/4, 2^-5 or log2(6)." };
  const feedback =
    main.typedLength !== main.expectedLength
      ? `Expected ${main.expectedLength} entries; you gave ${main.typedLength}.`
      : best.matched > 0
        ? `${best.matched} of ${best.total} entries match.`
        : "";
  return { correct: false, score: ratio(best), feedback };
}

function gradeText(key: Extract<AnswerKey, { kind: "text" }>, input: string): StepGrade {
  const typed = canonicalText(input, key.caseSensitive);
  const correct = typed !== "" && key.accepted.some((a) => canonicalText(a, key.caseSensitive) === typed);
  return { correct, score: correct ? 1 : 0, feedback: "" };
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** Accepted forms of one key cell: "U | L" accepts either. */
export function cellAlternatives(cell: Cell): Cell[] {
  return typeof cell === "string" ? cell.split(/\s+\|\s+/).map((s) => s.trim()).filter(Boolean) : [cell];
}

function gradeTable(key: Extract<AnswerKey, { kind: "table" }>, rows: string[][]): StepGrade {
  const cellResults: (boolean | null)[][] = [];
  let graded = 0;
  let right = 0;
  let unreadable = 0;
  key.rowLabels.forEach((_, r) => {
    const row: (boolean | null)[] = [];
    key.colLabels.forEach((_, c) => {
      const expected = key.cells[r]?.[c] ?? null;
      const given = key.given?.[r]?.[c] ?? null;
      if (expected === null || given !== null) return row.push(null);
      const typed = String(rows[r]?.[c] ?? "").trim();
      const ok = typed !== "" && cellAlternatives(expected).some((alt) => valueMatches(typed, alt));
      graded++;
      if (ok) right++;
      else if (typed && cellAlternatives(expected).every(isNumericKey) && parseNumber(stripDecoration(typed)) === null) unreadable++;
      row.push(ok);
    });
    cellResults.push(row);
  });
  const score = graded ? right / graded : 1;
  return { correct: right === graded, score, cellResults, feedback: right === graded ? "" : `${right} of ${graded} cells are correct.${unreadable ? ` Couldn't read ${unreadable === 1 ? "one cell" : `${unreadable} cells`} as a number.` : ""}` };
}

// ── Choice ──────────────────────────────────────────────────────────────────

function choiceOptions(key: Extract<AnswerKey, { kind: "choice" }>) {
  const options = normalizeOptions(key.options);
  return { options, correct: resolveCorrect(key.correct, options) };
}

function gradeChoice(key: Extract<AnswerKey, { kind: "choice" }>, selected: string[]): StepGrade {
  const { options, correct } = choiceOptions(key);
  const g = gradeSelection(options, correct, { selected, dontKnow: false });
  return { correct: g.correct === true, score: g.correct ? 1 : 0, feedback: "" };
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Grade a learner's value against a key. Returns null for "free" steps (graded by the AI).
 * Throws on a value of the wrong shape or an unknown choice option.
 */
export function gradeStep(key: AnswerKey, value: string | string[] | string[][]): StepGrade | null {
  const asText = () => {
    if (typeof value !== "string") throw new Error("This step expects a single text answer.");
    return value;
  };
  switch (key.kind) {
    case "number":
      return gradeNumber(key, asText());
    case "text":
      return gradeText(key, asText());
    case "sequence":
      return gradeSequence(key, asText());
    case "table":
      if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error("A table answer is a list of rows of cells.");
      return gradeTable(key, value as string[][]);
    case "choice":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error("A choice answer is a list of selected option values.");
      return gradeChoice(key, value as string[]);
    case "free":
      asText();
      return null;
  }
}

/** Why a key can't be graded deterministically, or null. Used to reject (and repair) AI output. */
export function answerKeyProblem(key: AnswerKey): string | null {
  switch (key.kind) {
    case "number": {
      for (const v of [key.value, ...key.alternatives]) {
        if (parseNumber(String(v)) === null) return `number value "${v}" is not a parsable number (use digits, fractions, ^, log2(), ln(), sqrt(); units go in "unit")`;
      }
      return null;
    }
    case "sequence": {
      if (sequenceTokens(key.value).length === 0) return "sequence value has no entries";
      if (key.alternatives.some((a) => sequenceTokens(a).length === 0)) return "a sequence alternative has no entries";
      return null;
    }
    case "table": {
      const shape = (rows: unknown[][], what: string) => {
        if (rows.length !== key.rowLabels.length) return `table ${what} has ${rows.length} rows but there are ${key.rowLabels.length} row labels (${key.rowLabels.join(", ")})`;
        const bad = rows.findIndex((r) => r.length !== key.colLabels.length);
        if (bad >= 0) return `table ${what} row ${bad} ("${key.rowLabels[bad]}") has ${rows[bad].length} cells but there are ${key.colLabels.length} column labels (${key.colLabels.join(", ")})`;
        return null;
      };
      const problem = shape(key.cells, "cells") ?? (key.given ? shape(key.given, "given") : null);
      if (problem) return problem;
      const gradable = key.cells.some((row, r) => row.some((cell, c) => cell !== null && (key.given?.[r]?.[c] ?? null) === null));
      return gradable ? null : "table has no cell for the learner to fill";
    }
    case "choice": {
      try {
        const { correct } = choiceOptions(key);
        if (!key.multiSelect && correct.length !== 1) return "single-select choice needs exactly one correct value";
      } catch (e) {
        return `choice: ${(e as Error).message}`;
      }
      return null;
    }
    default:
      return null;
  }
}

// ── Display ─────────────────────────────────────────────────────────────────

const approx = (n: number) => String(Number(n.toPrecision(4)));

/** A key number for display: "3/64 ≈ 0.04688", "2.5". */
export function displayNumber(value: Cell): string {
  const s = String(value).trim();
  const n = parseNumber(s);
  if (n === null || decimalPrecision(s)) return s;
  return approx(n) === s ? s : `${s} ≈ ${approx(n)}`;
}

/** The key in display form, for the reveal after an attempt. */
export function expectedDisplay(key: AnswerKey): string | (string | null)[][] {
  switch (key.kind) {
    case "number": {
      const main = displayNumber(key.value) + (key.unit ? ` ${key.unit}` : "");
      return key.alternatives.length ? `${main} (also accepted: ${key.alternatives.map(String).join("; ")})` : main;
    }
    case "text":
      return key.accepted.length > 1 ? `${key.accepted[0]} (also accepted: ${key.accepted.slice(1).join("; ")})` : key.accepted[0];
    case "sequence": {
      const show = (v: Cell[]) => (key.ordered ? v.map(String).join(", ") : `{${v.map(String).join(", ")}} (any order)`);
      return key.alternatives.length ? `${show(key.value)} (or ${key.alternatives.map(show).join("; or ")})` : show(key.value);
    }
    case "table":
      return key.rowLabels.map((_, r) =>
        key.colLabels.map((_, c) => {
          const cell = key.cells[r]?.[c] ?? key.given?.[r]?.[c] ?? null;
          return cell === null ? null : cellAlternatives(cell).map(String).join(" or ");
        }),
      );
    case "choice": {
      const { options, correct } = choiceOptions(key);
      return options.filter((o) => correct.includes(o.value)).map((o) => o.label).join("; ");
    }
    case "free":
      return key.modelAnswer;
  }
}

/** Pre-filled cells as the learner sees them (same shape as the labels; null = to fill). */
export function givenCells(key: Extract<AnswerKey, { kind: "table" }>): (string | null)[][] {
  return key.rowLabels.map((_, r) => key.colLabels.map((_, c) => {
    const v = key.given?.[r]?.[c] ?? null;
    return v === null ? null : String(v);
  }));
}

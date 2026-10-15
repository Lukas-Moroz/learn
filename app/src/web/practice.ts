// Pure helpers for exam practice: the table grid editor's keyboard and paste logic,
// accessible cell names, answer formatting and per-problem tallies. No DOM, so they are unit-tested.
import type { AnswerKind, PracticeAttemptView, PracticeStepView, StepStatus } from "../shared/practice.ts";
import { spokenText } from "./components/Markdown.tsx";

export type Grid = string[][];
export type Dir = "up" | "down" | "left" | "right";

/** Cell text is limited to this many characters by the answer contract. */
export const CELL_MAX = 60;

const STEP: Record<Dir, [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
export const ARROW: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** true where the learner types; given (pre-filled) cells are read-only. */
export function editableMask(rows: number, cols: number, given?: (string | null)[][]): boolean[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => given?.[r]?.[c] == null));
}

/** A blank answer grid with the given cells filled in, so the submitted table always has the full shape. */
export function blankGrid(rows: number, cols: number, given?: (string | null)[][]): Grid {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => given?.[r]?.[c] ?? ""));
}

/** Fits a stored answer (from a draft or an earlier attempt) to the table's shape; given cells always win. */
export function fitGrid(value: unknown, rows: number, cols: number, given?: (string | null)[][]): Grid {
  const v = Array.isArray(value) ? value : [];
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => given?.[r]?.[c] ?? (Array.isArray(v[r]) && typeof v[r][c] === "string" ? String(v[r][c]).slice(0, CELL_MAX) : "")),
  );
}

/** The next editable cell from (r, c) in a direction, skipping read-only cells; null at the table's edge. No wrapping. */
export function nextCell(mask: boolean[][], r: number, c: number, dir: Dir): [number, number] | null {
  const [dr, dc] = STEP[dir];
  for (let i = r + dr, j = c + dc; i >= 0 && i < mask.length && j >= 0 && j < (mask[i]?.length ?? 0); i += dr, j += dc) if (mask[i][j]) return [i, j];
  return null;
}

/**
 * Whether an arrow key should leave the cell instead of moving the caret.
 * Up/Down always move between rows. Left/Right move only from the text's edge, from an empty cell,
 * or while the whole text is selected (as it is after arriving with Tab or an arrow key), so editing still works.
 */
export function leavesCell(dir: Dir, value: string, start: number | null, end: number | null): boolean {
  if (dir === "up" || dir === "down") return true;
  const len = value.length;
  if (len === 0 || start === null || end === null) return true;
  if (start === 0 && end === len) return true;
  return dir === "left" ? start === 0 && end === 0 : start === len && end === len;
}

/**
 * A pasted block of cells, or null when the text is a single value (then the browser's own paste applies).
 * Spreadsheet copies are tab-separated; otherwise cells are separated by spaces or commas, rows by line breaks.
 */
export function parseGridPaste(text: string): Grid | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return null;
  const tabbed = lines.some((l) => l.includes("\t"));
  const rows = lines.map((l) => (tabbed ? l.split("\t").map((s) => s.trim()) : l.trim().split(/\s*,\s*|\s+/).filter((s) => s !== "")));
  if (rows.length === 1 && rows[0].length <= 1) return null;
  return rows;
}

/** Where a pasted block lands: at the focused cell, or at the top-left when it is exactly the size of the whole table. */
export function pasteAnchor(block: Grid, rows: number, cols: number, r: number, c: number): [number, number] {
  return block.length === rows && block.every((row) => row.length === cols) ? [0, 0] : [r, c];
}

/** Fills the region starting at (r0, c0); cells past the table's edge and read-only cells are skipped. */
export function applyPaste(values: Grid, mask: boolean[][], r0: number, c0: number, block: Grid): { values: Grid; count: number; last: [number, number] | null } {
  const next = values.map((row) => [...row]);
  let count = 0;
  let last: [number, number] | null = null;
  block.forEach((row, i) =>
    row.forEach((v, j) => {
      const r = r0 + i;
      const c = c0 + j;
      if (r < next.length && c < next[r].length && mask[r]?.[c]) {
        next[r][c] = v.slice(0, CELL_MAX);
        count++;
        last = [r, c];
      }
    }),
  );
  return { values: next, count, last };
}

/** Editable cells still empty, for "3 of 16 cells empty". */
export function emptyCells(values: Grid, mask: boolean[][]): { empty: number; total: number } {
  let empty = 0;
  let total = 0;
  mask.forEach((row, r) =>
    row.forEach((editable, c) => {
      if (!editable) return;
      total++;
      if (!(values[r]?.[c] ?? "").trim()) empty++;
    }),
  );
  return { empty, total };
}

/** A label as plain words: math is read aloud ("$\delta_t(F)$" → "delta sub t(F)"). */
export function plainLabel(label: string): string {
  return label.includes("$") ? spokenText(label) : label.trim();
}

function axisName(labels: string[], i: number, word: string): string {
  const l = plainLabel(labels[i] ?? "");
  const clash = !l || labels.filter((x) => plainLabel(x) === l).length > 1;
  return clash ? `${word} ${i + 1}${l ? ` (${l})` : ""}` : `${word} ${l}`;
}

/** Accessible name of a table cell: "Row C, column A"; positions are added when a label is blank or repeated. */
export function cellName(rowLabels: string[], colLabels: string[], r: number, c: number): string {
  return `${axisName(rowLabels, r, "Row")}, ${axisName(colLabels, c, "column")}`;
}

/** "3" → "Problem 3"; "Set 3" stays as written. */
export function problemLabel(number: string): string {
  return /^\d+[a-z]?$/i.test(number.trim()) ? `Problem ${number.trim()}` : number.trim();
}

export interface Tally {
  total: number;
  attempted: number;
  correct: number;
  partial: number;
  pending: number;
  skipped: number;
}

/** Steps attempted / right / partly right / still being graded, for a problem's summary. */
export function tally(steps: { status: StepStatus }[]): Tally {
  const t: Tally = { total: steps.length, attempted: 0, correct: 0, partial: 0, pending: 0, skipped: 0 };
  for (const s of steps) {
    if (s.status !== "unanswered") t.attempted++;
    if (s.status === "correct") t.correct++;
    if (s.status === "partial") t.partial++;
    if (s.status === "pending") t.pending++;
    if (s.status === "skipped") t.skipped++;
  }
  return t;
}

/** A completed step (answered right, or its solution shown) unlocks the next; so does a written answer waiting for its grade. */
export function stepDone(step: { status: StepStatus }): boolean {
  return step.status === "correct" || step.status === "revealed" || step.status === "pending" || step.status === "skipped";
}

/** Work on unfinished steps first; when all are done, offer the first skipped step to revisit. */
export function currentStepIndex(steps: { status: StepStatus }[]): number {
  const i = steps.findIndex((s) => !stepDone(s));
  if (i >= 0) return i;
  const skipped = steps.findIndex((s) => s.status === "skipped");
  return skipped >= 0 ? skipped : steps.length - 1;
}

/** Attempts oldest first, whatever order the server sent. */
export function sortedAttempts(step: Pick<PracticeStepView, "attempts">): PracticeAttemptView[] {
  return [...step.attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A learner's answer in words, for verdict lines and earlier attempts. Choice values become their labels. */
export function answerText(value: PracticeAttemptView["value"], kind: AnswerKind, options?: { value: string; label: string }[]): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (kind === "table" || value.some(Array.isArray)) {
    const cells = (value as string[][]).flat().filter((v) => v.trim()).length;
    return `a table with ${cells} filled ${cells === 1 ? "cell" : "cells"}`;
  }
  return (value as string[]).map((v) => options?.find((o) => o.value === v)?.label ?? v).join(", ");
}

/** Percent for a 0..1 score, e.g. 0.75 → "75%". */
export const percent = (score: number) => `${Math.round(score * 100)}%`;

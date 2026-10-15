import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { ARROW, applyPaste, CELL_MAX, cellName, editableMask, emptyCells, nextCell, leavesCell, parseGridPaste, pasteAnchor, plainLabel, type Grid } from "../practice.ts";
import { Markdown } from "./Markdown.tsx";

export interface TableShape {
  rowLabels: string[];
  colLabels: string[];
  given: (string | null)[][];
}

/** A header or given value: Markdown only when it holds math, so plain labels stay plain text. */
function Label({ text }: { text: string }) {
  return text.includes("$") ? <Markdown text={text} inline /> : <>{text}</>;
}

/** Shared table frame: column headers, row headers, and a renderer per cell. Scrolls inside its own box on narrow screens. */
function Frame({ table, labelledBy, caption, cell, cellClass }: { table: TableShape; labelledBy?: string; caption?: string; cell: (r: number, c: number) => ReactNode; cellClass?: (r: number, c: number) => string }) {
  return (
    <div className="grid-scroll">
      <table className="answer-grid" aria-labelledby={labelledBy}>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            <td className="corner" />
            {table.colLabels.map((l, c) => (
              <th scope="col" key={c} aria-label={l.includes("$") ? plainLabel(l) : undefined}>
                <Label text={l} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rowLabels.map((l, r) => (
            <tr key={r}>
              <th scope="row" aria-label={l.includes("$") ? plainLabel(l) : undefined}>
                <Label text={l} />
              </th>
              {table.colLabels.map((_, c) => (
                <td key={c} className={cellClass?.(r, c)}>
                  {cell(r, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Grid editor for table steps. One compact input per cell the learner fills; given cells are read-only text.
 * Keyboard: Tab/Shift-Tab in reading order (native); arrow keys move between cells when the caret is at the
 * text's edge, the cell is empty, or its text is fully selected; Enter / Shift-Enter move down / up a row.
 * Pasting a tab-, space- or comma-separated block fills the region from the focused cell.
 */
export function GridEditor({
  table,
  values,
  onChange,
  labelledBy,
  describedBy,
  disabled,
}: {
  table: TableShape;
  values: Grid;
  onChange: (v: Grid) => void;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  const rows = table.rowLabels.length;
  const cols = table.colLabels.length;
  const mask = useMemo(() => editableMask(rows, cols, table.given), [rows, cols, table.given]);
  const box = useRef<HTMLDivElement>(null);
  const [announce, setAnnounce] = useState("");
  const { empty, total } = emptyCells(values, mask);

  const focusCell = (r: number, c: number) => {
    const el = box.current?.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c}"]`);
    if (!el) return;
    el.focus();
    el.select();
  };
  const set = (r: number, c: number, v: string) => onChange(values.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === "Enter") {
      // Never submit the step from a cell by accident (⌘/Ctrl + Enter does that); move like a spreadsheet.
      e.preventDefault();
      const to = nextCell(mask, r, c, e.shiftKey ? "up" : "down");
      if (to) focusCell(...to);
      return;
    }
    const dir = ARROW[e.key];
    if (!dir || e.shiftKey) return;
    const t = e.currentTarget;
    if (!leavesCell(dir, t.value, t.selectionStart, t.selectionEnd)) return;
    const to = nextCell(mask, r, c, dir);
    if (!to) return;
    e.preventDefault();
    focusCell(...to);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const block = parseGridPaste(e.clipboardData.getData("text/plain"));
    if (!block) return;
    e.preventDefault();
    const [r0, c0] = pasteAnchor(block, rows, cols, r, c);
    const res = applyPaste(values, mask, r0, c0, block);
    onChange(res.values);
    setAnnounce(`Pasted ${res.count} ${res.count === 1 ? "cell" : "cells"}.`);
  };

  return (
    <div ref={box} className="grid-editor">
      <Frame
        table={table}
        labelledBy={labelledBy}
        cellClass={(r, c) => (mask[r][c] ? "cell-input" : "given")}
        cell={(r, c) =>
          mask[r][c] ? (
            <input
              type="text"
              data-r={r}
              data-c={c}
              value={values[r]?.[c] ?? ""}
              onChange={(e) => set(r, c, e.target.value)}
              onKeyDown={(e) => onKeyDown(e, r, c)}
              onPaste={(e) => onPaste(e, r, c)}
              aria-label={cellName(table.rowLabels, table.colLabels, r, c)}
              aria-describedby={describedBy}
              maxLength={CELL_MAX}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={disabled}
            />
          ) : (
            <>
              <span className="sr-only">Given: </span>
              <Label text={table.given[r][c] ?? ""} />
            </>
          )
        }
      />
      <div className="hint grid-help">
        {total > 0 && (
          <span>
            {empty === 0 ? "All cells filled" : `${empty} of ${total} cells empty`} ·{" "}
          </span>
        )}
        Arrow keys move between cells · Enter moves down · paste rows from a spreadsheet to fill several cells
      </div>
      <span className="sr-only" role="status">
        {announce}
      </span>
    </div>
  );
}

/** The learner's submitted table with each graded cell marked right or wrong (icon + text, not color alone). */
export function GridResult({ table, values, results, caption }: { table: TableShape; values: Grid | null; results?: (boolean | null)[][]; caption: string }) {
  return (
    <Frame
      table={table}
      caption={caption}
      cellClass={(r, c) => (table.given[r]?.[c] != null ? "given" : results?.[r]?.[c] === true ? "right" : results?.[r]?.[c] === false ? "wrong" : "")}
      cell={(r, c) => {
        const given = table.given[r]?.[c];
        if (given != null) return <Label text={given} />;
        const v = values?.[r]?.[c]?.trim() ?? "";
        const ok = results?.[r]?.[c];
        return (
          <>
            {v || <span className="muted">blank</span>}
            {ok === true && (
              <>
                <span className="cell-mark" aria-hidden>
                  ✓
                </span>
                <span className="sr-only">, correct</span>
              </>
            )}
            {ok === false && (
              <>
                <span className="cell-mark" aria-hidden>
                  ✗
                </span>
                <span className="sr-only">, incorrect</span>
              </>
            )}
          </>
        );
      }}
    />
  );
}

/** The answer key's table; cells the learner got wrong are emphasised and say what the learner wrote. */
export function GridExpected({ table, expected, values, results, caption }: { table: TableShape; expected: (string | null)[][]; values: Grid | null; results?: (boolean | null)[][]; caption: string }) {
  return (
    <Frame
      table={table}
      caption={caption}
      cellClass={(r, c) => (results?.[r]?.[c] === false ? "fix" : table.given[r]?.[c] != null ? "given" : "")}
      cell={(r, c) => {
        const v = expected[r]?.[c] ?? table.given[r]?.[c];
        const wrong = results?.[r]?.[c] === false;
        return (
          <>
            {v == null ? <span className="muted">—</span> : <Label text={v} />}
            {wrong && <span className="sr-only">{`, you wrote ${values?.[r]?.[c]?.trim() || "nothing"}`}</span>}
          </>
        );
      }}
    />
  );
}

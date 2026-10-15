import { describe, expect, it } from "vitest";
import { answerText, applyPaste, blankGrid, cellName, editableMask, emptyCells, fitGrid, leavesCell, nextCell, parseGridPaste, pasteAnchor, problemLabel, tally } from "../src/web/practice.ts";

// Viterbi-style table: ψ1 is given as "—"; everything else is filled by the learner.
const given = [
  ["H", null, null, "—", "—"],
  ["T", null, null, null, null],
  ["T", null, null, null, null],
];
const mask = editableMask(3, 5, given);

describe("practice grid: keyboard navigation", () => {
  it("moves to the adjacent editable cell and skips given cells", () => {
    expect(nextCell(mask, 1, 1, "right")).toEqual([1, 2]);
    expect(nextCell(mask, 1, 1, "left")).toBeNull(); // column 0 is given in every row
    expect(nextCell(mask, 1, 3, "up")).toBeNull(); // ψ1 is given
    expect(nextCell(mask, 0, 2, "down")).toEqual([1, 2]);
    expect(nextCell(mask, 2, 4, "down")).toBeNull();
    expect(nextCell(mask, 0, 2, "right")).toBeNull(); // no wrapping onto the next row
  });

  it("leaves a cell only from the text's edge, an empty cell, or a fully selected cell", () => {
    expect(leavesCell("left", "", 0, 0)).toBe(true);
    expect(leavesCell("left", "3/64", 0, 4)).toBe(true); // selected on arrival
    expect(leavesCell("left", "3/64", 2, 2)).toBe(false); // caret mid-text: edit
    expect(leavesCell("left", "3/64", 0, 0)).toBe(true);
    expect(leavesCell("right", "3/64", 0, 0)).toBe(false);
    expect(leavesCell("right", "3/64", 4, 4)).toBe(true);
    expect(leavesCell("right", "3/64", 1, 3)).toBe(false); // partial selection
    expect(leavesCell("up", "3/64", 2, 2)).toBe(true);
    expect(leavesCell("down", "3/64", 2, 2)).toBe(true);
  });
});

describe("practice grid: paste", () => {
  it("parses spreadsheet (tab) and plain (space/comma) blocks; a single value pastes natively", () => {
    expect(parseGridPaste("1\t2\t3\n4\t5\t6\n")).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
    expect(parseGridPaste("0 1 2\r\n1, 0, 1")).toEqual([
      ["0", "1", "2"],
      ["1", "0", "1"],
    ]);
    expect(parseGridPaste("6 4 1 5 2 3 0")).toEqual([["6", "4", "1", "5", "2", "3", "0"]]);
    expect(parseGridPaste("3/64")).toBeNull();
    expect(parseGridPaste("  3/64 \n")).toBeNull();
    expect(parseGridPaste("\n\n")).toBeNull();
    expect(parseGridPaste("a\t\tc")).toEqual([["a", "", "c"]]); // an empty spreadsheet cell clears its target
  });

  it("fills the region from the focused cell, skipping given cells and the table's edge", () => {
    const values = blankGrid(3, 5, given);
    const res = applyPaste(values, mask, 1, 1, [
      ["a", "b", "c", "d", "overflow"],
      ["e", "f"],
    ]);
    expect(res.values[1]).toEqual(["T", "a", "b", "c", "d"]);
    expect(res.values[2]).toEqual(["T", "e", "f", "", ""]);
    expect(res.count).toBe(6);
    expect(res.last).toEqual([2, 2]);
    expect(values[1][1]).toBe(""); // input untouched
    const intoGiven = applyPaste(values, mask, 0, 2, [["x", "y", "z"]]);
    expect(intoGiven.values[0]).toEqual(["H", "", "x", "—", "—"]);
    expect(intoGiven.count).toBe(1);
  });

  it("anchors a block the size of the whole table at the top-left", () => {
    const full = Array.from({ length: 3 }, () => ["1", "2", "3", "4", "5"]);
    expect(pasteAnchor(full, 3, 5, 1, 2)).toEqual([0, 0]);
    expect(pasteAnchor([["1", "2"]], 3, 5, 1, 2)).toEqual([1, 2]);
  });

  it("caps pasted cells at the contract's 60 characters", () => {
    const res = applyPaste(blankGrid(1, 2), editableMask(1, 2), 0, 0, [["x".repeat(80), "y"]]);
    expect(res.values[0][0]).toHaveLength(60);
  });
});

describe("practice grid: shape and labels", () => {
  it("fits stored answers to the table and keeps given cells", () => {
    expect(fitGrid([["X", "1/4"], ["junk"]], 3, 5, given)[0]).toEqual(["H", "1/4", "", "—", "—"]);
    expect(fitGrid(null, 2, 2)).toEqual([
      ["", ""],
      ["", ""],
    ]);
    expect(emptyCells(fitGrid([["H", "1/4"]], 3, 5, given), mask)).toEqual({ empty: 9, total: 10 });
  });

  it("names cells by their labels, adding positions when a label is blank or repeated", () => {
    expect(cellName(["ϵ", "G", "C", "A"], ["ϵ", "G", "A", "C"], 2, 3)).toBe("Row C, column C");
    expect(cellName(["G", "A", "C", "G"], ["x"], 3, 0)).toBe("Row 4 (G), column x");
    expect(cellName(["", "b"], ["c"], 0, 0)).toBe("Row 1, column c");
    expect(cellName(["1"], ["$\\delta_t(F)$"], 0, 0)).toBe("Row 1, column delta sub t (F)");
  });
});

describe("practice summaries", () => {
  it("labels problems and tallies step results", () => {
    expect(problemLabel("3")).toBe("Problem 3");
    expect(problemLabel("Set 3")).toBe("Set 3");
    expect(tally([{ status: "correct" }, { status: "partial" }, { status: "pending" }, { status: "unanswered" }, { status: "skipped" }])).toEqual({ total: 5, attempted: 4, correct: 1, partial: 1, pending: 1, skipped: 1 });
  });

  it("describes answers in words", () => {
    const options = [
      { value: "a", label: "Sum over paths" },
      { value: "b", label: "Maximum over paths" },
    ];
    expect(answerText(["b"], "choice", options)).toBe("Maximum over paths");
    expect(answerText("6 4 1 5 2 3 0", "sequence")).toBe("6 4 1 5 2 3 0");
    expect(answerText([["1", ""], ["2", "3"]], "table")).toBe("a table with 3 filled cells");
    expect(answerText(null, "number")).toBe("");
  });
});

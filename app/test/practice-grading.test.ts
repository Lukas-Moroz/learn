import { describe, expect, it } from "vitest";
import { AnswerKey } from "../src/shared/practice.ts";
import { answerKeyProblem, compareNumber, displayNumber, expectedDisplay, gradeStep, parseNumber, sequenceTokens } from "../src/shared/practice-grading.ts";

// Keys as the AI would return them, with schema defaults applied.
const key = (k: unknown) => AnswerKey.parse(k);
const num = (value: string | number, extra: object = {}) => key({ kind: "number", value, ...extra });
const seq = (value: (string | number)[], extra: object = {}) => key({ kind: "sequence", value, ...extra });
const close = (a: number | null, b: number) => {
  expect(a).not.toBeNull();
  expect(Math.abs(a! - b)).toBeLessThan(1e-12);
};

describe("number parser (no eval)", () => {
  it("reads numbers the way students write them", () => {
    close(parseNumber("7/64"), 7 / 64);
    close(parseNumber("−2"), -2); // Unicode minus
    close(parseNumber("–0.415"), -0.415); // en dash
    close(parseNumber("2^-3"), 0.125);
    close(parseNumber("2**-3"), 0.125);
    close(parseNumber("-2^2"), -4);
    close(parseNumber("1.5e-3"), 0.0015);
    close(parseNumber(".5"), 0.5);
    close(parseNumber("3 × 4"), 12);
    close(parseNumber("12 ÷ 4"), 3);
    close(parseNumber("(1/2)(7/8)"), 7 / 16);
    close(parseNumber("(1/2)*(1/2)*(3/4)*(1/2)"), 3 / 32);
    close(parseNumber("3087/131072"), 3087 / 131072);
    close(parseNumber("log2(6)"), Math.log2(6));
    close(parseNumber("log2 6"), Math.log2(6));
    close(parseNumber("log_2(8)"), 3);
    close(parseNumber("log₂(8)"), 3);
    close(parseNumber("log10(1000)"), 3);
    close(parseNumber("-log2(1/8)"), 3);
    close(parseNumber("log2(2)^2"), 1);
    close(parseNumber("2log2(3)"), 2 * Math.log2(3));
    close(parseNumber("ln(1)"), 0);
    close(parseNumber("sqrt(16)"), 4);
  });

  it("returns null for anything else", () => {
    for (const bad of ["", "abc", "2 3", "1/0", "log2(-1)", "1;2", "process.exit()", "constructor", "e", "(1", "1)", "--", "F"]) {
      expect(parseNumber(bad), bad).toBeNull();
    }
  });
});

describe("number grading", () => {
  it("accepts a decimal that matches the key rounded to the precision typed (at least two decimals and digits)", () => {
    expect(compareNumber("1/64", "1/64")).toBe("exact");
    expect(compareNumber("0.015625", "1/64")).toBe("exact");
    expect(compareNumber("2^-6", "1/64")).toBe("exact");
    expect(compareNumber("0.0156", "1/64")).toBe("rounded");
    expect(compareNumber("0.016", "1/64")).toBe("rounded");
    expect(compareNumber("0.02", "1/64")).toBe("too_coarse");
    expect(compareNumber("0.015", "1/64")).toBe("wrong");
    expect(compareNumber("1.58", "log2(3)")).toBe("rounded");
    expect(compareNumber("1.585", "log2(3)")).toBe("rounded");
    expect(compareNumber("1.5850", "log2(3)")).toBe("rounded");
    expect(compareNumber("1.59", "log2(3)")).toBe("wrong");
    expect(compareNumber("1.6", "log2(3)")).toBe("too_coarse");
  });

  it("compares fractions and expressions by value, and treats a 3+ decimal key as rounded", () => {
    expect(compareNumber("log2(6)", "2.585")).toBe("exact"); // the guide's "log2 6 ≈ 2.585"
    expect(compareNumber("2.58", "2.585")).toBe("rounded");
    expect(compareNumber("-4.19", "-4.193")).toBe("rounded"); // log-space Viterbi, supplied rounded constants
    expect(compareNumber("-4.1926", "-4.193")).toBe("exact"); // more precise than the rounded key: within its last digit
    expect(compareNumber("5/2", "2.5")).toBe("exact");
    expect(compareNumber("2.50", 2.5)).toBe("exact");
    expect(compareNumber("2.54", "2.5")).toBe("wrong"); // an exact short key is not a rounded one
    expect(compareNumber("2.4", 2)).toBe("wrong"); // nor is an integer
    expect(compareNumber("−2", -2)).toBe("exact");
    expect(compareNumber("2", -2)).toBe("wrong");
    expect(compareNumber("0.4851", "49/101", 0.001)).toBe("exact");
    expect(compareNumber("0.49", "49/101", 0.001)).toBe("wrong");
  });

  it("grades a step: units, ≈, alternatives and helpful feedback", () => {
    const entropy = num("2.5", { unit: "bits" });
    expect(gradeStep(entropy, "2.5 bits")).toMatchObject({ correct: true, score: 1 });
    expect(gradeStep(entropy, "≈ 2.5")).toMatchObject({ correct: true });
    expect(gradeStep(entropy, "2.6")).toMatchObject({ correct: false, score: 0 });
    expect(gradeStep(num("log2(6)", { unit: "bits" }), "2.585 bits")).toMatchObject({ correct: true });
    expect(gradeStep(num("log2(6)"), "2.6")!.feedback).toMatch(/two decimal places/);
    expect(gradeStep(num("log2(6)"), "two point six")!.feedback).toMatch(/can read/);
    expect(gradeStep(num("-2"), "−2")).toMatchObject({ correct: true }); // log-odds score s(A,G)
    expect(gradeStep(num("1/16", { alternatives: ["0.0625"] }), "1/16")).toMatchObject({ correct: true });
    expect(gradeStep(num("3087/131072"), "0.023552")).toMatchObject({ correct: true }); // P(FBBB, HTTT)
  });
});

describe("text and sequence grading", () => {
  it("text ignores case, spacing and punctuation but keeps gap characters", () => {
    const row = key({ kind: "text", accepted: ["-ACT", "AC-T"] });
    expect(gradeStep(row, " -act ")).toMatchObject({ correct: true });
    expect(gradeStep(row, "AC-T.")).toMatchObject({ correct: true });
    expect(gradeStep(row, "ACT")).toMatchObject({ correct: false });
    expect(gradeStep(key({ kind: "text", accepted: ["F"], caseSensitive: true }), "f")).toMatchObject({ correct: false });
  });

  it("a suffix array may be typed with spaces, commas or brackets", () => {
    const sa = seq([6, 4, 1, 5, 2, 3, 0]);
    for (const typed of ["6 4 1 5 2 3 0", "(6,4,1,5,2,3,0)", "[6, 4, 1, 5, 2, 3, 0]", "6;4;1;5;2;3;0"]) {
      expect(gradeStep(sa, typed), typed).toMatchObject({ correct: true, score: 1 });
    }
    expect(sequenceTokens("(6,4,1,5,2,3,0)")).toEqual(["6", "4", "1", "5", "2", "3", "0"]);
    const swapped = gradeStep(sa, "6 4 1 5 2 0 3")!;
    expect(swapped.correct).toBe(false);
    expect(swapped.score).toBeCloseTo(5 / 7);
    expect(swapped.feedback).toBe("5 of 7 entries match.");
    expect(gradeStep(sa, "6 4 1 5 2 3")!.feedback).toBe("Expected 7 entries; you gave 6.");
  });

  it("an unordered set of occurrence positions ignores order", () => {
    const occ = seq(["1", "3"], { ordered: false });
    expect(gradeStep(occ, "3, 1")).toMatchObject({ correct: true });
    expect(gradeStep(occ, "{1, 3}")).toMatchObject({ correct: true });
    expect(gradeStep(occ, "1 3 3")).toMatchObject({ correct: false });
    expect(gradeStep(seq(["0", "2", "4"], { ordered: false }), "4 2 0")).toMatchObject({ correct: true }); // TA in TATATA$
  });

  it("a state path may be typed as one word, and tied tracebacks are alternatives", () => {
    const path = seq(["F", "B", "B", "B"]);
    for (const typed of ["FBBB", "F B B B", "f, b, b, b", "F → B → B → B"]) expect(gradeStep(path, typed), typed).toMatchObject({ correct: true });
    expect(gradeStep(path, "FFBB")).toMatchObject({ correct: false, score: 0.75 }); // greedy per-step choice vs traceback
    const traceback = seq(["(3,3)", "(2,2)", "(1,2)", "(0,1)", "(0,0)"], { alternatives: [["(3,3)", "(2,2)", "(2,1)", "(1,0)", "(0,0)"]] });
    expect(gradeStep(traceback, "(3,3) → (2,2) → (1,2) → (0,1) → (0,0)")).toMatchObject({ correct: true });
    expect(gradeStep(traceback, "(3, 3) -> (2, 2) -> (2, 1) -> (1, 0) -> (0, 0)")).toMatchObject({ correct: true });
    expect(gradeStep(seq(["1/4", "1/16"]), "0.25 0.0625")).toMatchObject({ correct: true });
  });
});

describe("table grading", () => {
  // Problem Set 7: Levenshtein distance between GCA and GAC; D(0,0) printed.
  const edit = key({
    kind: "table",
    rowLabels: ["ε", "G", "C", "A"],
    colLabels: ["ε", "G", "A", "C"],
    cells: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 1, 1], [3, 2, 1, 2]],
    given: [[0, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]],
  });
  const right = [["", "1", "2", "3"], ["1", "0", "1", "2"], ["2", "1", "1", "1"], ["3", "2", "1", "2"]];

  it("grades every key cell, skipping printed ones", () => {
    const g = gradeStep(edit, right)!;
    expect(g).toMatchObject({ correct: true, score: 1, feedback: "" });
    expect(g.cellResults![0][0]).toBeNull();
    expect(g.cellResults!.flat().filter((c) => c === true)).toHaveLength(15);
  });

  it("one wrong cell is partial credit with per-cell results", () => {
    const rows = right.map((r) => [...r]);
    rows[1][3] = "3";
    const g = gradeStep(edit, rows)!;
    expect(g.correct).toBe(false);
    expect(g.score).toBeCloseTo(14 / 15);
    expect(g.cellResults![1][3]).toBe(false);
    expect(g.feedback).toBe("14 of 15 cells are correct.");
  });

  it("missing rows and cells count as wrong instead of failing", () => {
    const g = gradeStep(edit, [["", "1", "2", "3"], ["1", "0"]])!;
    expect(g.correct).toBe(false);
    expect(g.score).toBeCloseTo(5 / 15);
    expect(g.cellResults![3]).toEqual([false, false, false, false]);
  });

  it("a Viterbi table accepts exact fractions or rounded decimals, and backpointer letters", () => {
    const viterbi = key({
      kind: "table",
      rowLabels: ["1", "2", "3", "4"],
      colLabels: ["δ(F)", "δ(B)", "ψ(F)", "ψ(B)"],
      cells: [["1/4", "1/16", null, null], ["3/32", "7/128", "F", "F"], ["9/256", "147/4096", "F", "B"], ["27/2048", "3087/131072", "F", "B"]],
    });
    const decimals = [["0.25", "0.0625", "—", "—"], ["0.09375", "0.0547", "f", "F"], ["0.03516", "0.0359", "F", "b"], ["0.01318", "0.023552", "F", "B"]];
    const g = gradeStep(viterbi, decimals)!;
    expect(g).toMatchObject({ correct: true, score: 1 });
    expect(g.cellResults![0][2]).toBeNull();
    const wrong = decimals.map((r) => [...r]);
    wrong[2][1] = "3/64";
    expect(gradeStep(viterbi, wrong)!.cellResults![2][1]).toBe(false);
  });

  it("log-space scores and \" | \" alternatives", () => {
    const logs = key({ kind: "table", rowLabels: ["1", "2"], colLabels: ["ℓ(F)", "ℓ(B)"], cells: [["-2.000", "-4.000"], ["-3.415", "-4.193"]] });
    expect(gradeStep(logs, [["-2", "−4"], ["-3.42", "-4.19"]])).toMatchObject({ correct: true });
    const pointer = key({ kind: "table", rowLabels: ["C"], colLabels: ["A"], cells: [["up | left"]] });
    expect(gradeStep(pointer, [["left"]])).toMatchObject({ correct: true });
    expect(gradeStep(pointer, [["←"]])).toMatchObject({ correct: true });
    expect(gradeStep(pointer, [["diag"]])).toMatchObject({ correct: false });
  });
});

describe("choice grading", () => {
  const which = key({ kind: "choice", options: [{ value: "related", label: "The related-sequence model" }, { value: "background", label: "The background model" }], correct: "related" });
  it("reuses the quiz grader", () => {
    expect(gradeStep(which, ["related"])).toMatchObject({ correct: true, score: 1 });
    expect(gradeStep(which, ["background"])).toMatchObject({ correct: false, score: 0 });
    expect(() => gradeStep(which, ["both"])).toThrow(/unknown option/);
    expect(() => gradeStep(which, "related")).toThrow(/list of selected/);
  });
});

describe("answer-key checks (reject and repair malformed AI output)", () => {
  it("finds shape and parse problems", () => {
    const table = { kind: "table", rowLabels: ["ε", "G"], colLabels: ["ε", "A"], cells: [[0, 1], [1, 1]] };
    expect(answerKeyProblem(key(table))).toBeNull();
    expect(answerKeyProblem(key({ ...table, cells: [[0, 1]] }))).toMatch(/1 rows but there are 2 row labels/);
    expect(answerKeyProblem(key({ ...table, cells: [[0, 1], [1]] }))).toMatch(/row 1 \("G"\) has 1 cells/);
    expect(answerKeyProblem(key({ ...table, given: [[0, 1]] }))).toMatch(/given has 1 rows/);
    expect(answerKeyProblem(key({ ...table, given: [[0, 1], [1, 1]] }))).toMatch(/no cell for the learner/);
    expect(answerKeyProblem(num("≈2.585"))).toMatch(/not a parsable number/);
    expect(answerKeyProblem(num("2.5 bits"))).toMatch(/not a parsable number/);
    expect(answerKeyProblem(num("log2(6)", { alternatives: ["2.585"] }))).toBeNull();
    expect(answerKeyProblem(key({ kind: "choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correct: "c" }))).toMatch(/does not match any option/);
    expect(answerKeyProblem(key({ kind: "choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correct: ["a", "b"] }))).toMatch(/exactly one/);
    expect(answerKeyProblem(seq([" "]))).toMatch(/no entries/);
  });
});

describe("display of the key after an attempt", () => {
  it("shows exact forms with a decimal, units, sets and tables", () => {
    expect(displayNumber("3/64")).toBe("3/64 ≈ 0.04688");
    expect(displayNumber("2.5")).toBe("2.5");
    expect(expectedDisplay(num("log2(6)", { unit: "bits" }))).toBe("log2(6) ≈ 2.585 bits");
    expect(expectedDisplay(seq([6, 4, 1, 5, 2, 3, 0]))).toBe("6, 4, 1, 5, 2, 3, 0");
    expect(expectedDisplay(seq(["1", "3"], { ordered: false }))).toBe("{1, 3} (any order)");
    expect(expectedDisplay(key({ kind: "table", rowLabels: ["ε", "C"], colLabels: ["ε", "A"], cells: [[null, 1], [1, "up | left"]], given: [[0, null], [null, null]] }))).toEqual([
      ["0", "1"],
      ["1", "up or left"],
    ]);
    expect(expectedDisplay(key({ kind: "choice", options: [{ value: "u", label: "The uniform source" }, { value: "s", label: "The first source" }], correct: "u" }))).toBe("The uniform source");
  });
});

describe("review regressions", () => {
  it("rejects undefined arithmetic at every step, not just in the final value", () => {
    for (const s of ["1/(1/0)", "(1/0)^0", "0/0", "1/0", "log2(0)", "ln(-1)", "log10(0)*0", "sqrt(-4)", "0^-1", "0^0", "10^400/10^400", "1e999", "exp(1000)-exp(1000)"]) {
      expect(parseNumber(s), s).toBeNull();
    }
    expect(gradeStep(num(0), "1/(1/0)")!.correct).toBe(false);
    expect(gradeStep(num(1), "(1/0)^0")!.correct).toBe(false);
    close(parseNumber("sqrt(0)"), 0);
    close(parseNumber("2^-3"), 0.125);
  });

  it("never accepts 0 for a small nonzero key without an explicit tolerance", () => {
    for (const typed of ["0", "0.0", "0.000000", "-0"]) {
      expect(gradeStep(num("1e-10"), typed)!.correct, typed).toBe(false);
      expect(gradeStep(num("1/2^40"), typed)!.correct, typed).toBe(false);
    }
    expect(gradeStep(num("1e-10"), "1e-10")!.correct).toBe(true);
    expect(gradeStep(num("1e-10"), "1.00000000001e-10")!.correct).toBe(true); // float noise, relative
    expect(gradeStep(num("1e-10"), "1.1e-10")!.correct).toBe(false);
    expect(gradeStep(num(0), "1e-12")!.correct).toBe(false);
    expect(gradeStep(num("1e-10", { tolerance: 1e-9 }), "0")!.correct).toBe(true); // an explicit tolerance may allow it
    expect(gradeStep(num("1/64"), "0.016")!.correct).toBe(true); // the decimal-rounding rule is unchanged
    expect(gradeStep(num(0.004), "0.00")!.correct).toBe(false);
  });

  it("keeps compound key entries as units and splits learner input only at the top level", () => {
    const pairs = seq(["(1,2)", "(3,4)"], { ordered: false });
    expect(gradeStep(pairs, "(1,3),(2,4)")!.correct).toBe(false);
    expect(gradeStep(pairs, "(3,4), (1,2)")!.correct).toBe(true);
    expect(gradeStep(pairs, "{(3, 4); (1, 2)}")!.correct).toBe(true);
    expect(gradeStep(pairs, "(1,2) (3,4)")!.correct).toBe(true);
    expect(gradeStep(pairs, "(12,34)")!.correct).toBe(false);
    expect(gradeStep(seq(["(1,2)"]), "(1,2)")!.correct).toBe(true);
    expect(gradeStep(seq(["(1,2)"]), "(2,1)")!.correct).toBe(false);
    expect(gradeStep(seq(["log2(6)"]), "2.585")!.correct).toBe(true);
    expect(gradeStep(seq(["log2(6)", "1/2"]), "[log2(6), 0.5]")!.correct).toBe(true);
    expect(gradeStep(seq([6, 4, 1]), "(6,4,1)")!.correct).toBe(true);
    expect(gradeStep(seq(["A", "B", "C"]), "A -> B -> C")!.correct).toBe(true);
    expect(sequenceTokens(["(1,2)", "log2(6)"])).toEqual(["(1,2)", "log2(6)"]);
    expect(sequenceTokens("[(1,2), (3,4)]")).toEqual(["(1,2)", "(3,4)"]);
    // Unordered matching uses each key entry once, including rounded values.
    expect(gradeStep(seq(["1/3", "0.33"], { ordered: false }), "0.33, 0.333")!.correct).toBe(true);
  });
});

describe("re-review regressions", () => {
  it("a malformed number never matches a numeric key as stripped text", () => {
    const s = gradeStep(seq([123]), "1.2.3")!;
    expect(s.correct).toBe(false);
    expect(s.feedback).toMatch(/Couldn't read this number/);
    expect(gradeStep(seq(["123"]), "1.2.3")).toMatchObject({ correct: false });
    expect(gradeStep(seq([123]), "123")).toMatchObject({ correct: true });
    const t = key({ kind: "table", rowLabels: ["a"], colLabels: ["b"], cells: [[123]] });
    const g = gradeStep(t, [["1.2.3"]])!;
    expect(g.correct).toBe(false);
    expect(g.feedback).toMatch(/Couldn't read one cell as a number/);
    expect(gradeStep(t, [["123"]])).toMatchObject({ correct: true });
    // Non-numeric keys still compare as text.
    expect(gradeStep(seq(["A", "B"]), "a, b.")).toMatchObject({ correct: true });
  });

  it("key-array elements with spaces stay one entry; commas keep spaces inside learner entries", () => {
    expect(sequenceTokens(["1/2 + 1/4", "log2 6"])).toEqual(["1/2 + 1/4", "log2 6"]);
    expect(gradeStep(seq(["1/2 + 1/4"]), "0.75")).toMatchObject({ correct: true });
    expect(gradeStep(seq(["log2 6"]), "2.585")).toMatchObject({ correct: true });
    expect(gradeStep(seq(["log2 6"]), "log2 6")).toMatchObject({ correct: true });
    expect(gradeStep(seq(["0.75", "3"]), "1/2 + 1/4, 3")).toMatchObject({ correct: true });
    expect(gradeStep(seq([1, 2, 3]), "1 2 3")).toMatchObject({ correct: true });
  });

  it("mixed comma and space separators still split into entries (review P3)", () => {
    for (const typed of ["1, 2 3", "1 2, 3", "[1, 2 3]", "1; 2 3"]) {
      expect(gradeStep(seq([1, 2, 3]), typed), typed).toMatchObject({ correct: true, score: 1 });
      expect(gradeStep(seq([3, 1, 2], { ordered: false }), typed), typed).toMatchObject({ correct: true });
    }
    // A comma-separated numeric expression stays one entry; the whole answer may be one entry.
    expect(gradeStep(seq(["0.75", "3"]), "1/2 + 1/4, 3")).toMatchObject({ correct: true });
    expect(gradeStep(seq(["1/2 + 1/4"]), "0.75")).toMatchObject({ correct: true });
    // Ambiguity never accepts a reading with the wrong entry count.
    expect(gradeStep(seq([1, 2, 3]), "1, 2 3 4")).toMatchObject({ correct: false });
    expect(gradeStep(seq([1, 2, 3], { ordered: false }), "1, 2 3 3")).toMatchObject({ correct: false });
    expect(gradeStep(seq([1, 2], { ordered: false }), "1, 2 3")).toMatchObject({ correct: false });
    expect(gradeStep(seq([1, 2, 3]), "1, 3 2")).toMatchObject({ correct: false });
  });
});

describe("grader fixes from the extracted-key audit", () => {
  const table = (cell: string) => key({ kind: "table", rowLabels: ["1"], colLabels: ["relation"], cells: [[cell]] });
  const text = (accepted: string[]) => key({ kind: "text", accepted });

  it("keeps a leading comparison symbol meaningful", () => {
    expect(gradeStep(table("= P"), [["= P"]])!.correct).toBe(true);
    expect(gradeStep(table("= P"), [["=P"]])!.correct).toBe(true);
    expect(gradeStep(table("= P"), [["P"]])!.correct).toBe(false);
    expect(gradeStep(table("= P"), [["< P"]])!.correct).toBe(false);
    expect(gradeStep(table("< P"), [["<P"]])!.correct).toBe(true);
    expect(gradeStep(text(["= P"]), "=P")!.correct).toBe(true);
    expect(gradeStep(text(["= P"]), "< P")!.correct).toBe(false);
    expect(gradeStep(table("P"), [["= P"]])!.correct).toBe(true); // decoration still dropped for plain keys
  });

  it("treats ·, *, × and implicit product alike, and sorts top-level + terms inside O(...)", () => {
    const k = text(["O(T·K^2)"]);
    for (const v of ["O(T*K^2)", "O(TK^2)", "O(T K^2)", "O(T×K^2)"]) expect(gradeStep(k, v)!.correct).toBe(true);
    expect(gradeStep(k, "O(T^2 K)")!.correct).toBe(false);
    const k2 = text(["O(k + m log N)"]);
    expect(gradeStep(k2, "O(m log N + k)")!.correct).toBe(true);
    expect(gradeStep(k2, "O(m log(N + k))")!.correct).toBe(false);
    expect(gradeStep(k2, "O(k m log N)")!.correct).toBe(false);
  });

  it("ignores information units after a number", () => {
    for (const v of ["2.5 bits per symbol", "2.5 bits/symbol", "2.5 bits", "2.5 bit", "2.5 nats"]) expect(gradeStep(num(2.5), v)!.correct).toBe(true);
    expect(gradeStep(seq([1, 2.5]), "1 bit, 2.5 bits")!.correct).toBe(true);
  });

  it("does not split on arrows when a key entry contains one", () => {
    const k = seq(["(3,3)->(2,2)->(1,2)->(0,1)->(0,0)"]);
    expect(gradeStep(k, "(3,3)->(2,2)->(1,2)->(0,1)->(0,0)")!.correct).toBe(true);
    expect(gradeStep(k, "(3,3) → (2,2) → (1,2) → (0,1) → (0,0)")!.correct).toBe(true);
    expect(gradeStep(k, "(3,3)->(2,2)->(2,1)->(1,0)->(0,0)")!.correct).toBe(false);
    const two = seq(["(3,3)->(2,2)->(1,2)", "(3,3)->(2,2)->(2,1)"], { ordered: false });
    expect(gradeStep(two, "(3,3)->(2,2)->(2,1); (3,3)->(2,2)->(1,2)")!.correct).toBe(true);
    expect(gradeStep(two, "(3,3)->(2,2)->(1,2)\n(3,3)->(2,2)->(2,1)")!.correct).toBe(true);
    expect(gradeStep(two, "(3,3)->(2,2)->(1,2)")!.correct).toBe(false);
    // Arrows still separate entries for keys without them.
    expect(gradeStep(seq(["F", "B", "B", "B"]), "F→B→B→B")!.correct).toBe(true);
  });

  it("keeps non-numeric entries with '/' as one text entry", () => {
    const k = seq(["-ACT/CA-T", "AC-T/-CAT"], { ordered: false });
    expect(gradeStep(k, "AC-T/-CAT, -ACT/CA-T")!.correct).toBe(true);
    expect(gradeStep(k, "ACT/CAT, -ACT/CA-T")!.correct).toBe(false);
  });
});

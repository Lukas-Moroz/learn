// The incremental reader behind live previews: current text of named fields in a JSON object
// that is still streaming in, and Markdown that is safe to render half-written.
import { describe, expect, it } from "vitest";
import { partialFields, previewMarkdown, settledText } from "../src/shared/partial-json.ts";

const FIELDS = ["title", "body", "workedExample", "diagnosis", "explanation", "example"];

describe("partialFields", () => {
  it("reads a dotted field of a nested object (a coaching check's stem), open or closed", () => {
    const f = ["check.stem"];
    expect(partialFields('{"check": {"stem": "A fair coin is', f)).toEqual({ values: { "check.stem": "A fair coin is" }, open: "check.stem" });
    expect(partialFields('{"check": {"stem": "A fair coin.", "options": [{"label": "x"', f)).toEqual({ values: { "check.stem": "A fair coin." }, open: null });
    expect(partialFields('{"x": 1, "check": {"kind": "a", "stem": "S"}, "stem": "top"}', ["check.stem"])).toEqual({ values: { "check.stem": "S" }, open: null });
    // Only the nested field: a top-level "stem" is not reported under the dotted name.
    expect(partialFields('{"stem": "top", "check": {"stem": "in"}}', ["check.stem", "stem"])).toEqual({ values: { stem: "top", "check.stem": "in" }, open: null });
  });

  it("reads complete and incomplete string fields at the top level", () => {
    expect(partialFields('{"title": "Chain rule", "body": "The joint', FIELDS)).toEqual({ values: { title: "Chain rule", body: "The joint" }, open: "body" });
    expect(partialFields('{"title":"A","body":"B"}', FIELDS)).toEqual({ values: { title: "A", body: "B" }, open: null });
  });

  it("returns nothing before the object or a field value has started", () => {
    expect(partialFields("", FIELDS)).toEqual({ values: {}, open: null });
    expect(partialFields("```json\n", FIELDS)).toEqual({ values: {}, open: null });
    expect(partialFields('{"tit', FIELDS)).toEqual({ values: {}, open: null });
    expect(partialFields('{"title"', FIELDS)).toEqual({ values: {}, open: null });
    expect(partialFields('{"title": ', FIELDS)).toEqual({ values: {}, open: null });
    expect(partialFields('{"title": "', FIELDS)).toEqual({ values: { title: "" }, open: "title" });
  });

  it("ignores text before the object (code fences, stray words)", () => {
    expect(partialFields('Sure!\n```json\n{"body": "x', FIELDS).values).toEqual({ body: "x" });
  });

  it("resolves escapes: \\n, \\\", \\\\, \\/, \\t and \\uXXXX", () => {
    const raw = String.raw`{"body": "line one\nline \"two\"\\ $\\frac{1}{2}$ a\/b\ttab \u00e9 \u2192"}`;
    expect(partialFields(raw, FIELDS).values.body).toBe('line one\nline "two"\\ $\\frac{1}{2}$ a/b\ttab é →');
  });

  it("drops an escape cut off at the end instead of showing half of it", () => {
    expect(partialFields('{"body": "a\\', FIELDS)).toEqual({ values: { body: "a" }, open: "body" });
    expect(partialFields('{"body": "a\\u00', FIELDS).values.body).toBe("a");
    expect(partialFields('{"body": "a\\u00e', FIELDS).values.body).toBe("a");
    expect(partialFields('{"body": "a\\u00e9', FIELDS).values.body).toBe("aé");
    // A quote that is escaped is not the end of the string.
    expect(partialFields('{"body": "say \\"', FIELDS)).toEqual({ values: { body: 'say "' }, open: "body" });
  });

  it("waits for both halves of a surrogate pair", () => {
    const full = '{"body": "x \\ud83d\\ude00 y"}';
    expect(partialFields(full, FIELDS).values.body).toBe("x 😀 y");
    for (let cut = '{"body": "x '.length; cut < full.indexOf(" y"); cut++) {
      const v = partialFields(full.slice(0, cut), FIELDS).values.body;
      expect(v === "x " || v === "x 😀", `cut at ${cut}: ${JSON.stringify(v)}`).toBe(true);
    }
    // An unpaired high surrogate is dropped rather than shown as a broken character.
    expect(partialFields('{"body": "a\\ud83d b"}', FIELDS).values.body).toBe("a b");
  });

  it("skips other values of every type, including nested strings that look like fields", () => {
    const raw = JSON.stringify({
      strategy: "first_principles",
      equation: { latex: "x}", purpose: '{"body": "fake"}', terms: [{ symbol: "]", meaning: "\\" }] },
      connections: ["a", "b]"],
      difficulty: 3,
      flag: true,
      none: null,
      title: "Real title",
      body: "Real body",
    });
    expect(partialFields(raw, FIELDS)).toEqual({ values: { title: "Real title", body: "Real body" }, open: null });
  });

  it("only reports the named fields, and not a named field whose value is not a string", () => {
    expect(partialFields('{"body": 3, "explanation": ["x"], "other": "y", "title": "t"}', FIELDS).values).toEqual({ title: "t" });
  });

  it("stops at a cut-off value it is skipping", () => {
    expect(partialFields('{"title": "T", "equation": {"latex": "x', FIELDS)).toEqual({ values: { title: "T" }, open: null });
    expect(partialFields('{"title": "T", "difficulty": 3', FIELDS)).toEqual({ values: { title: "T" }, open: null });
  });

  it("a later duplicate key wins, as in JSON.parse", () => {
    expect(partialFields('{"body": "first", "body": "sec', FIELDS).values.body).toBe("sec");
  });

  it("every prefix of a real response yields a prefix of the final text, growing monotonically", () => {
    const value = {
      strategy: "worked_example",
      diagnosis: 'It looks like the "neighbour" cell was used.\nSee below.',
      explanation: "Start from $D(i,j) = \\min(\\ldots)$ — always true.\n\n- a\n- b ✓ 😀",
      example: "Take $X = \\text{A}$ and $Y = \\text{B}$.",
      nextHint: "Look at one cell.",
      refs: [{ doc: 1, page: 2, quote: "q" }],
    };
    const raw = JSON.stringify(value, null, 1);
    const prev: Record<string, string> = {};
    for (let n = 0; n <= raw.length; n++) {
      const { values } = partialFields(raw.slice(0, n), FIELDS);
      for (const [k, v] of Object.entries(values)) {
        const final = (value as Record<string, unknown>)[k] as string;
        expect(final.startsWith(v), `${k} at ${n}`).toBe(true);
        expect(v.length).toBeGreaterThanOrEqual(prev[k]?.length ?? 0);
        prev[k] = v;
      }
    }
    expect(prev).toEqual({ diagnosis: value.diagnosis, explanation: value.explanation, example: value.example });
  });
});

describe("settledText", () => {
  it("holds back a trailing partial word or number", () => {
    expect(settledText("The value is 12")).toBe("The value is ");
    expect(settledText("The value is 12.")).toBe("The value is 12.");
    expect(settledText("Hello world ")).toBe("Hello world ");
    expect(settledText("Hello")).toBe("");
    expect(settledText("")).toBe("");
  });
});

describe("previewMarkdown", () => {
  it("hides an unterminated trailing inline math span until it closes", () => {
    expect(previewMarkdown("Let $x = 1$ and $\\frac{1}{")).toBe("Let $x = 1$ and");
    expect(previewMarkdown("Let $x = 1$ and $y$.")).toBe("Let $x = 1$ and $y$.");
  });

  it("hides an unterminated display math block", () => {
    expect(previewMarkdown("Text\n\n$$\nP(E) = \\sum")).toBe("Text\n\n");
    expect(previewMarkdown("Text\n\n$$\nP(E)\n$$\n\nMore")).toBe("Text\n\n$$\nP(E)\n$$\n\nMore");
    expect(previewMarkdown("Text $$a$")).toBe("Text");
  });

  it("an escaped dollar is not a delimiter", () => {
    expect(previewMarkdown("It costs \\$5 and $x")).toBe("It costs \\$5 and");
    expect(previewMarkdown("It costs \\$5")).toBe("It costs \\$5");
  });

  it("dollars inside code don't count, and an open code fence is closed", () => {
    expect(previewMarkdown("Run `echo $HOME` now")).toBe("Run `echo $HOME` now");
    expect(previewMarkdown("```\nlet a = $b")).toBe("```\nlet a = $b\n```");
    expect(previewMarkdown("```\ncode\n```\nthen $x")).toBe("```\ncode\n```\nthen");
  });
});

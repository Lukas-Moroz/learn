import { describe, expect, it } from "vitest";
import { normalizeMath } from "../src/web/components/Markdown.tsx";

describe("math normalisation", () => {
  it("turns one-line $$…$$ into display math and leaves inline math alone", () => {
    expect(normalizeMath("Text\n\n$$P(E) = \\sum P(\\omega)$$\n\nmore $x$")).toBe("Text\n\n$$\nP(E) = \\sum P(\\omega)\n$$\n\nmore $x$");
    expect(normalizeMath("inline $$a$$ inside a sentence")).toBe("inline $$a$$ inside a sentence");
  });
});

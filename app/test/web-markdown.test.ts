import { describe, expect, it } from "vitest";
import katex from "katex";
import { normalizeMath } from "../src/web/components/Markdown.tsx";

describe("math normalisation", () => {
  it("turns one-line $$…$$ into display math and leaves inline math alone", () => {
    expect(normalizeMath("Text\n\n$$P(E) = \\sum P(\\omega)$$\n\nmore $x$")).toBe("Text\n\n$$\nP(E) = \\sum P(\\omega)\n$$\n\nmore $x$");
    expect(normalizeMath("inline $$a$$ inside a sentence")).toBe("inline $$a$$ inside a sentence");
  });

  it("keeps an escaped dollar inside math from ending the span", () => {
    const t = normalizeMath("Let the text be $T=\\text{TATATA\\$}$, with");
    const body = /\$([^$]+)\$/.exec(t)![1];
    expect(body).toBe("T=\\text{TATATA\\textdollar{}}");
    expect(() => katex.renderToString(body, { throwOnError: true })).not.toThrow();
  });
});

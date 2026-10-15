import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { previewMarkdown } from "../../shared/partial-json.ts";

/**
 * remark-math only treats $$…$$ as display math when the delimiters sit on their own
 * lines. Models (and people) often write `$$x$$` on one line; normalise that.
 */
export function normalizeMath(text: string): string {
  return (
    text
      // An escaped dollar (e.g. the terminal in "TATATA\$") would end the math span early.
      .replace(/\\\$/g, "\\textdollar{}")
      .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, body) => `$$\n${body.trim()}\n$$`)
  );
}

/** Markdown with $…$ / $$…$$ math (KaTeX, bundled locally so it works offline). */
export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  const md = (
    <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}>
      {inline ? text : normalizeMath(text)}
    </ReactMarkdown>
  );
  return inline ? <span className="md-inline">{md}</span> : <div className="prose">{md}</div>;
}

/** Markdown still being written: an unterminated trailing math span stays hidden until it closes. */
export function PreviewMarkdown({ text }: { text: string }) {
  return <Markdown text={previewMarkdown(text)} />;
}

export function Tex({ latex, display = false }: { latex: string; display?: boolean }) {
  return <Markdown text={display ? `$$\n${latex}\n$$` : `$${latex}$`} inline={!display} />;
}

const NUMBER = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const PART: Record<number, [string, string]> = { 2: ["half", "halves"], 3: ["third", "thirds"], 4: ["quarter", "quarters"], 5: ["fifth", "fifths"], 6: ["sixth", "sixths"], 7: ["seventh", "sevenths"], 8: ["eighth", "eighths"], 9: ["ninth", "ninths"], 10: ["tenth", "tenths"], 12: ["twelfth", "twelfths"] };
const SYMBOL: Record<string, string> = {
  cdot: "times", times: "times", div: "divided by", pm: "plus or minus", le: "is at most", leq: "is at most", ge: "is at least", geq: "is at least",
  ne: "is not equal to", neq: "is not equal to", approx: "is approximately", to: "to", rightarrow: "to", infty: "infinity", sum: "the sum over",
  prod: "the product over", in: "in", notin: "not in", mid: "given", cup: "union", cap: "intersection", subset: "subset of", subseteq: "subset of",
  emptyset: "the empty set", varnothing: "the empty set", ldots: "and so on", cdots: "and so on", dots: "and so on", neg: "not", lnot: "not",
  land: "and", lor: "or", log: "log", ln: "natural log", exp: "exp", Pr: "P",
};

function fraction(a: string, b: string): string {
  const [n, d] = [a.trim(), b.trim()];
  if (/^\d+$/.test(n) && /^\d+$/.test(d) && PART[+d] && +n <= 12) return `${NUMBER[+n]} ${+n === 1 ? PART[+d][0] : PART[+d][1]}`;
  return `${n} over ${d}`;
}

/** Read simple LaTeX aloud: \frac{2}{3} → "two thirds", x^2 → "x squared". Best effort; unknown commands keep their name. */
export function speakTex(tex: string): string {
  let s = tex.replace(/\\left|\\right|\\[,;:! ]|\\q?quad/g, " ");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s
      .replace(/\\(?:text|textrm|mathrm|mathbf|mathit|mathcal|mathbb|operatorname)\s*\{([^{}]*)\}/g, " $1 ")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, " the square root of $1 ")
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a, b) => ` ${fraction(a, b)} `)
      .replace(/\^\s*(?:2|\{\s*2\s*\})(?!\d)/g, " squared ")
      .replace(/\^\s*(?:3|\{\s*3\s*\})(?!\d)/g, " cubed ")
      .replace(/\^\s*\{([^{}]*)\}/g, " to the power $1 ")
      .replace(/_\s*\{([^{}]*)\}/g, " sub $1 ");
  }
  return s
    .replace(/\^\s*(\w)/g, " to the power $1 ")
    .replace(/_\s*(\w)/g, " sub $1 ")
    .replace(/\\([a-zA-Z]+)/g, (_m, name: string) => ` ${SYMBOL[name] ?? name} `)
    .replace(/(\w)!/g, "$1 factorial")
    .replace(/[{}]/g, " ")
    .replace(/\s*=\s*/g, " equals ")
    .replace(/\s*\+\s*/g, " plus ")
    .replace(/\s*-\s*/g, " minus ")
    .replace(/\s*<\s*/g, " is less than ")
    .replace(/\s*>\s*/g, " is greater than ")
    .replace(/\s*\|\s*/g, " given ")
    .replace(/\s*\/\s*/g, " over ");
}

/** Plain spoken text for a short Markdown string with math, for accessible names. */
export function spokenText(md: string): string {
  return md
    .replace(/\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g, (_m, display, inline) => ` ${speakTex(display ?? inline)} `)
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+([),.;:?])/g, "$1")
    .trim();
}

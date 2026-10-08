import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

/**
 * remark-math only treats $$…$$ as display math when the delimiters sit on their own
 * lines. Models (and people) often write `$$x$$` on one line; normalise that.
 */
export function normalizeMath(text: string): string {
  return text.replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, body) => `$$\n${body.trim()}\n$$`);
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

export function Tex({ latex, display = false }: { latex: string; display?: boolean }) {
  return <Markdown text={display ? `$$\n${latex}\n$$` : `$${latex}$`} inline={!display} />;
}

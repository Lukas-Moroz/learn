import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

/** Markdown with $…$ / $$…$$ math (KaTeX, bundled locally so it works offline). */
export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  const md = (
    <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}>
      {text}
    </ReactMarkdown>
  );
  return inline ? <span className="md-inline">{md}</span> : <div className="prose">{md}</div>;
}

export function Tex({ latex, display = false }: { latex: string; display?: boolean }) {
  return <Markdown text={display ? `$$\n${latex}\n$$` : `$${latex}$`} inline={!display} />;
}

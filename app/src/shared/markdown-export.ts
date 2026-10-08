// Export a lesson to Obsidian-flavoured Markdown, using the same callout format as
// the pi `md-log` extension (extensions/md-log.ts), so exported lessons sit
// naturally next to existing session logs. Math stays as $…$ / $$…$$.
import type { Block, QuestionView, SourceRef } from "./schemas.ts";

function callout(type: string, title: string, body: string[]): string {
  const lines = [`> [!${type}] ${title}`];
  for (const line of body) lines.push(line.length === 0 ? ">" : `> ${line}`);
  return lines.join("\n");
}

const split = (s: string) => s.split("\n");

function sourceLine(refs: SourceRef[], provenance: string): string {
  if (refs.length) return `*Source: ${refs.map((r) => r.label ?? `p. ${r.page}`).join("; ")}*`;
  return provenance === "supplementary" ? "*Supplementary explanation (AI-generated, not from the source).*" : "";
}

function questionCallout(q: QuestionView): string {
  const body = [...split(q.stem), "", ...q.options.map((o, i) => `${i + 1}. ${o.label}`)];
  return callout("question", "Quiz", body);
}

function answerCallout(q: QuestionView): string | null {
  const a = q.attempt;
  if (!a) return null;
  const idx = (v: string) => q.options.findIndex((o) => o.value === v) + 1;
  const type = a.dontKnow ? "question" : a.correct ? "success" : "failure";
  const title = a.dontKnow ? "Quiz — I don't know" : a.correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗";
  const body: string[] = [];
  body.push(a.dontKnow ? "Your answer: I don't know" : `Your answer: ${a.selected.map((v) => `${idx(v)}. ${q.options.find((o) => o.value === v)?.label}`).join(", ")}`);
  body.push(`Correct answer: ${a.correctValues.map((v) => idx(v)).join(", ")}`);
  if (a.confidence) body.push(`Confidence: ${a.confidence}`);
  if (a.note) {
    body.push("");
    const [first, ...rest] = split(a.note);
    body.push(`Note: ${first}`, ...rest);
  }
  if (a.reasoning) body.push("", `Reasoning (${a.reasoning.verdict.replace("_", " ")}): ${a.reasoning.summary}`);
  body.push("", ...split(a.explanation));
  return callout(type, title, body);
}

export function lessonToMarkdown(view: {
  lesson: { title: string; objective: string | null };
  nav: { course: string | null; lecture: string | null };
  blocks: (Block & { question?: QuestionView })[];
}): string {
  const out: string[] = [`# ${view.lesson.title}`];
  const meta = [view.nav.course, view.nav.lecture].filter(Boolean).join(" › ");
  if (meta) out.push(`*${meta}*`);
  if (view.lesson.objective) out.push(`**Objective:** ${view.lesson.objective}`);

  for (const b of view.blocks) {
    const p = b.payload;
    switch (b.type) {
      case "overview":
        out.push(callout("abstract", `Overview (AI summary of the ${p.kind === "paper" ? "paper" : "document"})`, [
          ...(p.researchQuestion ? [`**Research question:** ${p.researchQuestion}`, ""] : []),
          ...split(p.overview),
          ...(p.contributions?.length ? ["", "**Contributions:**", ...p.contributions.map((c: string) => `- ${c}`)] : []),
          "",
          "**Learning path:** " + (p.path ?? []).map((c: { name: string }) => c.name).join(" → "),
        ]));
        break;
      case "plan":
        out.push(callout("abstract", "Plan", [...split(p.overview), "", "**Learning path:** " + p.path.map((c: { name: string }) => c.name).join(" → ")]));
        break;
      case "explanation": {
        const parts = [`## ${p.title}`, p.body];
        if (p.equation) {
          const e = p.equation;
          parts.push(`$$\n${e.latex}\n$$`, `**Why it exists:** ${e.purpose}`, ...e.terms.map((t: { symbol: string; meaning: string }) => `- $${t.symbol}$: ${t.meaning}`));
          if (e.behavior?.length) parts.push("**How it behaves:**", ...e.behavior.map((x: string) => `- ${x}`));
          if (e.assumptions?.length) parts.push("**Assumptions:**", ...e.assumptions.map((x: string) => `- ${x}`));
          if (e.derivation) parts.push(callout("note", "Derivation (optional)", split(e.derivation)));
        }
        if (p.workedExample) parts.push(callout("example", "Worked example", split(p.workedExample)));
        if (p.analogy) parts.push(callout("tip", "Analogy", split(p.analogy.text)), callout("warning", "Where the analogy breaks down", split(p.analogy.breaksDown)));
        if (p.diagram) parts.push("```mermaid\n" + p.diagram.mermaid + "\n```", `*${p.diagram.caption}*`);
        if (p.connections?.length) parts.push("**Connections:** " + p.connections.join("; "));
        const src = sourceLine(b.refs, b.provenance);
        if (src) parts.push(src);
        out.push(parts.join("\n\n"));
        break;
      }
      case "question":
        if (b.question) {
          out.push(questionCallout(b.question));
          const ans = answerCallout(b.question);
          if (ans) out.push(ans);
        }
        break;
      case "detour_start":
        out.push(callout("info", `Detour: ${p.conceptName}`, [p.reason, "", `Returning to: ${p.fromName}${p.returnLabel ? ` (${p.returnLabel})` : ""}`]));
        break;
      case "detour_end":
        out.push(callout("info", `Back to ${p.returningTo}`, [p.returnLabel ? `Resuming at ${p.returnLabel}.` : "Resuming."]));
        break;
      case "checkpoint":
        out.push(
          callout("summary", `Checkpoint ${p.index}`, [
            `**Learned:** ${p.learned.map((l: { name: string }) => l.name).join(", ") || "—"}`,
            `**Can explain confidently:** ${p.canExplain.join(", ") || "—"}`,
            `**Still uncertain:** ${p.uncertain.map((u: { name: string; why: string }) => `${u.name} (${u.why})`).join("; ") || "—"}`,
            `**Misconceptions:** ${p.misconceptions.map((m: { label: string; status: string }) => `${m.label} [${m.status}]`).join("; ") || "—"}`,
            `**Connections:** ${p.connections.join("; ") || "—"}`,
            `**Next:** ${p.next ? `${p.next.name}${p.next.where ? ` (${p.next.where})` : ""}` : "—"}`,
          ]),
        );
        break;
      case "notice":
        out.push(callout("note", p.kind === "complete" ? "Lesson complete" : "Note", split(p.message)));
        break;
    }
  }
  return out.join("\n\n") + "\n";
}

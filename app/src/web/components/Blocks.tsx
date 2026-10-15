import type { ReactNode } from "react";
import { SkeletonLines } from "./Progress.tsx";
import type { SourceRef } from "../../shared/schemas.ts";
import type { BlockView } from "../api.ts";
import { Markdown, PreviewMarkdown, Tex } from "./Markdown.tsx";
import { Mermaid } from "./Mermaid.tsx";
import { StatusBadge } from "./QuestionCard.tsx";
import type { SourceTarget } from "./SourceDrawer.tsx";

type Open = (t: SourceTarget) => void;

const ROLE: Record<string, [string, string, string]> = {
  central: ["Central", "central", "A main idea of this material: you'll also apply it in an unfamiliar situation"],
  background: ["Background", "", "Supporting knowledge: checked briefly, and skipped if you already know it"],
  optional: ["Optional", "optional", "Deeper exploration you can leave out"],
};

export function RoleBadge({ role }: { role: string }) {
  const [label, cls, help] = ROLE[role] ?? [role, "", ""];
  return (
    <span className={`badge ${cls}`} title={help || undefined}>
      {label}
    </span>
  );
}

export function RefChip({ r, open }: { r: SourceRef | { sourceId: string; page: number; label?: string | null; quote?: string }; open: Open }) {
  return (
    <button type="button" className="ref-chip" onClick={() => open({ sourceId: r.sourceId, page: r.page, quote: r.quote, label: r.label })} title="Open the original source here">
      ↗ {r.label ?? `p. ${r.page}`}
    </button>
  );
}

function Provenance({ refs, provenance, open }: { refs: SourceRef[]; provenance: string; open: Open }) {
  if (refs.length) {
    return (
      <div className="provenance">
        <span>{provenance === "source" ? "AI-written explanation of" : "Supplementary explanation (AI-written, not quoted from the source). Related:"}</span>
        {refs.map((r, i) => (
          <RefChip key={i} r={r} open={open} />
        ))}
      </div>
    );
  }
  if (provenance === "supplementary") {
    return <div className="provenance">Supplementary explanation: AI-written, not taken from the source.</div>;
  }
  return null;
}

/** Overview and plan stay one tap away: collapsed once the learner has started, or on a phone. */
export function OverviewBlock({ b, open, collapsed = false }: { b: BlockView; open: Open; collapsed?: boolean }) {
  const p = b.payload;
  return (
    <section className="block card" id={b.id}>
      <div className="kicker">{p.kind === "paper" ? "Paper overview" : "Lecture overview"} · AI summary of the document</div>
      <h1 style={{ marginTop: "0.3rem" }}>{p.title}</h1>
      <details className="outline" open={!collapsed}>
        <summary>
          Overview and learning path <span className="muted small">· {p.path.length} concepts</span>
        </summary>
        {p.researchQuestion && (
          <p>
            <b>Research question.</b> {p.researchQuestion}
          </p>
        )}
        {p.motivation && <p className="muted">{p.motivation}</p>}
        <Markdown text={p.overview} />
        {(["contributions", "methods", "experiments", "conclusions"] as const).map((k) =>
          p[k]?.length ? (
            <details className="expand" key={k}>
              <summary>{k[0].toUpperCase() + k.slice(1)}</summary>
              <ul>
                {p[k].map((x: string, i: number) => (
                  <li key={i}>
                    <Markdown text={x} inline />
                  </li>
                ))}
              </ul>
            </details>
          ) : null,
        )}
        {p.structure?.length > 0 && (
          <details className="expand">
            <summary>Structure ({p.structure.length} sections)</summary>
            <ul>
              {p.structure.map((s: any, i: number) => (
                <li key={i}>
                  {s.title} {s.ref && <RefChip r={s.ref} open={open} />}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="section-title">Learning path</div>
        <ol style={{ margin: 0, paddingLeft: "1.3em" }}>
          {p.path.map((c: any) => (
            <li key={c.conceptId} style={{ margin: "0.25rem 0" }}>
              <span className="row" style={{ display: "inline-flex", gap: "0.4rem" }}>
                {c.name} <RoleBadge role={c.role} /> {c.ref && <RefChip r={c.ref} open={open} />}
              </span>
            </li>
          ))}
        </ol>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Background concepts are checked briefly first. Anything you already know is skipped.
        </p>
      </details>
    </section>
  );
}

export function PlanBlock({ b, collapsed = false }: { b: BlockView; collapsed?: boolean }) {
  const p = b.payload;
  return (
    <section className="block card" id={b.id}>
      <div className="kicker">Plan</div>
      <h1 style={{ marginTop: "0.3rem" }}>{p.title}</h1>
      <details className="outline" open={!collapsed}>
        <summary>
          Overview and learning path <span className="muted small">· {p.path.length} concepts</span>
        </summary>
        <Markdown text={p.overview} />
        <ol style={{ margin: 0, paddingLeft: "1.3em" }}>
          {p.path.map((c: any) => (
            <li key={c.conceptId}>
              {c.name} <RoleBadge role={c.role} />
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

const PURPOSE_KICKER: Record<string, string> = {
  introduce: "New idea",
  remediate: "Another way in",
  detour: "Prerequisite",
  return: "Back on track",
};

/** "writing…" next to a heading while its text streams in. */
export function Writing() {
  return (
    <span className="writing">
      <span className="writing-dot" aria-hidden /> writing…
    </span>
  );
}

/** "Revising…": the text being written didn't pass the checks and is being rewritten. */
export function Revising({ what = "the explanation" }: { what?: string }) {
  return (
    <p className="working small revising">
      <span className="spinner" aria-hidden />
      <span className="grow">Revising {what}…</span>
    </p>
  );
}

/**
 * A provisional explanation, shown while it is being written, laid out like the block that
 * replaces it once it validates. Not announced as it grows (aria-live off); the page announces
 * the finished block once.
 */
export function ExplanationPreview({ fields, revising, conceptName, label = "Explanation" }: { fields: Record<string, string> | null; revising: boolean; conceptName: string; label?: string }) {
  return (
    <section className={`block preview${!fields && !revising ? " skeleton" : ""}`} aria-live="off" aria-busy="true" aria-label={`${label} being written`}>
      <div className="kicker">
        {label}
        {conceptName ? ` · ${conceptName}` : ""} {!revising && <Writing />}
      </div>
      {revising ? (
        <Revising />
      ) : !fields ? (
        <>
          <span className="skeleton-line" style={{ width: "45%", height: "1.3rem", margin: "0.5rem 0 0.7rem" }} aria-hidden />
          <SkeletonLines lines={4} />
        </>
      ) : (
        <>
          {fields.title && <h2 style={{ margin: "0.25rem 0 0.2rem" }}>{fields.title}</h2>}
          {fields.body && <PreviewMarkdown text={fields.body} />}
          {fields.workedExample && (
            <details className="expand" open>
              <summary>Worked example</summary>
              <PreviewMarkdown text={fields.workedExample} />
            </details>
          )}
        </>
      )}
    </section>
  );
}

export function ExplanationBlock({ b, open, conceptName, footer }: { b: BlockView; open: Open; conceptName: string; footer?: ReactNode }) {
  const p = b.payload;
  return (
    <section className="block" id={b.id}>
      <div className="kicker">
        {PURPOSE_KICKER[p.purpose] ?? "Explanation"} · {conceptName}
      </div>
      <h2 style={{ margin: "0.25rem 0 0.2rem" }}>{p.title}</h2>
      {p.purpose !== "introduce" && p.reason && <div className="reason-line">{p.reason}</div>}
      <Markdown text={p.body} />
      {p.equation && <Equation e={p.equation} />}
      {p.workedExample && (
        <details className="expand" open>
          <summary>Worked example</summary>
          <Markdown text={p.workedExample} />
        </details>
      )}
      {p.analogy && (
        <>
          <div className="aside analogy">
            <div className="kicker">Analogy</div>
            <Markdown text={p.analogy.text} />
          </div>
          <div className="aside limits">
            <div className="kicker">Where the analogy breaks down</div>
            <Markdown text={p.analogy.breaksDown} />
          </div>
        </>
      )}
      {p.diagram && <Mermaid source={p.diagram.mermaid} caption={p.diagram.caption} />}
      {p.connections?.length > 0 && (
        <p className="muted small">
          <b>Connections:</b> {p.connections.join(" · ")}
        </p>
      )}
      <Provenance refs={b.refs} provenance={b.provenance} open={open} />
      {footer}
    </section>
  );
}

function Equation({ e }: { e: any }) {
  return (
    <div className="equation">
      <Tex latex={e.latex} display />
      <Markdown text={`**Why it exists.** ${e.purpose}`} />
      {e.terms?.length > 0 && (
        <dl className="terms">
          {e.terms.map((t: any, i: number) => (
            <div key={i} style={{ display: "contents" }}>
              <dt>
                <Tex latex={t.symbol} />
              </dt>
              <dd>
                <Markdown text={t.meaning} inline />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {e.behavior?.length > 0 && (
        <>
          <h4>How it behaves</h4>
          <ul>
            {e.behavior.map((x: string, i: number) => (
              <li key={i}>
                <Markdown text={x} inline />
              </li>
            ))}
          </ul>
        </>
      )}
      {e.assumptions?.length > 0 && (
        <>
          <h4>Assumes</h4>
          <ul>
            {e.assumptions.map((x: string, i: number) => (
              <li key={i}>
                <Markdown text={x} inline />
              </li>
            ))}
          </ul>
        </>
      )}
      {e.derivation && (
        <details className="expand">
          <summary>Derivation (optional)</summary>
          <Markdown text={e.derivation} />
        </details>
      )}
    </div>
  );
}

export function DetourStartBlock({ b }: { b: BlockView }) {
  const p = b.payload;
  return (
    <section className="block" id={b.id}>
      <div className="marker">Detour</div>
      <div className="detour-card" style={{ marginTop: "0.6rem" }}>
        <div className="row">
          <b>Prerequisite: {p.conceptName}</b>
          <RoleBadge role={p.role} />
        </div>
        <p style={{ margin: "0.35rem 0" }}>{p.reason}. Once it's solid, we return to {p.fromName}.</p>
        {p.returnLabel && <div className="small muted">Returning to: {p.returnLabel}</div>}
      </div>
    </section>
  );
}

export function DetourEndBlock({ b }: { b: BlockView }) {
  const p = b.payload;
  return (
    <section className="block" id={b.id}>
      <div className="marker back">
        Back to {p.returningTo}
        {p.returnLabel ? ` · ${p.returnLabel}` : ""}
      </div>
    </section>
  );
}

export function CheckpointBlock({ b }: { b: BlockView }) {
  const p = b.payload;
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "—");
  return (
    <section className="block card checkpoint" id={b.id}>
      <div className="kicker">Checkpoint {p.index}</div>
      <dl>
        <dt>You learned</dt>
        <dd>{list(p.learned.map((l: any) => l.name))}</dd>
        <dt>You can explain</dt>
        <dd>{list(p.canExplain)}</dd>
        <dt>Still uncertain</dt>
        <dd>{p.uncertain.length ? p.uncertain.map((u: any) => `${u.name}: ${u.why}`).join("; ") : "Nothing flagged"}</dd>
        <dt>Misconceptions</dt>
        <dd>
          {p.misconceptions.length
            ? p.misconceptions.map((m: any, i: number) => (
                <div key={i}>
                  <Markdown text={m.label} inline /> <span className={`badge ${m.status === "resolved" ? "good" : "warn"}`}>{m.status}</span>
                </div>
              ))
            : "None detected"}
        </dd>
        <dt>Connections</dt>
        <dd>{list(p.connections)}</dd>
        <dt>Confidence</dt>
        <dd className="small">{p.calibration.verdict}</dd>
        <dt>Next</dt>
        <dd>{p.next ? `${p.next.name}${p.next.where ? ` (${p.next.where})` : ""}` : "End of this lesson"}</dd>
      </dl>
      <div className="row small" style={{ marginTop: "0.6rem" }}>
        {p.concepts.map((c: any) => (
          <span key={c.conceptId} className="row" style={{ gap: "0.3rem" }}>
            {c.name} <StatusBadge status={c.status} />
          </span>
        ))}
      </div>
    </section>
  );
}

export function ReviewBlock({ b, onSkip, active }: { b: BlockView; onSkip: () => void; active: boolean }) {
  return (
    <section className="block notice" id={b.id}>
      <div className="row">
        <div>
          <b>Quick review before we continue.</b> These earlier concepts support today's material and are due for a refresh:{" "}
          {b.payload.concepts.map((c: any) => c.name).join(", ")}.
        </div>
        {active && (
          <button className="btn small" onClick={onSkip}>
            Skip review
          </button>
        )}
      </div>
    </section>
  );
}

export function NoticeBlock({ b }: { b: BlockView }) {
  return (
    <section className="block notice" id={b.id}>
      {b.payload.kind === "complete" ? <b>Lesson complete. </b> : null}
      {b.payload.message}
    </section>
  );
}

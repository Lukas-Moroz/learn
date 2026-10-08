import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { StatusBadge } from "../components/QuestionCard.tsx";
import { TopBar } from "../components/TopBar.tsx";

/** The shared, cross-course concept graph with evidence-based status. */
export function ConceptsPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.concepts>> | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    api.concepts().then(setData);
  }, []);
  const byId = useMemo(() => Object.fromEntries((data?.concepts ?? []).map((c) => [c.id, c])), [data]);
  const shown = (data?.concepts ?? []).filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <TopBar crumbs={<b>Concepts</b>} />
      <main className="page reading">
        <h1>Concepts</h1>
        <p className="muted">One graph across all your courses. A concept keeps one shared definition; each course can add its own interpretation.</p>
        <input type="text" placeholder="Filter concepts" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter concepts" />
        <div className="concept-list" style={{ marginTop: "1rem" }}>
          {shown.map((c) => {
            const prereqs = data!.edges.filter((e) => e.concept_id === c.id && e.kind === "prerequisite").map((e) => byId[e.related_id]?.name).filter(Boolean);
            return (
              <details key={c.id} className="expand">
                <summary className="row" style={{ display: "flex" }}>
                  <b style={{ flex: 1 }}>{c.name}</b>
                  {c.sense && <span className="badge">{c.sense}</span>}
                  <StatusBadge status={c.mastery.status} />
                </summary>
                <Markdown text={c.definition} />
                {prereqs.length > 0 && <p className="small">Builds on: {prereqs.join(", ")}</p>}
                {c.contexts.length > 0 && (
                  <p className="small muted">
                    Used in: {c.contexts.map((x: any) => x.course_title + (x.interpretation ? ` (${x.interpretation})` : "")).join("; ")}
                  </p>
                )}
                <div className="dims">
                  {Object.entries(c.mastery.dimensions).map(([d, s]) => (
                    <span key={d} className={`dim ${s}`}>
                      {d}
                    </span>
                  ))}
                </div>
                {c.misconceptions.length > 0 && (
                  <ul className="small">
                    {c.misconceptions.map((m: any) => (
                      <li key={m.id}>
                        <Markdown text={m.label} inline /> <span className={`badge ${m.status === "resolved" ? "good" : "warn"}`}>{m.status}</span> <span className="muted">seen {m.occurrences}×</span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            );
          })}
          {data && shown.length === 0 && <p className="muted">No concepts yet. They appear as you study.</p>}
        </div>
      </main>
    </>
  );
}

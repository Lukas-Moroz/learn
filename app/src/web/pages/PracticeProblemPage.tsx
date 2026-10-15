import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import type { PracticeProblemView, PracticeSetView, PracticeStepView } from "../../shared/practice.ts";
import { api, ApiError, errorMessage } from "../api.ts";
import { RefChip } from "../components/Blocks.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { PrimerCard } from "../components/PracticeGuide.tsx";
import { LearnConcept, PracticeStepCard, StepBadge } from "../components/PracticeStep.tsx";
import { bringIntoView } from "../components/QuestionCard.tsx";
import { SourceDrawer, type SourceTarget } from "../components/SourceDrawer.tsx";
import { TopBar, useShell } from "../components/TopBar.tsx";
import { currentStepIndex, problemLabel, stepDone, tally } from "../practice.ts";
import { usePracticeLive } from "../practiceLive.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One exam problem worked step by step, with the lecture pages that teach it and the original problem page. */
export function PracticeProblemPage({ setId, problemId }: { setId: string; problemId: string }) {
  const { status } = useShell();
  const [problem, setProblem] = useState<PracticeProblemView | null>(null);
  const [set, setSet] = useState<PracticeSetView | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [source, setSource] = useState<SourceTarget | null>(null);
  // Bumped on every local change, so a refetch that started earlier can't overwrite a newer answer.
  const seq = useRef(0);
  const ids = useId();

  const load = useCallback(() => {
    const at = seq.current;
    return api.practiceProblem(problemId).then(
      (p) => {
        if (seq.current === at) setProblem(p);
        setLoadError(null);
      },
      (e) => setLoadError({ message: errorMessage(e), missing: e instanceof ApiError && e.status === 404 }),
    );
  }, [problemId]);
  // The set gives the title and previous/next problems; the page works without it.
  const loadSet = useCallback(() => api.practiceSet(setId).then(setSet, () => undefined), [setId]);
  useEffect(() => {
    load();
    loadSet();
  }, [load, loadSet]);

  // The warm-up is prepared once per problem, the first time it is opened before any step was tried.
  const primerAsked = useRef(false);
  useEffect(() => {
    if (problem?.primer.status !== "not_started" || primerAsked.current) return;
    primerAsked.current = true;
    seq.current++;
    api.startPrimer(problem.id).then(setProblem, () => undefined);
  }, [problem]);

  // Poll while anything is being prepared or graded, in case a live event is missed.
  const pending = Boolean(
    problem && (problem.steps.some((s) => s.status === "pending" || (s.coaching ?? []).some((c) => c.status === "pending" || (c.status === "ready" && c.checkStatus === "pending"))) || problem.primer.status === "pending"),
  );
  usePracticeLive(load, { match: (ev) => ev.problemId === problemId || Boolean(ev.stepId && problem?.steps.some((s) => s.id === ev.stepId)), pollMs: pending ? 5000 : null });
  usePracticeLive(loadSet, { match: (ev) => ev.setId === setId && !ev.stepId, pollMs: set?.status === "extracting" ? 10000 : null });

  const updateStep = useCallback((s: PracticeStepView) => {
    seq.current++;
    setProblem((p) => p && { ...p, steps: p.steps.map((x) => (x.id === s.id ? s : x)) });
  }, []);
  const updateProblem = useCallback((p: PracticeProblemView) => {
    seq.current++;
    setProblem(p);
  }, []);

  // The step the learner is on: finished steps before it fold; it stays open (feedback, follow-ups) until Next.
  const [focusId, setFocusId] = useState<string | null>(null);
  const goToStep = (stepId: string) => {
    setFocusId(stepId);
    requestAnimationFrame(() => {
      const el = document.getElementById(`step-${stepId}`);
      if (!el) return;
      bringIntoView(el, el.querySelector<HTMLElement>(".step-answer input, .step-answer textarea") ?? el.querySelector<HTMLElement>(".step-label"));
    });
  };

  // Previous / next follow the set's order.
  const list = set?.problems ?? [];
  const idx = list.findIndex((p) => p.id === problemId);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 ? (list[idx + 1] ?? null) : null;
  const setHref = `#/practice/${setId}`;
  const problemHref = (id: string) => `#/practice/${setId}/${id}`;

  if (!problem) {
    return (
      <>
        <TopBar crumbs={<b>{set?.title ?? "Exam practice"}</b>} />
        <main className="page reading practice">
          <a className="back-link small" href={setHref}>
            <span aria-hidden>←</span> All problems
          </a>
          {loadError ? (
            <div className="banner bad" role="alert" style={{ marginTop: "1rem" }}>
              <span className="grow">
                <b>{loadError.missing ? "This problem no longer exists." : "Couldn't load this problem."}</b> {loadError.missing ? "" : loadError.message}
              </span>
              {!loadError.missing && (
                <button className="btn small" onClick={load}>
                  Retry
                </button>
              )}
            </div>
          ) : (
            <p className="working" role="status" style={{ marginTop: "1rem" }}>
              <span className="spinner" aria-hidden /> Loading problem…
            </p>
          )}
        </main>
      </>
    );
  }

  const t = tally(problem.steps);
  // Only the first step not yet completed is open (none while the warm-up runs); completed steps stay above.
  const current = problem.primer.done ? currentStepIndex(problem.steps) : -1;
  const focusAt = problem.steps.findIndex((s) => s.id === focusId);
  const focus = focusAt >= 0 ? focusAt : Math.max(current, 0);
  // Concepts of the steps not yet right (each step falls back to the problem's concepts), without repeats.
  const revisit = [...new Map(problem.steps.filter((s) => s.status !== "correct").flatMap((s) => (s.concepts?.length ? s.concepts : problem.concepts)).map((c) => [c.id, c])).values()];
  const label = problemLabel(problem.number);
  const nav = (where: "top" | "bottom") => (
    <div className={`problem-nav ${where}`}>
      <a className="back-link small" href={setHref}>
        <span aria-hidden>←</span> All problems
      </a>
      <span className="spacer" />
      {prev && (
        <a className="btn small" href={problemHref(prev.id)} aria-label={`Previous: ${problemLabel(prev.number)}, ${prev.title}`}>
          <span aria-hidden>←</span> Previous
        </a>
      )}
      {next && (
        <a className="btn small" href={problemHref(next.id)} aria-label={`Next: ${problemLabel(next.number)}, ${next.title}`}>
          Next problem <span aria-hidden>→</span>
        </a>
      )}
    </div>
  );

  return (
    <>
      <TopBar
        crumbs={
          <>
            <a href={setHref} className="crumb-link">
              {set?.title ?? "Exam practice"}
            </a>
            {" › "}
            {label}
          </>
        }
      />
      <main className="page reading practice">
        <nav aria-label="Problems">{nav("top")}</nav>
        <div className="kicker" style={{ marginTop: "0.8rem" }}>
          {set?.title ?? "Exam practice"}
          {idx >= 0 && ` · ${idx + 1} of ${list.length}`}
          {set?.keySource === "generated" && (
            <span className="badge warn" style={{ marginLeft: 6 }} title="No solutions document: the answer key was written by AI and is unverified">
              AI answer key
            </span>
          )}
        </div>
        <h1>
          {label}: {problem.title}
        </h1>

        <details className="problem-intro expand" open={!problem.primer.done}>
          <summary>Problem overview</summary>
          <Markdown text={problem.intro} />
        </details>
        {(problem.taughtIn.length > 0 || problem.problemRefs.length > 0) && (
          <div className="ref-groups">
            {problem.taughtIn.length > 0 && (
              <div className="provenance">
                <span className="kicker">Where this is taught</span>
                {problem.taughtIn.map((r, i) => (
                  <RefChip key={i} r={r} open={setSource} />
                ))}
              </div>
            )}
            {problem.problemRefs.length > 0 && (
              <div className="provenance">
                <span className="kicker">Original problem</span>
                {problem.problemRefs.map((r, i) => (
                  <RefChip key={i} r={r} open={setSource} />
                ))}
              </div>
            )}
          </div>
        )}

        {status?.paused && (
          <div className="banner warn small" role="status" style={{ marginTop: "1rem" }}>
            <span className="grow">
              <b>AI generation is paused.</b> {status.paused.reason} Explanations after a miss{problem.steps.some((s) => s.kind === "free") ? " and written answers" : ""} wait for a provider; answers are still checked right away and the solution can always be shown.
            </span>
          </div>
        )}

        <PrimerCard problem={problem} onUpdate={updateProblem} openSource={setSource} onStart={() => problem.steps[0] && requestAnimationFrame(() => goToStep(problem.steps[0].id))} />

        <div className="stream steps">
          {problem.steps.map((s, i) => {
            const after = problem.steps[i + 1];
            if (i !== current && !stepDone(s)) {
              return (
                <section key={s.id} className="step locked" id={`step-${s.id}`} aria-labelledby={`${ids}-locked-${i}`}>
                  <div className="step-head">
                    <span className="kicker">
                      Step {i + 1} of {problem.steps.length}
                    </span>
                    <StepBadge status={s.status} />
                  </div>
                  <h2 className="step-label" id={`${ids}-locked-${i}`}>
                    {s.label}
                  </h2>
                  <p className="muted small locked-note">
                    {current < 0 && i === 0 ? "Unlocks after the warm-up (or skip it above)." : `Unlocks after step ${i}.`}
                  </p>
                </section>
              );
            }
            return (
              <Fragment key={s.id}>
                {i === current && (
                  // The problem's data right above the open step, so numbers needn't be scrolled for.
                  <details className="step-setup" open>
                    <summary>Problem setup</summary>
                    <Markdown text={problem.intro} />
                  </details>
                )}
              {i < focus && i !== current ? (
                // Finished steps fold to one line; click to look back at the answer and solution.
                <details className="step-done" id={`fold-${s.id}`}>
                  <summary>
                    Step {i + 1} · {s.label} <StepBadge status={s.status} />
                  </summary>
              <PracticeStepCard
                step={s}
                index={i}
                count={problem.steps.length}
                problemId={problem.id}
                concepts={s.concepts?.length ? s.concepts : problem.concepts}
                onUpdate={updateStep}
                openSource={setSource}
                next={after ? { label: "Next step", go: () => goToStep(after.id) } : { label: next ? "Next problem" : "All problems", go: () => { location.hash = next ? problemHref(next.id) : setHref; } }}
              />
                </details>
              ) : (
              <PracticeStepCard
                step={s}
                index={i}
                count={problem.steps.length}
                problemId={problem.id}
                concepts={s.concepts?.length ? s.concepts : problem.concepts}
                onUpdate={updateStep}
                openSource={setSource}
                next={after ? { label: "Next step", go: () => goToStep(after.id) } : { label: next ? "Next problem" : "All problems", go: () => { location.hash = next ? problemHref(next.id) : setHref; } }}
              />
              )}
              </Fragment>
            );
          })}
        </div>

        {t.total > 0 && t.attempted === t.total && (
          <section className="card problem-summary" aria-labelledby={`${ids}-summary`}>
            <h2 id={`${ids}-summary`}>How this problem went</h2>
            <p>
              {t.correct} of {plural(t.total, "step")} right
              {t.partial > 0 && `, ${t.partial} partly right`}
              {t.pending > 0 && `, ${t.pending} still being checked`}.
              {t.skipped > 0 && ` ${plural(t.skipped, "step")} skipped for now.`}
            </p>
            {revisit.length > 0 && (
              <>
                <h3 className="kicker">Concepts to revisit</h3>
                <ul className="revisit">
                  {revisit.map((c) => (
                    <li key={c.id}>
                      <span className="grow">{c.name}</span>
                      <LearnConcept problemId={problem.id} concepts={[c]} label="Learn" className="btn small" />
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="row" style={{ marginTop: "0.8rem" }}>
              {next ? (
                <a className="btn primary" href={problemHref(next.id)}>
                  Next: {problemLabel(next.number)} <span aria-hidden>→</span>
                </a>
              ) : (
                <a className="btn primary" href={setHref}>
                  Back to all problems
                </a>
              )}
            </div>
          </section>
        )}

        {nav("bottom")}
      </main>
      {source && <SourceDrawer target={source} onClose={() => setSource(null)} />}
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type BlockView, type LessonView } from "../api.ts";
import { CheckpointBlock, DetourEndBlock, DetourStartBlock, ExplanationBlock, NoticeBlock, OverviewBlock, PlanBlock, RefChip, ReviewBlock, RoleBadge } from "../components/Blocks.tsx";
import { QuestionCard, StatusBadge, type Answer, type FeedbackInfo } from "../components/QuestionCard.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { SourceDrawer, type SourceTarget } from "../components/SourceDrawer.tsx";
import { TopBar, useShell } from "../components/TopBar.tsx";

const WORKING: Record<string, string> = {
  analyze_source: "Reading the document",
  explain: "Writing an explanation",
  question: "Writing a question",
  evaluate_reasoning: "Reading your reasoning",
  plan_objective: "Planning the path",
};

export function LessonPage({ lessonId }: { lessonId: string }) {
  const { toast } = useShell();
  const [view, setView] = useState<LessonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<{ id: string; task: string; chars: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [source, setSource] = useState<SourceTarget | null>(null);
  const [panel, setPanel] = useState(false);
  const [showRecap, setShowRecap] = useState(false);
  const continueBtn = useRef<HTMLButtonElement>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const v = await api.lesson(lessonId);
    setView(v);
    return v;
  }, [lessonId]);

  const advance = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api.advance(lessonId);
      setView(v);
      setShowRecap(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e);
        await load().catch(() => undefined);
      } else setError(new ApiError(0, "network", (e as Error).message));
    } finally {
      setBusy(false);
      setJob(null);
    }
  }, [lessonId, load]);

  // First open: start a fresh lesson, or show a recap when resuming.
  useEffect(() => {
    load().then((v) => {
      if (!firstLoad.current) return;
      firstLoad.current = false;
      if (v.blocks.length === 0) advance();
      else {
        setShowRecap(Boolean(v.recap));
        const anchor = v.recap?.anchorBlockId;
        if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
      }
    }, (e) => setError(e));
  }, [load, advance]);

  // Live progress of generation for this lesson.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (ev.type === "job" && ev.lessonId === lessonId) {
          if (ev.status === "running") setJob({ id: ev.jobId, task: ev.task, chars: ev.chars ?? 0 });
          else setJob(null);
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => es.close();
  }, [lessonId]);

  const answer = useCallback(
    async (questionId: string, a: Answer) => {
      const v = await api.answer(lessonId, questionId, a);
      setView(v);
      requestAnimationFrame(() => continueBtn.current?.focus({ preventScroll: true }));
    },
    [lessonId],
  );

  // Cmd/Ctrl+Enter continues from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && view && !view.state.pendingQuestionId && !view.state.complete && !busy) advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, busy, advance]);

  const conceptNames = useMemo(() => Object.fromEntries((view?.concepts ?? []).map((c) => [c.conceptId, c.name])), [view]);
  const feedbackFor = useMemo(() => {
    const m: Record<string, FeedbackInfo> = {};
    for (const b of view?.blocks ?? []) if (b.type === "feedback") m[b.payload.questionId] = b.payload;
    return m;
  }, [view]);

  if (!view) {
    return (
      <>
        <TopBar />
        <main className="page reading">{error ? <ErrorBanner error={error} onRetry={() => location.reload()} /> : <Working label="Opening lesson" />}</main>
      </>
    );
  }

  const nav = view.nav;
  const pending = view.state.pendingQuestionId;
  const canContinue = !pending && !view.state.complete;
  const lastQuestion = [...view.blocks].reverse().find((b) => b.type === "question");

  const render = (b: BlockView) => {
    switch (b.type) {
      case "overview":
        return <OverviewBlock key={b.id} b={b} open={setSource} />;
      case "plan":
        return <PlanBlock key={b.id} b={b} />;
      case "explanation":
        return <ExplanationBlock key={b.id} b={b} open={setSource} conceptName={conceptNames[b.conceptId!] ?? ""} />;
      case "question":
        return (
          <section className="block" id={b.id} key={b.id}>
            <QuestionCard question={b.question!} feedback={feedbackFor[b.question!.id]} onSubmit={(a) => answer(b.question!.id, a)} autoFocus={b.id === lastQuestion?.id && !showRecap} />
            {b.refs.length > 0 && (
              <div className="provenance">
                Related source: {b.refs.map((r, i) => <RefChip key={i} r={r} open={setSource} />)}
              </div>
            )}
          </section>
        );
      case "detour_start":
        return <DetourStartBlock key={b.id} b={b} />;
      case "detour_end":
        return <DetourEndBlock key={b.id} b={b} />;
      case "checkpoint":
        return <CheckpointBlock key={b.id} b={b} />;
      case "review":
        return <ReviewBlock key={b.id} b={b} active={view.state.reviewQueue.length > 0} onSkip={() => api.skipReview(lessonId).then(setView)} />;
      case "notice":
        return <NoticeBlock key={b.id} b={b} />;
      default:
        return null;
    }
  };

  const strip = (
    <div className="navstrip" aria-label="Where you are">
      {nav.concept && (
        <span className="item">
          <span className="label">Concept</span>
          <button className="value" onClick={() => setPanel(true)}>
            {nav.concept}
          </button>
          {nav.conceptRole && <RoleBadge role={nav.conceptRole} />}
        </span>
      )}
      {nav.sourcePosition && (
        <span className="item">
          <span className="label">Source</span>
          <button className="value" onClick={() => setSource({ sourceId: nav.sourcePosition!.sourceId, page: nav.sourcePosition!.page, label: nav.sourcePosition!.label })}>
            {nav.sourcePosition.label}
          </button>
        </span>
      )}
      {nav.activity.kind === "detour" && (
        <span className="item detour" title={nav.activity.reason}>
          <span className="label">Activity</span>
          <span>
            {nav.activity.label} → returning to {nav.activity.returnTo}
          </span>
        </span>
      )}
      <span className="item">
        <span className="label">Progress</span>
        <button className="value" onClick={() => setPanel(true)}>
          {nav.progress.done}/{nav.progress.total} concepts
        </button>
      </span>
    </div>
  );

  return (
    <>
      <TopBar
        crumbs={
          <>
            {nav.course && <b>{nav.course}</b>}
            {nav.course && " › "}
            {nav.lecture ?? view.lesson.title}
          </>
        }
        progress={nav.progress.total ? nav.progress.done / nav.progress.total : 0}
      >
        {strip}
      </TopBar>
      <main className="page">
        <div className="reading stream">
          {view.blocks.map(render)}

          {showRecap && view.recap && (
            <section className="recap" aria-label="Where you left off">
              <div className="kicker">Welcome back · last active {new Date(view.recap.lastActive).toLocaleString()}</div>
              <ul>
                {view.recap.lines.map((l, i) => (
                  <li key={i}>
                    <Markdown text={l} inline />
                  </li>
                ))}
              </ul>
              {pending ? (
                <button className="btn primary" onClick={() => {
                  setShowRecap(false);
                  document.getElementById(view.recap!.anchorBlockId ?? "")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}>
                  Continue: answer the open question
                </button>
              ) : null}
            </section>
          )}

          {(view.paused || (error && ["usage_limit", "billing_risk", "auth_required", "not_installed", "not_enabled"].includes(error.code))) && (
            <PausedBanner paused={view.paused} error={error} />
          )}
          {error && !["usage_limit", "billing_risk", "auth_required", "not_installed", "not_enabled"].includes(error.code) && <ErrorBanner error={error} onRetry={advance} />}

          <div className="continue-bar">
            {busy ? (
              <div className="working" aria-live="polite">
                <span className="spinner" aria-hidden />
                {job ? `${WORKING[job.task] ?? "Working"}… ${job.chars > 0 ? `(${(job.chars / 1000).toFixed(1)}k characters)` : ""}` : "Thinking about what comes next…"}
                {job && (
                  <button className="btn small ghost" onClick={() => api.cancelJob(job.id)}>
                    Cancel
                  </button>
                )}
              </div>
            ) : canContinue ? (
              <>
                <button ref={continueBtn} className="btn primary large" onClick={advance}>
                  Continue
                </button>
                <span className="hint">⌘/Ctrl + Enter</span>
              </>
            ) : view.state.complete ? (
              <div className="row">
                <a className="btn" href="#/">
                  Back to courses
                </a>
                <button className="btn" onClick={() => api.exportMarkdown(lessonId).then((r) => toast(`Exported to ${r.path}`))}>
                  Export to Markdown
                </button>
              </div>
            ) : null}
          </div>
          {!view.state.complete && view.blocks.length > 3 && (
            <div className="row small muted" style={{ justifyContent: "center" }}>
              Everything is saved as you go. You can close the browser at any time.
              <button className="btn ghost small" onClick={() => api.exportMarkdown(lessonId).then((r) => toast(`Exported to ${r.path}`))}>
                Export Markdown
              </button>
            </div>
          )}
        </div>
      </main>

      {source && <SourceDrawer target={source} onClose={() => setSource(null)} />}
      {panel && <ProgressPanel view={view} onClose={() => setPanel(false)} open={setSource} />}
    </>
  );
}

function Working({ label }: { label: string }) {
  return (
    <div className="working" style={{ justifyContent: "center", marginTop: "3rem" }}>
      <span className="spinner" /> {label}…
    </div>
  );
}

function PausedBanner({ paused, error }: { paused: LessonView["paused"]; error: ApiError | null }) {
  const { openSettings } = useShell();
  const code = paused?.code ?? error?.code;
  const reason = paused?.reason ?? error?.message;
  const title =
    code === "usage_limit"
      ? "Paused: your plan's usage limit was reached"
      : code === "billing_risk"
        ? "Stopped to avoid unexpected charges"
        : code === "auth_required"
          ? "Paused: sign in to continue"
          : "Paused: no AI provider is available";
  return (
    <div className="banner warn" role="status">
      <div style={{ flex: 1 }}>
        <b>{title}</b>
        <div className="small">{reason}</div>
        <div className="small muted">Everything you've done is saved. You can keep reading and reviewing; new lesson content resumes when a provider is available. Nothing is ever switched to pay-as-you-go billing.</div>
      </div>
      {paused?.usageUrl && (
        <a className="btn small" href={paused.usageUrl} target="_blank" rel="noreferrer">
          Check usage
        </a>
      )}
      <button className="btn small" onClick={openSettings}>
        Providers
      </button>
      <a className="btn small" href="#/review">
        Review instead
      </a>
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="banner bad" role="alert">
      <div style={{ flex: 1 }}>
        <b>{error.code === "interrupted" ? "The response was interrupted" : error.code === "invalid_response" ? "The generated content didn't pass checks" : "Something went wrong"}</b>
        <div className="small">{error.message}</div>
        <div className="small muted">Nothing partial was saved into your lesson. Retrying is safe.</div>
      </div>
      <button className="btn small primary" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function ProgressPanel({ view, onClose, open }: { view: LessonView; onClose: () => void; open: (t: SourceTarget) => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Lesson progress">
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <div className="kicker">Progress</div>
            <b>{view.lesson.title}</b>
          </div>
          <button className="btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          <p className="muted small" style={{ marginTop: 0 }}>
            Understanding is tracked as separate kinds of evidence. "Demonstrated" needs a confident grasp of the idea and correct application; central concepts also need it applied in an unfamiliar setting.
          </p>
          <div className="concept-list">
            {view.concepts.map((c) => (
              <div className="concept-row" key={c.conceptId} style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div className="row">
                  <b>{c.name}</b>
                  <RoleBadge role={c.role} />
                  {!c.onPath && <span className="badge warn">Detour</span>}
                  <span className="spacer" />
                  <StatusBadge status={c.status} />
                </div>
                <div className="dims">
                  {Object.entries(c.dimensions).map(([d, s]) => (
                    <span key={d} className={`dim ${s}`} title={`${d}: ${s}`}>
                      {d}
                    </span>
                  ))}
                  {c.ref && <RefChip r={{ sourceId: c.ref.sourceId, page: c.ref.page, label: c.ref.label }} open={open} />}
                </div>
                {c.status !== "demonstrated" && c.status !== "not_assessed" && <div className="small muted">{c.reasons.slice(0, 2).join(" · ")}</div>}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}

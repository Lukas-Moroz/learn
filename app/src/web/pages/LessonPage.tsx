import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type BlockView, type LessonView } from "../api.ts";
import { CheckpointBlock, DetourEndBlock, DetourStartBlock, ExplanationBlock, ExplanationPreview, NoticeBlock, OverviewBlock, PlanBlock, RefChip, ReviewBlock, RoleBadge } from "../components/Blocks.tsx";
import { Modal } from "../components/Modal.tsx";
import { bringIntoView, nextStep, QuestionCard, StatusBadge, type Answer, type FeedbackInfo } from "../components/QuestionCard.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { SourceDrawer, type SourceTarget } from "../components/SourceDrawer.tsx";
import { TopBar, useShell } from "../components/TopBar.tsx";
import { FollowUpBox } from "../components/FollowUp.tsx";
import { LESSON_EVENT, useFollowUpActivity, useJobEvents, useLivePreview } from "../liveJobs.ts";
import { Elapsed, QuestionPreview, useDelayed } from "../components/Progress.tsx";

const WORKING: Record<string, string> = {
  analyze_source: "Reading the document",
  explain: "Writing an explanation",
  question: "Writing a question",
  evaluate_reasoning: "Reading your reasoning",
  plan_objective: "Planning the path",
};

const GREETING_TYPES = new Set(["overview", "plan"]);
const GROUPED = new Set(["explanation", "question", "feedback"]);
const HELD = ["usage_limit", "billing_risk", "auth_required", "not_installed", "not_enabled"];

type Item = { kind: "block"; b: BlockView } | { kind: "group"; conceptId: string; blocks: BlockView[] };

/** Describe the move behind Continue so the learner can choose it knowingly. */
function continuation(view: LessonView): { label: string; hint: string } {
  const latest = view.blocks.filter((b) => b.type === "question").at(-1)?.question;
  switch (view.nextAction) {
    case "overview": case "probe": return { label: "Start lesson", hint: "One question at a time. You can skip a concept whenever you need to." };
    case "check": return { label: latest?.attempt ? "Next question" : "Try a question", hint: "A new question on this concept." };
    case "explain": return latest?.attempt?.correct === false
      ? { label: "See a different explanation", hint: "We'll try another way to make this idea click." }
      : { label: "See an explanation", hint: "Take a short look at the idea, then try a question." };
    case "detour": return { label: "Review a prerequisite", hint: "A short look at the background, then we'll return here." };
    case "return": return { label: "Back to the lesson", hint: "Return to the concept you were working on." };
    case "advance": case "stuck": return { label: "Next concept", hint: "Keep moving through the lesson." };
    case "review": return { label: "Start review", hint: "A quick refresher before the lesson. You can skip it." };
    case "checkpoint": return { label: "See your progress", hint: "A short recap of what you've covered." };
    case "complete": return { label: "Finish lesson", hint: "Your progress is saved." };
    default: return { label: "Continue", hint: "Move to the next step." };
  }
}

/** Consecutive explanation/question runs for one concept become a section; others stay standalone. */
function sections(blocks: BlockView[]): Item[] {
  const items: Item[] = [];
  for (const b of blocks) {
    const last = items[items.length - 1];
    if (GROUPED.has(b.type) && last?.kind === "group" && (last.conceptId === b.conceptId || (b.type === "feedback" && !b.conceptId))) last.blocks.push(b);
    else if (GROUPED.has(b.type) && b.conceptId) items.push({ kind: "group", conceptId: b.conceptId, blocks: [b] });
    else items.push({ kind: "block", b });
  }
  return items;
}

export function LessonPage({ lessonId }: { lessonId: string }) {
  const { toast } = useShell();
  const [view, setView] = useState<LessonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [job, setJob] = useState<{ id: string; task: string; chars: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [source, setSource] = useState<SourceTarget | null>(null);
  const [panel, setPanel] = useState(false);
  // "intro" for a lesson that has a plan but nothing studied yet; "recap" only when resuming real work.
  const [greet, setGreet] = useState<"intro" | "recap" | null>(null);
  const [landing, setLanding] = useState<string | null>(null);
  const [offscreen, setOffscreen] = useState<"above" | "below" | null>(null);
  const [narrow] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches);
  const continueBtn = useRef<HTMLButtonElement>(null);
  const greetRef = useRef<HTMLElement>(null);
  const firstLoad = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  // The explanation being written, shown live where it will appear; replaced by the validated block.
  const preview = useLivePreview((ev) => ev.lessonId === lessonId && ev.task === "explain");
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // The question being written: its stem streams in; options appear with the validated question.
  const qPreview = useLivePreview((ev) => ev.lessonId === lessonId && ev.task === "question");
  const qPreviewRef = useRef(qPreview);
  qPreviewRef.current = qPreview;
  // Blocks committed mid-advance (e.g. the explanation while its question is being written) were shown live.
  const liveArrived = useRef(false);
  /** Bumped whenever an advance's response is applied, so a slower live refetch can't overwrite it. */
  const applied = useRef(0);
  const [announce, setAnnounce] = useState("");
  // A follow-up answer being written holds Continue (the learner is reading it).
  const followUps = useFollowUpActivity(lessonId);
  const followUpsRef = useRef(followUps);
  followUpsRef.current = followUps;

  const load = useCallback(async () => {
    const v = await api.lesson(lessonId);
    setView(v);
    return v;
  }, [lessonId]);

  const advance = useCallback(async () => {
    setBusy(true);
    setError(null);
    const before = new Set(viewRef.current?.blocks.map((b) => b.id));
    liveArrived.current = false;
    try {
      const v = await api.advance(lessonId);
      applied.current++;
      setView(v);
      setGreet(null);
      // Content already shown live is being read: don't pull the page to it (the "Answer the question" jump offers the way).
      if (!liveArrived.current) setLanding(v.blocks.find((b) => !before.has(b.id) && b.type !== "feedback")?.id ?? null);
      const fresh = v.blocks.find((b) => !before.has(b.id) && b.type === "question");
      if (fresh) setAnnounce("A question is ready.");
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e);
        await load().catch(() => undefined);
      } else setError(new ApiError(0, "network", (e as Error).message));
    } finally {
      setBusy(false);
      setJob(null);
      previewRef.current.reset();
      qPreviewRef.current.reset();
    }
  }, [lessonId, load]);

  // While the page is open, the next step is prepared in the background (if enabled); leaving cancels it.
  useEffect(() => {
    api.prefetchLesson(lessonId).catch(() => undefined);
    return () => api.leaveLesson(lessonId);
  }, [lessonId]);

  // First open: start a fresh lesson, introduce a planned-but-unstarted one, or recap when resuming.
  useEffect(() => {
    load().then((v) => {
      if (!firstLoad.current) return;
      firstLoad.current = false;
      if (v.blocks.length === 0) advance();
      else if (v.blocks.some((b) => !GREETING_TYPES.has(b.type))) setGreet(v.recap ? "recap" : null);
      else if (!v.state.complete) setGreet("intro");
    }, (e) => setError(e));
  }, [load, advance]);

  // Bring the greeting (with its Continue button) into view once it has rendered.
  useEffect(() => {
    if (greet === "recap") greetRef.current?.scrollIntoView({ block: "center" });
    if (greet === "intro") requestAnimationFrame(() => greetRef.current && bringIntoView(greetRef.current, continueBtn.current, "nearest"));
  }, [greet]);

  // New content: start reading at its beginning (below the sticky header); a new question alone gets focus directly.
  useEffect(() => {
    if (!landing) return;
    setLanding(null);
    const el = document.getElementById(landing);
    if (el) bringIntoView(el, el.querySelector<HTMLElement>(".question") ?? el.querySelector<HTMLElement>("h1, h2") ?? el);
  }, [landing]);

  // Live progress of generation for this lesson.
  useJobEvents((ev) => {
    if (ev.lessonId !== lessonId) return;
    if (ev.status === "running") setJob({ id: ev.jobId, task: ev.task, chars: ev.chars ?? 0 });
    else setJob(null);
  });

  // A block committed while the lesson advances: show it now, replacing the live preview in place.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ lessonId?: string }>).detail?.lessonId !== lessonId) return;
      const before = new Set(viewRef.current?.blocks.map((b) => b.id));
      const at = applied.current;
      api.lesson(lessonId).then(
        (v) => {
          if (at !== applied.current) return; // the advance's own (newer) view already landed
          setView(v);
          const fresh = v.blocks.filter((b) => !before.has(b.id));
          if (!fresh.length) return;
          liveArrived.current = true;
          const explained = fresh.find((b) => b.type === "explanation");
          if (explained) {
            previewRef.current.reset();
            setAnnounce(`Explanation ready: ${explained.payload.title ?? ""}`);
          }
        },
        () => undefined,
      );
    };
    window.addEventListener(LESSON_EVENT, on);
    return () => window.removeEventListener(LESSON_EVENT, on);
  }, [lessonId]);

  const answer = useCallback(
    async (questionId: string, a: Answer) => {
      setAnswering(true);
      try {
        const v = await api.answer(lessonId, questionId, a);
        applied.current++;
        setView(v);
        setAnnounce("Your answer has been checked. Read the feedback, then choose what comes next.");
      } finally {
        setAnswering(false);
      }
    },
    [lessonId],
  );

  const skip = useCallback(async (conceptId: string) => {
    setBusy(true);
    setError(null);
    const before = new Set(viewRef.current?.blocks.map((b) => b.id));
    try {
      const v = await api.skipLessonConcept(lessonId, conceptId);
      applied.current++;
      setView(v);
      setGreet(null);
      const fresh = v.blocks.filter((b) => !before.has(b.id));
      setLanding(fresh.find((b) => b.type === "explanation" || b.type === "question")?.id ?? fresh.at(-1)?.id ?? null);
      setAnnounce("Set aside for now. Continuing with your lesson.");
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "network", (e as Error).message));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
      setJob(null);
      previewRef.current.reset();
      qPreviewRef.current.reset();
    }
  }, [lessonId, load]);

  // Cmd/Ctrl+Enter continues from anywhere (but not from behind an open dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".followup") || followUpsRef.current.answering) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && view && !view.state.pendingQuestionId && !view.state.complete && !busy && !answering && !document.querySelector("[aria-modal=true]")) advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, busy, answering, advance]);

  // Offer a jump to the current activity (the open question, else Continue) whenever it is out of view.
  const pendingBlockId = view?.blocks.find((b) => b.type === "question" && b.question?.id === view.state.pendingQuestionId)?.id ?? null;
  const current = pendingBlockId ?? (view && !view.state.complete ? "continue" : null);
  useEffect(() => {
    setOffscreen(null);
    const el = current === "continue" ? document.querySelector(".continue-bar") : current ? document.getElementById(current)?.querySelector(".question") : null;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const top = Math.round(document.querySelector(".topbar")?.getBoundingClientRect().height ?? 0);
    const io = new IntersectionObserver(([e]) => setOffscreen(e.isIntersecting ? null : e.boundingClientRect.top < top ? "above" : "below"), { rootMargin: `-${top}px 0px 0px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [current]);

  const conceptNames = useMemo(() => Object.fromEntries((view?.concepts ?? []).map((c) => [c.conceptId, c.name])), [view]);
  const feedbackFor = useMemo(() => {
    const m: Record<string, FeedbackInfo> = {};
    for (const b of view?.blocks ?? []) if (b.type === "feedback") m[b.payload.questionId] = b.payload;
    return m;
  }, [view]);
  const feedbackBlockFor = useMemo(() => {
    const m: Record<string, BlockView> = {};
    for (const b of view?.blocks ?? []) if (b.type === "feedback") m[b.payload.questionId] = b;
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
  const pendingQuestion = view.blocks.find((b) => b.type === "question" && b.question?.id === pending)?.question;
  const reviewing = pendingQuestion?.purpose === "review" || (!pending && view.nextAction === "review");
  const skipConceptId = reviewing ? pendingQuestion?.conceptId ?? view.state.reviewQueue[0] : view.state.conceptId;
  const canSkip = Boolean(skipConceptId) && !view.state.complete && !["advance", "return", "checkpoint", "complete", "stuck"].includes(view.nextAction) && view.blocks.some((b) => !GREETING_TYPES.has(b.type));
  const skipLabel = reviewing ? "Skip review" : view.state.detours ? "Skip prerequisite review" : "Skip this concept";
  const step = continuation(view);
  const started = view.blocks.some((b) => b.type === "question" && b.question?.attempt);
  const status = Object.fromEntries(view.concepts.map((c) => [c.conceptId, c.status]));
  const goToQuestion = (blockId: string | null) => {
    const el = blockId ? document.getElementById(blockId) : null;
    if (el) bringIntoView(el, el.querySelector<HTMLElement>(".question"));
  };

  const render = (b: BlockView) => {
    switch (b.type) {
      case "overview":
        return <OverviewBlock key={b.id} b={b} open={setSource} collapsed={started || narrow} />;
      case "plan":
        return <PlanBlock key={b.id} b={b} collapsed={started || narrow} />;
      case "explanation":
        return (
          <ExplanationBlock
            key={b.id}
            b={b}
            open={setSource}
            conceptName={conceptNames[b.conceptId!] ?? ""}
            footer={<FollowUpBox kind="lesson_block" targetId={b.id} thread={b.followUp} openSource={setSource} scope={lessonId} collapsible label="Ask a follow-up about this" />}
          />
        );
      case "question": {
        const fb = feedbackBlockFor[b.question!.id];
        return (
          <section className="block" id={b.id} key={b.id}>
            <QuestionCard question={b.question!} feedback={feedbackFor[b.question!.id]} onSubmit={(a) => answer(b.question!.id, a)} job={job} onCancelJob={(id) => void api.cancelJob(id)} />
            {fb && b.question!.attempt && (
              <FollowUpBox
                kind="lesson_block"
                targetId={fb.id}
                thread={fb.followUp}
                openSource={setSource}
                scope={lessonId}
                collapsible
                label="Ask a follow-up about this answer"
                placeholder="Why is that the answer? What did I mix up? Ask anything about this question before moving on…"
              />
            )}
            {b.refs.length > 0 && (
              <div className="provenance">
                Related source: {b.refs.map((r, i) => <RefChip key={i} r={r} open={setSource} />)}
              </div>
            )}
          </section>
        );
      }
      case "detour_start":
        return <DetourStartBlock key={b.id} b={b} />;
      case "detour_end":
        return <DetourEndBlock key={b.id} b={b} />;
      case "checkpoint":
        return <CheckpointBlock key={b.id} b={b} />;
      case "review":
        return <ReviewBlock key={b.id} b={b} active={false} onSkip={() => undefined} />;
      case "notice":
        return <NoticeBlock key={b.id} b={b} />;
      default:
        return null;
    }
  };

  // Sections the learner has moved past fold into a one-line history entry.
  const items = sections(view.blocks);
  const lastGroup = items.map((it) => it.kind).lastIndexOf("group");
  const renderItem = (it: Item, i: number) => {
    if (it.kind === "block") return render(it.b);
    const questions = it.blocks.filter((b) => b.type === "question").map((b) => b.question!);
    const done = i < lastGroup && questions.every((q) => (q.attempt || q.skipped) && q.id !== pending);
    if (!done) {
      // Inside the current section, finished rounds (each ending in feedback) fold too; the latest stays open.
      const fb = it.blocks.flatMap((b, j) => (b.type === "feedback" ? [j] : []));
      const cut = (it.blocks.at(-1)!.type === "feedback" ? fb.at(-2) : fb.at(-1)) ?? -1;
      const earlier = cut >= 0 ? it.blocks.slice(0, cut + 1) : [];
      const asked = earlier.filter((b) => b.type === "question").map((b) => b.question!);
      return (
        <Fragment key={it.blocks[0].id}>
          {asked.length > 0 && (
            <details className="history">
              <summary>
                <span className="kicker">Earlier in this section</span>{" "}
                <span className="muted small">
                  {asked.length} {asked.length === 1 ? "question" : "questions"}, {asked.filter((q) => q.attempt?.correct).length} correct
                </span>
              </summary>
              <div className="history-body">{earlier.map(render)}</div>
            </details>
          )}
          {(asked.length > 0 ? it.blocks.slice(cut + 1) : it.blocks).map(render)}
        </Fragment>
      );
    }
    const right = questions.filter((q) => q.attempt?.correct).length;
    return (
      <details className="history" key={`history-${it.blocks[0].id}`}>
        <summary>
          <span className="kicker">Earlier</span> <b>{conceptNames[it.conceptId] ?? "Section"}</b>{" "}
          {questions.length > 0 && (
            <span className="muted small">
              · {questions.length} {questions.length === 1 ? "question" : "questions"}, {right} correct
            </span>
          )}{" "}
          {status[it.conceptId] && <StatusBadge status={status[it.conceptId]} />}
        </summary>
        <div className="history-body">{it.blocks.map(render)}</div>
      </details>
    );
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
          {items.map(renderItem)}
          {busy && (
            <PendingStep
              explanation={preview}
              question={qPreview}
              task={job?.task ?? null}
              conceptNames={conceptNames}
            />
          )}
          <div className="sr-only" role="status">
            {announce}
          </div>

          {offscreen && !greet && pendingBlockId && (
            <button className="btn primary jump-question" onClick={() => goToQuestion(pendingBlockId)}>
              Answer the question <span aria-hidden>{offscreen === "below" ? "↓" : "↑"}</span>
            </button>
          )}
          {offscreen && !greet && current === "continue" && !busy && (
            <button
              className="btn primary jump-question"
              onClick={() => {
                const bar = document.querySelector<HTMLElement>(".continue-bar");
                if (bar) bringIntoView(bar, continueBtn.current, "nearest");
              }}
            >
              Go to current step <span aria-hidden>{offscreen === "below" ? "↓" : "↑"}</span>
            </button>
          )}

          {greet === "intro" && (
            <section className="recap intro" aria-labelledby="intro-title" ref={greetRef}>
              <div className="kicker">New lesson</div>
              <h2 id="intro-title">Ready to begin?</h2>
              <p>
                {nav.concept ? (
                  <>
                    We'll start with <b>{nav.concept}</b>
                  </>
                ) : (
                  "We'll start at the beginning"
                )}
                {nav.progress.total > 1 ? ` and work through ${nav.progress.total} concepts` : ""}, one short explanation and question at a time. Anything you already know is checked briefly and skipped, and “I don't know” is always a useful answer.
              </p>
              <p className="muted small">Choose Start lesson when you're ready.</p>
            </section>
          )}

          {greet === "recap" && view.recap && (
            <section className="recap" aria-label="Where you left off" ref={greetRef}>
              <div className="kicker">Welcome back · last active {new Date(view.recap.lastActive).toLocaleString()}</div>
              <ul>
                {view.recap.lines.map((l, i) => (
                  <li key={i}>
                    <Markdown text={l} inline />
                  </li>
                ))}
              </ul>
              {pending ? (
                <button
                  className="btn primary"
                  autoFocus
                  onClick={() => {
                    setGreet(null);
                    goToQuestion(view.recap!.anchorBlockId);
                  }}
                >
                  Continue: answer the open question
                </button>
              ) : !view.state.complete ? (
                <button className="btn primary" autoFocus onClick={advance} disabled={followUps.answering || answering}>
                  {step.label}
                </button>
              ) : null}
            </section>
          )}

          {(view.paused || (error && HELD.includes(error.code))) && <PausedBanner paused={view.paused} error={error} />}
          {error && !HELD.includes(error.code) && <ErrorBanner error={error} onRetry={advance} />}

          <div className="continue-bar">
            {busy ? (
              <div className="working" aria-live="polite">
                <span className="spinner" aria-hidden />
                <span>
                  {job ? `${WORKING[job.task] ?? "Working"}… ${job.chars > 0 ? `(${(job.chars / 1000).toFixed(1)}k characters)` : ""}` : "Thinking about what comes next…"}
                  <Elapsed />
                </span>
                {job && (
                  <button className="btn small ghost" onClick={() => api.cancelJob(job.id)}>
                    Cancel
                  </button>
                )}
              </div>
            ) : (canContinue || canSkip) && greet !== "recap" ? (
              <>
                <div className="lesson-actions">
                  {canContinue && <button ref={continueBtn} className="btn primary large" onClick={advance} disabled={followUps.answering || answering} aria-describedby="continue-wait">
                    {greet === "intro" ? "Start lesson" : step.label}
                  </button>}
                  {canSkip && <button className="btn" onClick={() => skip(skipConceptId!)} disabled={answering} aria-describedby="skip-help">{skipLabel} <span aria-hidden>→</span></button>}
                </div>
                <span className="hint" id="continue-wait">
                  {followUps.answering ? "Waiting for your follow-up answer…" : pending ? "Skipping sets this portion aside and takes you onward. Your progress stays saved." : `${step.hint} · ⌘/Ctrl + Enter`}
                </span>
                {canSkip && <span className="sr-only" id="skip-help">Sets this portion aside and continues onward. Your progress and follow-up questions stay saved.</span>}
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
      {panel && (
        <ProgressPanel
          view={view}
          onClose={() => setPanel(false)}
          open={(t) => {
            setPanel(false);
            setSource(t);
          }}
        />
      )}
    </>
  );
}

/**
 * Where the next step will appear, from the moment Continue is pressed: the explanation or the
 * question as it is written, or (once the wait is noticeable) a skeleton shaped like it. Prepared
 * content usually arrives at once, so nothing is drawn for the first moment.
 */
function PendingStep({
  explanation,
  question,
  task,
  conceptNames,
}: {
  explanation: ReturnType<typeof useLivePreview>;
  question: ReturnType<typeof useLivePreview>;
  task: string | null;
  conceptNames: Record<string, string>;
}) {
  const slow = useDelayed(true, 350);
  if (explanation.fields || explanation.revising) {
    return <ExplanationPreview fields={explanation.fields} revising={explanation.revising} conceptName={conceptNames[explanation.event?.conceptId ?? ""] ?? ""} />;
  }
  if (question.fields || question.revising || task === "question") {
    return (
      <section className="block">
        <QuestionPreview stem={question.fields?.stem} revising={question.revising} kicker={`Question${conceptNames[question.event?.conceptId ?? ""] ? ` · ${conceptNames[question.event!.conceptId!]}` : ""}`} />
      </section>
    );
  }
  // A visible job means a real wait (prepared content publishes nothing): its skeleton at once.
  if (task === "explain") return <ExplanationPreview fields={null} revising={false} conceptName={conceptNames[explanation.event?.conceptId ?? ""] ?? ""} />;
  if (!slow) return null;
  return <ExplanationPreview fields={null} revising={false} conceptName="" label="Next step" />;
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

const DIM: Record<string, [string, string]> = {
  recognition: ["Recognize", "Picking out the idea when you see it"],
  explanation: ["Explain", "Giving reasons that hold up"],
  application: ["Apply", "Using it on a concrete problem"],
  transfer: ["New setting", "Using it in an unfamiliar situation"],
  retention: ["Remember", "Recalling it in a later review"],
  calibration: ["Confidence", "How well your confidence matches your answers"],
};
const DIM_STATE: Record<string, string> = { positive: "shown", weak: "right, but not sure yet", negative: "recently missed", none: "not checked yet" };

function ProgressPanel({ view, onClose, open }: { view: LessonView; onClose: () => void; open: (t: SourceTarget) => void }) {
  return (
    <Modal label="Lesson progress" className="drawer" onClose={onClose}>
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
          A right answer is a start; understanding is shown over several questions. An idea counts as understood once you've recognized it and applied it with confidence. Central ideas also need to work in a new situation.
        </p>
        <details className="expand">
          <summary>What do these mean?</summary>
          <dl className="legend">
            <dt>
              <span className="badge central">Central</span>
            </dt>
            <dd>A main idea of this material. You'll also apply it in an unfamiliar situation.</dd>
            <dt>
              <span className="badge">Background</span>
            </dt>
            <dd>Supporting knowledge. Checked briefly first, and skipped if you already know it.</dd>
            <dt>
              <span className="badge optional">Optional</span>
            </dt>
            <dd>Deeper exploration you can leave out.</dd>
            {Object.entries(DIM).map(([d, [label, help]]) => (
              <div key={d} style={{ display: "contents" }}>
                <dt>
                  <span className="dim">{label}</span>
                </dt>
                <dd>{help}</dd>
              </div>
            ))}
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Green: shown. Amber: right, but not sure yet. Red: recently missed. Grey: not checked yet.
          </p>
        </details>
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
              <div className="small">{nextStep(c.status, c.reasons)}</div>
              <div className="dims">
                {Object.entries(c.dimensions).map(([d, s]) => (
                  <span key={d} className={`dim ${s}`} title={`${DIM[d]?.[1] ?? d}: ${DIM_STATE[s] ?? s}`}>
                    {DIM[d]?.[0] ?? d}
                    <span className="sr-only">: {DIM_STATE[s] ?? s}</span>
                  </span>
                ))}
                {c.ref && <RefChip r={{ sourceId: c.ref.sourceId, page: c.ref.page, label: c.ref.label }} open={open} />}
              </div>
              {c.status !== "demonstrated" && c.status !== "not_assessed" && <div className="small muted">{c.reasons.slice(0, 2).join(" · ")}</div>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

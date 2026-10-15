import { useCallback, useEffect, useId, useState, type DragEvent } from "react";
import { api, errorMessage, type CourseSummary } from "../api.ts";
import { PracticeArea } from "../components/PracticeSetup.tsx";
import { TopBar, useShell } from "../components/TopBar.tsx";
import { usePracticeLive } from "../practiceLive.ts";
import { useJobEvents, useLivePreview, type JobEvent } from "../liveJobs.ts";
import { PreviewMarkdown } from "../components/Markdown.tsx";
import { Elapsed, useDelayed } from "../components/Progress.tsx";

type LessonSummary = Awaited<ReturnType<typeof api.lessons>>[number];

const go = (lessonId: string) => (location.hash = `#/lesson/${lessonId}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const progressText = (done: number, total: number) => (total > 0 ? `${done} of ${plural(total, "concept")} completed` : "In progress");

/**
 * A lecture's first lesson waits for its one-time analysis (about two minutes with a real model):
 * say so honestly, and show the analysis's title and overview as they are written.
 */
function LectureReading({ lectureId }: { lectureId: string }) {
  const match = (ev: JobEvent) => ev.task === "analyze_source" && ev.lectureId === lectureId;
  const live = useLivePreview(match);
  const [reading, setReading] = useState(false);
  useJobEvents((ev) => match(ev) && ev.status === "running" && setReading(true));
  // A lecture read before opens at once: only speak up when it is actually being read (or opening is slow).
  const slow = useDelayed(true, 1200);
  if (!reading && !slow) return null;
  return (
    <div className="reading-status" role="status" aria-live="polite">
      <p className="working">
        <span className="spinner" aria-hidden />
        <span>
          {reading ? "Reading the lecture… (one time, about 2 min)" : "Opening the lesson…"}
          <Elapsed />
        </span>
      </p>
      {live.revising && <p className="muted small">Revising the analysis…</p>}
      {live.fields && (live.fields.title || live.fields.overview) && (
        <div className="overview-preview" aria-live="off">
          {live.fields.title && <b>{live.fields.title}</b>}
          {live.fields.overview && <PreviewMarkdown text={live.fields.overview} />}
        </div>
      )}
    </div>
  );
}

/** An inline, persistent error. Stays until the next attempt succeeds, so it can't be missed like a toast. */
function FormError({ id, message }: { id?: string; message: string | null }) {
  return message ? (
    <p className="form-error" id={id} role="alert">
      {message}
    </p>
  ) : null;
}

export function HomePage() {
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [due, setDue] = useState(0);
  const [newCourse, setNewCourse] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [objectiveError, setObjectiveError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const ids = useId();

  const refresh = useCallback(() => {
    setLoadError(null);
    api.courses().then(setCourses, (e) => setLoadError(errorMessage(e)));
    api.lessons().then(setLessons, (e) => setLoadError(errorMessage(e)));
    api.review().then((r) => setDue(r.filter((x) => x.due).length)).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  // Practice sets fill in while their documents are read: follow progress events, and poll slowly in case one is missed.
  const extracting = Boolean(courses?.some((c) => c.practice?.some((p) => p.status === "extracting")));
  usePracticeLive(() => api.courses().then(setCourses, () => undefined), { match: (ev) => !ev.stepId, pollMs: extracting ? 10_000 : null });

  /** Rejects with the server's message so the course card can show it inline. */
  const startLecture = async (lectureId: string) => {
    setStarting(lectureId);
    try {
      go((await api.startLecture(lectureId)).lessonId);
    } finally {
      setStarting(null);
    }
  };
  const startObjective = async () => {
    if (!objective.trim() || starting) return;
    setStarting("objective");
    setObjectiveError(null);
    try {
      go((await api.startObjective(objective.trim())).lessonId);
    } catch (e) {
      setObjectiveError(errorMessage(e));
    } finally {
      setStarting(null);
    }
  };
  const createCourse = async () => {
    if (!newCourse.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createCourse(newCourse.trim());
      setNewCourse("");
      refresh();
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const recent = lessons.find((l) => !l.complete);

  return (
    <>
      <TopBar />
      <main className="page home">
        <h1>What would you like to learn?</h1>

        {recent && (
          <section className="card" style={{ marginBottom: "1.5rem" }} aria-labelledby={`${ids}-recent`}>
            <div className="kicker">Continue where you left off</div>
            <div className="row" style={{ marginTop: "0.3rem" }}>
              <div className="grow">
                <h2 style={{ margin: 0 }} id={`${ids}-recent`}>
                  {recent.title}
                </h2>
                <div className="muted small">
                  Concept {Math.min(recent.progress.index + 1, recent.progress.total)} of {recent.progress.total} · last active {new Date(recent.updatedAt).toLocaleString()}
                </div>
              </div>
              <button className="btn primary large" onClick={() => go(recent.id)} autoFocus>
                Continue
              </button>
            </div>
          </section>
        )}

        {due > 0 && (
          <a className="banner warn" href="#/review" style={{ textDecoration: "none", color: "inherit", marginBottom: "1.5rem" }}>
            <span>
              <b>{plural(due, "concept")} due for review.</b> A few minutes of retrieval practice keeps them from fading.
            </span>
          </a>
        )}

        <div className="grid">
          <section className="card choice" aria-labelledby={`${ids}-upload`}>
            <h2 id={`${ids}-upload`}>Upload course material</h2>
            <p className="muted small">Create a course, then add lecture PDFs or PowerPoint files. Lessons follow your material and point back to the exact slide.</p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                createCourse();
              }}
            >
              <input
                type="text"
                placeholder="e.g. Probabilistic Models"
                value={newCourse}
                onChange={(e) => setNewCourse(e.target.value)}
                aria-label="Course title"
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? `${ids}-create-error` : undefined}
                className="grow"
              />
              <button className="btn" type="submit" disabled={creating} aria-busy={creating}>
                {creating ? "Creating…" : "Create"}
              </button>
            </form>
            <FormError id={`${ids}-create-error`} message={createError} />
          </section>

          <section className="card choice" aria-labelledby={`${ids}-goal`}>
            <h2 id={`${ids}-goal`}>Start with a learning goal</h2>
            <p className="muted small">No document needed. The lesson starts with a short check of the foundations it relies on; anything you've already demonstrated is skipped.</p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                startObjective();
              }}
            >
              <input
                type="text"
                placeholder="e.g. second-order Markov models"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                aria-label="Learning objective"
                aria-invalid={objectiveError ? true : undefined}
                aria-describedby={objectiveError ? `${ids}-goal-error` : undefined}
                className="grow"
              />
              <button className="btn primary" type="submit" disabled={starting === "objective"} aria-busy={starting === "objective"}>
                {starting === "objective" ? "Planning…" : "Plan lesson"}
              </button>
            </form>
            <FormError id={`${ids}-goal-error`} message={objectiveError} />
          </section>
        </div>

        <h2 className="section-title">Your courses</h2>
        {loadError && (
          <div className="banner bad" role="alert" style={{ marginBottom: "1rem" }}>
            <span className="grow">
              <b>Couldn't load your courses.</b> {loadError}
            </span>
            <button className="btn small" onClick={refresh}>
              Retry
            </button>
          </div>
        )}
        {courses === null ? (
          !loadError && (
            <p className="working" role="status">
              <span className="spinner" aria-hidden="true" /> Loading courses…
            </p>
          )
        ) : courses.length === 0 ? (
          <p className="muted">No courses yet. Create one above, then add your lecture files to it.</p>
        ) : (
          <div className="grid">
            {courses.map((c) => (
              <CourseCard key={c.id} course={c} onStart={startLecture} starting={starting} onChange={refresh} />
            ))}
          </div>
        )}

        {lessons.length > 0 && (
          <>
            <h2 className="section-title">All lessons</h2>
            <section className="card">
              {lessons.map((l) => (
                <div className="lecture-row" key={l.id}>
                  <a className="title" href={`#/lesson/${l.id}`}>
                    {l.title}
                  </a>
                  <span className="muted small">{l.complete ? "Complete" : progressText(l.progress.index, l.progress.total)}</span>
                </div>
              ))}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function CourseCard({ course, onStart, starting, onChange }: { course: CourseSummary; onStart: (id: string) => Promise<void>; starting: string | null; onChange: () => void }) {
  const { toast } = useShell();
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [folder, setFolder] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  /** Runs a card action, keeping any failure visible on the card until the next attempt. */
  const attempt = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const upload = (files: FileList | File[]) =>
    attempt(async () => {
      if (importing) return;
      setImporting(true);
      try {
        for (const f of Array.from(files)) {
          const r = await api.importFile(course.id, f);
          toast(r.status === "unchanged" ? `${f.name}: unchanged, nothing reprocessed` : r.status === "updated" ? `${f.name}: new version imported; history kept` : `${f.name}: imported`);
        }
      } finally {
        setImporting(false);
        onChange();
      }
    });
  const move = (i: number, d: -1 | 1) =>
    attempt(async () => {
      const order = course.lectures.map((l) => l.id);
      const j = i + d;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      await api.reorderLectures(course.id, order);
      onChange();
    });

  return (
    <section className="card course-card" aria-labelledby={`${ids}-title`}>
      <header className="course-head">
        <h3 id={`${ids}-title`}>{course.title}</h3>
        {course.lectures.length > 0 && (
          <button className="btn small ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing} aria-label={editing ? `Done editing ${course.title}` : `Edit ${course.title}`}>
            {editing ? "Done" : "Edit"}
          </button>
        )}
      </header>
      {course.lectures.length === 0 && <p className="muted small">No lectures yet. Add PDF or PowerPoint files below.</p>}
      {course.lectures.map((l, i) => {
        const status = l.lesson ? (l.lesson.complete ? "Complete" : progressText(l.lesson.pathIndex, l.lesson.pathLength)) : "Not started";
        return (
          <div className="lecture-row" key={l.id}>
            <div className="lecture-main">
              <span className="title" id={`${ids}-l${i}`}>
                {i + 1}. {l.title}
                {l.source && l.source.version > 1 && <span className="badge" style={{ marginLeft: 6 }}>v{l.source.version}</span>}
              </span>
              <span className="muted small">
                {status}
                {editing && l.source && ` · ${l.source.filename}`}
              </span>
            </div>
            {editing && (
              <span className="reorder">
                <button className="btn small ghost" onClick={() => move(i, -1)} aria-label={`Move ${l.title} earlier`} disabled={i === 0}>
                  ↑
                </button>
                <button className="btn small ghost" onClick={() => move(i, 1)} aria-label={`Move ${l.title} later`} disabled={i === course.lectures.length - 1}>
                  ↓
                </button>
              </span>
            )}
            <button className="btn small primary" onClick={() => attempt(() => onStart(l.id))} disabled={starting === l.id} aria-describedby={`${ids}-l${i}`}>
              {starting === l.id ? "Reading…" : l.lesson ? (l.lesson.complete ? "Revisit" : "Continue") : "Start"}
            </button>
            {starting === l.id && (
              <div style={{ flexBasis: "100%" }}>
                <LectureReading lectureId={l.id} />
              </div>
            )}
          </div>
        );
      })}
      <PracticeArea course={course} onChange={onChange} />
      <label
        className={`dropzone ${over ? "over" : ""}`}
        style={{ display: "block", marginTop: "0.8rem", cursor: "pointer" }}
        aria-busy={importing}
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer.files);
        }}
      >
        {importing ? "Importing…" : "Drop PDF / PPTX files here, or click to choose"}
        <input type="file" accept=".pdf,.pptx" multiple className="sr-only" disabled={importing} onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) upload(files);
          }}
        />
      </label>
      {(editing || course.lectures.length === 0) && (
        <form
          className="row"
          style={{ marginTop: "0.6rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!folder.trim() || importing) return;
            attempt(async () => {
              setImporting(true);
              try {
                const r = await api.importFolder(course.id, folder.trim());
                toast(`${r.length} file(s): ${r.filter((x) => x.status !== "unchanged").length} new or updated`);
                onChange();
              } finally {
                setImporting(false);
              }
            });
          }}
        >
          <input type="text" placeholder="…or a local lecture folder path" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Lecture folder path" className="grow" />
          <button className="btn small" type="submit" disabled={importing}>
            Import folder
          </button>
        </form>
      )}
      <FormError message={error} />
    </section>
  );
}

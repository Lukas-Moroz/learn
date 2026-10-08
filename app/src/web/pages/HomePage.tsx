import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api, ApiError, type CourseSummary } from "../api.ts";
import { TopBar, useShell } from "../components/TopBar.tsx";

type LessonSummary = Awaited<ReturnType<typeof api.lessons>>[number];

export function HomePage() {
  const { toast } = useShell();
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [due, setDue] = useState(0);
  const [newCourse, setNewCourse] = useState("");
  const [objective, setObjective] = useState("");
  const [starting, setStarting] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.courses().then(setCourses);
    api.lessons().then(setLessons);
    api.review().then((r) => setDue(r.filter((x) => x.due).length)).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);

  const go = (lessonId: string) => (location.hash = `#/lesson/${lessonId}`);
  const startLecture = async (lectureId: string) => {
    setStarting(lectureId);
    try {
      go((await api.startLecture(lectureId)).lessonId);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };
  const startObjective = async () => {
    if (!objective.trim()) return;
    setStarting("objective");
    try {
      go((await api.startObjective(objective.trim())).lessonId);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };

  const recent = lessons.find((l) => !l.complete);

  return (
    <>
      <TopBar />
      <main className="page">
        {recent && (
          <section className="card" style={{ marginBottom: "1.5rem" }}>
            <div className="kicker">Continue where you left off</div>
            <div className="row" style={{ marginTop: "0.3rem" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <h2 style={{ margin: 0 }}>{recent.title}</h2>
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
              <b>{due} concept{due === 1 ? "" : "s"} due for review.</b> A few minutes of retrieval practice keeps them from fading.
            </span>
          </a>
        )}

        <div className="section-title">Courses</div>
        <div className="grid">
          {courses?.map((c) => <CourseCard key={c.id} course={c} onStart={startLecture} starting={starting} onChange={refresh} />)}
          <section className="card">
            <h3 style={{ marginTop: 0 }}>New course</h3>
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newCourse.trim()) return;
                await api.createCourse(newCourse.trim());
                setNewCourse("");
                refresh();
              }}
            >
              <input type="text" placeholder="e.g. Probabilistic Models" value={newCourse} onChange={(e) => setNewCourse(e.target.value)} aria-label="Course title" style={{ flex: 1 }} />
              <button className="btn" type="submit">
                Create
              </button>
            </form>
          </section>
        </div>

        <div className="section-title">Learn something without a document</div>
        <section className="card">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              startObjective();
            }}
          >
            <input type="text" placeholder="What do you want to understand? e.g. second-order Markov models" value={objective} onChange={(e) => setObjective(e.target.value)} aria-label="Learning objective" style={{ flex: 1, minWidth: 220 }} />
            <button className="btn primary" type="submit" disabled={starting === "objective"}>
              {starting === "objective" ? "Planning…" : "Start"}
            </button>
          </form>
          <p className="muted small" style={{ marginBottom: 0 }}>
            The lesson starts with a short check of the foundations it relies on. Anything you've already demonstrated is skipped.
          </p>
        </section>

        {lessons.length > 0 && (
          <>
            <div className="section-title">All lessons</div>
            <section className="card">
              {lessons.map((l) => (
                <div className="lecture-row" key={l.id}>
                  <a className="title" href={`#/lesson/${l.id}`}>
                    {l.title}
                  </a>
                  <span className="muted small">{l.complete ? "Complete" : `${l.progress.index}/${l.progress.total}`}</span>
                </div>
              ))}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function CourseCard({ course, onStart, starting, onChange }: { course: CourseSummary; onStart: (id: string) => void; starting: string | null; onChange: () => void }) {
  const { toast } = useShell();
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [folder, setFolder] = useState("");

  const upload = async (files: FileList | File[]) => {
    setImporting(true);
    try {
      for (const f of Array.from(files)) {
        const r = await api.importFile(course.id, f);
        toast(r.status === "unchanged" ? `${f.name}: unchanged, nothing reprocessed` : r.status === "updated" ? `${f.name}: new version imported; history kept` : `${f.name}: imported`);
      }
      onChange();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };
  const move = async (i: number, d: -1 | 1) => {
    const ids = course.lectures.map((l) => l.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.reorderLectures(course.id, ids);
    onChange();
  };

  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>{course.title}</h3>
      {course.lectures.length === 0 && <p className="muted small">No lectures yet. Import PDFs or PowerPoint files below.</p>}
      {course.lectures.map((l, i) => {
        const pct = l.lesson ? (l.lesson.complete ? "Complete" : `${l.lesson.pathIndex}/${l.lesson.pathLength}`) : null;
        return (
          <div className="lecture-row" key={l.id}>
            <span className="muted small" style={{ width: "1.5rem" }}>
              {i + 1}.
            </span>
            <span className="title" title={l.source?.filename}>
              {l.title}
              {l.source && l.source.version > 1 && <span className="badge" style={{ marginLeft: 6 }}>v{l.source.version}</span>}
            </span>
            {pct && <span className="muted small">{pct}</span>}
            <button className="btn small ghost" onClick={() => move(i, -1)} aria-label={`Move ${l.title} earlier`} disabled={i === 0}>
              ↑
            </button>
            <button className="btn small ghost" onClick={() => move(i, 1)} aria-label={`Move ${l.title} later`} disabled={i === course.lectures.length - 1}>
              ↓
            </button>
            <button className="btn small primary" onClick={() => onStart(l.id)} disabled={starting === l.id}>
              {starting === l.id ? "Reading…" : l.lesson ? (l.lesson.complete ? "Review" : "Continue") : "Start"}
            </button>
          </div>
        );
      })}
      <label
        className={`dropzone ${over ? "over" : ""}`}
        style={{ display: "block", marginTop: "0.8rem", cursor: "pointer" }}
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
        <input type="file" accept=".pdf,.pptx" multiple className="sr-only" onChange={(e) => e.target.files && upload(e.target.files)} />
      </label>
      <form
        className="row"
        style={{ marginTop: "0.6rem" }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!folder.trim()) return;
          setImporting(true);
          try {
            const r = await api.importFolder(course.id, folder.trim());
            toast(`${r.length} file(s): ${r.filter((x) => x.status !== "unchanged").length} new or updated`);
            onChange();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : String(err));
          } finally {
            setImporting(false);
          }
        }}
      >
        <input type="text" placeholder="…or a local lecture folder path" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Lecture folder path" style={{ flex: 1 }} />
        <button className="btn small" type="submit">
          Import folder
        </button>
      </form>
    </section>
  );
}

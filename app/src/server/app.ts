import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { lessonToMarkdown } from "../shared/markdown-export.ts";
import { slugify } from "../shared/slug.ts";
import { APP_DIR, type AppContext } from "./context.ts";
import { importFile, importFolder } from "./ingest/import.ts";
import { ProviderError, type ProviderId } from "./providers/types.ts";
import { answerReview, reviewQueue } from "./teaching/review.ts";
import { lessonView } from "./teaching/view.ts";
import { computeMastery } from "../shared/mastery.ts";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
/** Handlers return a JSON-able value (or write the response themselves and return undefined). */
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res))
    .then((value) => {
      if (!res.headersSent) value === undefined ? res.status(204).end() : res.json(value);
    })
    .catch(next);
};

export function createApp(ctx: AppContext) {
  const app = express();
  const { repo, engine, router, practice } = ctx;

  // Local-only server without accounts. Two cheap guards against other websites
  // driving it: the Host must be loopback (blocks DNS rebinding), and mutating API
  // calls must carry a custom header, which cross-origin pages cannot send without
  // a CORS preflight that this server never approves.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host && !["127.0.0.1", "localhost", "[::1]"].includes(host)) return res.status(403).send("Forbidden host");
    if (req.path.startsWith("/api/") && req.method !== "GET" && req.headers["x-learn"] !== "1") {
      return res.status(403).json({ error: { code: "forbidden", message: "Missing x-learn header" } });
    }
    next();
  });
  app.use("/api", express.json({ limit: "2mb" }));

  const view = (lessonId: string) => {
    const lesson = repo.getLesson(lessonId);
    if (!lesson) throw Object.assign(new Error("Lesson not found"), { status: 404 });
    return { ...lessonView(engine, lesson), paused: router.paused };
  };

  // ── Status & providers ──
  app.get("/api/status", wrap(async () => ({ ...(await router.statuses()), generation: { prefetch: engine.prefetch.enabled() }, dataDir: ctx.dataDir })));
  // Generation preferences. "prefetch": prepare the next lesson step in the background (default on).
  app.patch("/api/settings/generation", wrap((req) => {
    if (typeof req.body.prefetch === "boolean") {
      repo.setSetting("generation", { ...repo.getSetting<object>("generation", {}), prefetch: req.body.prefetch });
      if (!req.body.prefetch) engine.prefetch.cancelAll();
    }
    return { prefetch: engine.prefetch.enabled() };
  }));
  app.patch("/api/settings/providers", wrap((req) => router.updateSettings({
    ...(req.body.primary ? { primary: req.body.primary as ProviderId } : {}),
    ...(typeof req.body.claudeFallback === "boolean" ? { claudeFallback: req.body.claudeFallback } : {}),
  })));
  app.put("/api/settings/openai-model", wrap((req) => (repo.setSetting("openai.model", String(req.body.model)), { ok: true })));
  app.put("/api/settings/claude-model", wrap((req) => (repo.setSetting("claude.model", String(req.body.model)), { ok: true })));
  app.get("/api/providers/openai/models", wrap(() => ctx.openai.listModels()));
  app.post("/api/providers/openai/signin", wrap(() => {
    // Opens the system browser; completes in the background. The UI polls /api/status.
    ctx.openai.signIn().then(
      () => (router.resume(), practice.resume(), ctx.followUps.resume(), ctx.bus.publish({ type: "provider" })),
      (e) => ctx.bus.publish({ type: "provider", error: e instanceof ProviderError ? e.toJSON() : String(e) }),
    );
    return { started: true };
  }));
  app.post("/api/providers/openai/cancel", wrap(() => (ctx.openai.cancelSignIn(), { ok: true })));
  app.post("/api/providers/openai/disconnect", wrap(async () => (await ctx.openai.disconnect(), { ok: true })));
  app.post("/api/providers/resume", wrap(() => {
    router.resume();
    practice.resume(); // written practice answers, warm-ups and coaching that waited for a provider
    ctx.followUps.resume(); // follow-up questions that waited for a provider
    return { ok: true };
  }));
  app.post("/api/jobs/:id/cancel", wrap((req) => ({ cancelled: ctx.gen.cancel(String(req.params.id)) })));

  // ── Courses, lectures, sources ──
  app.get("/api/courses", wrap(() =>
    repo.listCourses().map((c) => ({
      ...c,
      lectures: repo.listLectures(c.id).map((l) => {
        const lesson = repo.listLessons().find((x) => x.lecture_id === l.id);
        const src = l.document_id ? repo.latestSource(l.document_id) : undefined;
        return {
          ...l,
          source: src ? { id: src.id, filename: src.filename, pageCount: src.page_count, unit: src.unit, version: src.version } : null,
          lesson: lesson ? { id: lesson.id, complete: lesson.state.complete, updatedAt: lesson.updated_at, pathIndex: lesson.state.pathIndex, pathLength: lesson.state.path.length } : null,
        };
      }),
      practice: practice.summaries(c.id),
    })),
  ));
  app.post("/api/courses", wrap((req) => {
    const title = String(req.body.title ?? "").trim();
    if (!title) throw Object.assign(new Error("Course title is required"), { status: 400 });
    return repo.createCourse(title);
  }));
  app.post(
    "/api/courses/:id/import",
    express.raw({ type: "application/octet-stream", limit: "200mb" }),
    wrap(async (req) => {
      const courseId = String(req.params.id);
      if (!repo.getCourse(courseId)) throw Object.assign(new Error("Course not found"), { status: 404 });
      const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "upload.pdf"));
      const r = await importFile(repo, ctx.dataDir, { courseId, data: new Uint8Array(req.body as Buffer), filename });
      return { status: r.status, lectureId: r.lecture.id, sourceId: r.source.id, version: r.source.version };
    }),
  );
  app.post("/api/courses/:id/import-folder", wrap(async (req) => {
    const results = await importFolder(repo, ctx.dataDir, String(req.params.id), String(req.body.path ?? ""));
    return results.map((r) => ({ file: r.source.filename, status: r.status, lectureId: r.lecture.id }));
  }));
  app.put("/api/courses/:id/lecture-order", wrap((req) => (repo.reorderLectures(String(req.params.id), req.body.ids as string[]), { ok: true })));
  app.patch("/api/lectures/:id", wrap((req) => (repo.renameLecture(String(req.params.id), String(req.body.title)), { ok: true })));
  app.post("/api/lectures/:id/lesson", wrap(async (req) => {
    const lesson = await engine.startLectureLesson(String(req.params.id));
    engine.prefetch.schedule(lesson.id); // the first explanation or question, while the page opens
    return { lessonId: lesson.id };
  }));

  app.get("/api/sources/:id/pages/:page", wrap((req) => {
    const id = String(req.params.id);
    const page = Number(req.params.page);
    const s = repo.getSource(id);
    const text = repo.getPage(id, page);
    if (!s || text === undefined) throw Object.assign(new Error("Page not found"), { status: 404 });
    return { sourceId: id, page, text, unit: s.unit, pageCount: s.page_count, kind: s.kind, filename: s.filename };
  }));
  app.get("/api/sources/:id/file", (req, res) => {
    const s = repo.getSource(String(req.params.id));
    if (!s || !existsSync(s.stored_path)) return res.status(404).end();
    res.type(s.kind === "pdf" ? "application/pdf" : "application/octet-stream").send(readFileSync(s.stored_path));
  });

  // ── Lessons ──
  app.get("/api/lessons", wrap(() =>
    repo.listLessons().map((l) => ({ id: l.id, title: l.title, objective: l.objective, lectureId: l.lecture_id, courseId: l.course_id, complete: l.state.complete, updatedAt: l.updated_at, progress: { index: l.state.pathIndex, total: l.state.path.length } })),
  ));
  app.post("/api/lessons", wrap(async (req) => {
    const objective = String(req.body.objective ?? "").trim();
    if (!objective) throw Object.assign(new Error("Describe what you want to learn"), { status: 400 });
    const lesson = await engine.startObjectiveLesson(objective, req.body.courseId ?? null);
    engine.prefetch.schedule(lesson.id);
    return { lessonId: lesson.id };
  }));
  app.get("/api/lessons/:id", wrap((req) => view(String(req.params.id))));
  app.post("/api/lessons/:id/advance", wrap(async (req) => {
    const id = String(req.params.id);
    await engine.processPendingReasoning().catch(() => 0);
    // With prefetch on, an explanation ends the step: its question is prepared while it is read.
    await engine.advance(id, { pauseAfterExplanation: engine.prefetch.enabled() });
    engine.prefetch.schedule(id);
    return view(id);
  }));
  app.post("/api/lessons/:id/answer", wrap(async (req) => {
    const id = String(req.params.id);
    const { questionId, ...attempt } = req.body;
    await engine.answer(id, String(questionId), attempt);
    engine.prefetch.schedule(id); // what follows this answer is now determined
    return view(id);
  }));
  app.post("/api/lessons/:id/skip-review", wrap(async (req) => {
    const id = String(req.params.id);
    await engine.skipReview(id);
    engine.prefetch.schedule(id);
    return view(id);
  }));
  app.post("/api/lessons/:id/skip", wrap(async (req) => {
    const id = String(req.params.id);
    const conceptId = String(req.body?.conceptId ?? "");
    if (!conceptId) throw Object.assign(new Error("Choose the concept to skip"), { status: 400 });
    await engine.skipConcept(id, conceptId);
    await engine.advance(id, { pauseAfterExplanation: engine.prefetch.enabled() });
    engine.prefetch.schedule(id);
    return view(id);
  }));
  // The lesson page opened (prepare what Continue will need) or closed (cancel what was prepared).
  app.post("/api/lessons/:id/prefetch", wrap((req) => (engine.prefetch.schedule(String(req.params.id)), { ok: true })));
  app.post("/api/lessons/:id/leave", wrap((req) => ({ cancelled: engine.prefetch.cancel(String(req.params.id)) })));
  app.get("/api/lessons/:id/export.md", wrap((req, res) => {
    const v = view(String(req.params.id));
    const md = lessonToMarkdown(v);
    const dir = join(ctx.dataDir, "exports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slugify(v.lesson.title) || "lesson"}.md`);
    writeFileSync(file, md);
    res.type("text/markdown").setHeader("x-export-path", file);
    res.send(md);
    return undefined;
  }));

  // ── Exam practice ──
  app.get("/api/courses/:id/practice", wrap((req) => practice.listSets(String(req.params.id))));
  app.get("/api/courses/:id/practice/candidates", wrap((req) => practice.candidates(String(req.params.id))));
  app.post("/api/courses/:id/practice", wrap((req) => practice.create(String(req.params.id), req.body ?? {})));
  app.get("/api/practice/problems/:problemId", wrap((req) => practice.getProblem(String(req.params.problemId))));
  app.post("/api/practice/problems/:problemId/primer", wrap((req) => practice.startPrimer(String(req.params.problemId))));
  app.post("/api/practice/problems/:problemId/primer/skip", wrap((req) => practice.skipPrimer(String(req.params.problemId))));
  app.post("/api/practice/problems/:problemId/primer/:index/answer", wrap((req) => practice.answerProbe(String(req.params.problemId), req.params.index, req.body ?? {})));
  app.post("/api/practice/steps/:stepId/coach", wrap((req) => practice.coach(String(req.params.stepId))));
  app.post("/api/practice/coaching/:coachingId/check", wrap((req) => practice.answerCheck(String(req.params.coachingId), req.body ?? {})));
  app.post("/api/practice/problems/:problemId/learn", wrap((req) => practice.learn(String(req.params.problemId), req.body?.conceptId)));
  app.post("/api/practice/steps/:stepId/attempt", wrap((req) => practice.attempt(String(req.params.stepId), req.body ?? {})));
  app.post("/api/practice/steps/:stepId/reveal", wrap((req) => practice.reveal(String(req.params.stepId))));
  app.post("/api/practice/steps/:stepId/skip", wrap((req) => practice.skip(String(req.params.stepId))));
  app.post("/api/practice/attempts/:attemptId/override", wrap((req) => practice.override(String(req.params.attemptId))));
  app.get("/api/practice/:setId", wrap((req) => practice.getSet(String(req.params.setId))));
  app.post("/api/practice/:setId/retry", wrap((req) => practice.retry(String(req.params.setId))));
  app.delete("/api/practice/:setId", wrap((req) => practice.delete(String(req.params.setId))));

  // ── Follow-up questions (practice steps, coaching rounds, lesson blocks) ──
  app.post("/api/follow-ups", wrap((req) => ctx.followUps.ask(req.body ?? {})));
  app.get("/api/follow-ups/:threadId", wrap((req) => ctx.followUps.thread(String(req.params.threadId))));
  app.post("/api/follow-ups/turns/:turnId/retry", wrap((req) => ctx.followUps.retry(String(req.params.turnId))));

  // ── Review & concept graph ──
  app.get("/api/review", wrap(() => reviewQueue(repo)));
  app.post("/api/review/:questionId/answer", wrap((req) => answerReview(repo, String(req.params.questionId), req.body)));
  app.get("/api/concepts", wrap(() => ({
    concepts: repo.listConcepts().map((c) => ({
      ...c,
      contexts: repo.contextsFor(c.id),
      mastery: computeMastery(c.id, repo.evidenceFor(c.id), { central: false, activeMisconceptions: repo.activeMisconceptions(c.id), now: new Date() }),
      misconceptions: repo.misconceptions(c.id),
    })),
    edges: repo.edges(),
  })));

  // ── Live progress (SSE) ──
  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    const off = ctx.bus.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  });

  // ── Client ──
  const webDir = join(APP_DIR, "dist", "web");
  if (existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(webDir, "index.html")));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ProviderError) {
      return res.status(err.code === "usage_limit" || err.code === "billing_risk" ? 429 : 503).json({ error: err.toJSON(), paused: router.paused });
    }
    if (err instanceof ZodError) return res.status(400).json({ error: { code: "invalid_input", message: err.issues.map((i) => i.message).join("; ") } });
    const status = err?.status ?? 400;
    res.status(status).json({ error: { code: "error", message: String(err?.message ?? err) } });
  });
  return app;
}

// Runs one AI task end to end: job row → stream → parse → validate → (repair) → result.
// Invariant: nothing is returned (and so nothing is committed by callers) unless the
// provider signalled completion AND the output validated. Partial text stays in the job row.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import type { ProviderRouter } from "../providers/router.ts";
import { ProviderError, type ChatMessage } from "../providers/types.ts";
import { buildPrompt, extractJson, PROMPT_VERSION, TASK_SCHEMAS, type Task } from "./prompts.ts";

export interface GenerateOptions<T> {
  lessonId?: string | null;
  /** Extra deterministic validation (e.g. repetition checks). Return a problem to request a revision. */
  check?: (value: T) => string | null;
  /** Cache key material; omit to never cache (questions are never cached). */
  cacheKey?: unknown;
  maxRepairs?: number;
  signal?: AbortSignal;
}

export class Generator {
  private controllers = new Map<string, AbortController>();

  constructor(
    private readonly repo: Repo,
    private readonly router: ProviderRouter,
    private readonly bus: EventBus,
  ) {}

  cancel(jobId: string): boolean {
    const c = this.controllers.get(jobId);
    c?.abort();
    return Boolean(c);
  }

  /** Cancel every running job for a lesson (e.g. the user navigated away). */
  cancelLesson(lessonId: string) {
    for (const job of this.repo.jobsForLesson(lessonId)) if (job.status === "running") this.cancel(job.id);
  }

  async run<K extends Task>(task: K, input: unknown, opts: GenerateOptions<z.infer<(typeof TASK_SCHEMAS)[K]>> = {}) {
    type T = z.infer<(typeof TASK_SCHEMAS)[K]>;
    const schema = TASK_SCHEMAS[task] as unknown as z.ZodType<T>;
    const key = opts.cacheKey !== undefined ? hash([PROMPT_VERSION[task], opts.cacheKey]) : null;
    if (key) {
      const hit = this.repo.cacheGet(key);
      if (hit !== undefined) {
        const parsed = schema.safeParse(hit);
        if (parsed.success && !opts.check?.(parsed.data)) return parsed.data;
      }
    }

    const { instructions, user } = buildPrompt(task, input);
    const messages: ChatMessage[] = [{ role: "user", content: user }];
    const maxRepairs = opts.maxRepairs ?? 2;

    for (let attempt = 0; ; attempt++) {
      const job = this.repo.createJob(opts.lessonId ?? null, task, null);
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
      let text = "";
      let lastSave = 0;
      this.bus.publish({ type: "job", lessonId: opts.lessonId, jobId: job.id, task, status: "running", chars: 0 });
      let raw: string;
      let provider: string;
      try {
        const res = await this.router.stream({
          task,
          instructions,
          messages,
          signal,
          onDelta: (d) => {
            text += d;
            const t = Date.now();
            if (t - lastSave > 400) {
              lastSave = t;
              this.repo.savePartial(job.id, text);
              this.bus.publish({ type: "job", lessonId: opts.lessonId, jobId: job.id, task, status: "running", chars: text.length });
            }
          },
        });
        raw = res.text;
        provider = res.provider;
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message, true);
        this.repo.savePartial(job.id, text);
        this.repo.finishJob(job.id, err.code === "cancelled" ? "cancelled" : "failed", err.toJSON());
        this.bus.publish({ type: "job", lessonId: opts.lessonId, jobId: job.id, task, status: "failed", error: err.toJSON() });
        throw err;
      } finally {
        this.controllers.delete(job.id);
      }

      // Completed stream: validate before anything can use it.
      let problem: string;
      try {
        const parsed = schema.safeParse(extractJson(raw));
        if (parsed.success) {
          const extra = opts.check?.(parsed.data) ?? null;
          if (!extra) {
            this.repo.savePartial(job.id, raw);
            this.repo.finishJob(job.id, "completed", undefined, provider);
            this.bus.publish({ type: "job", lessonId: opts.lessonId, jobId: job.id, task, status: "completed" });
            if (key) this.repo.cachePut(key, task, parsed.data);
            return parsed.data;
          }
          problem = extra;
        } else {
          problem = parsed.error.issues
            .slice(0, 6)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
        }
      } catch (e) {
        problem = (e as Error).message;
      }

      const err = new ProviderError("invalid_response", `Generated ${task} was rejected: ${problem}`, true);
      this.repo.savePartial(job.id, raw);
      this.repo.finishJob(job.id, "failed", err.toJSON(), provider);
      this.bus.publish({ type: "job", lessonId: opts.lessonId, jobId: job.id, task, status: "failed", error: err.toJSON() });
      if (attempt >= maxRepairs) throw err;
      // Ask for a corrected version, with the specific problem.
      messages.push({ role: "assistant", content: raw.slice(0, 12000) });
      messages.push({ role: "user", content: `That response was rejected: ${problem}\nReturn a corrected JSON object only.` });
    }
  }
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

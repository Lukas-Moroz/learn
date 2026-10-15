// Runs one AI task end to end: job row → stream → parse → validate → (repair) → result.
// Invariant: nothing is returned (and so nothing is committed by callers) unless the
// provider signalled completion AND the output validated. Partial text stays in the job row.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events.ts";
import type { ProviderRouter } from "../providers/router.ts";
import { ProviderError, type ChatMessage } from "../providers/types.ts";
import { partialFields, settledText } from "../../shared/partial-json.ts";
import { buildPrompt, extractJson, PROMPT_VERSION, TASK_SCHEMAS, type Task } from "./prompts.ts";

export interface GenerateOptions<T> {
  lessonId?: string | null;
  /** Extra deterministic validation (e.g. repetition checks). Return a problem to request a revision. */
  check?: (value: T) => string | null;
  /** Cache key material; omit to never cache (questions are never cached). */
  cacheKey?: unknown;
  /** Validation for a cached value (defaults to `check`); lets a stateful `check` stay out of cache hits. */
  cacheCheck?: (value: T) => string | null;
  maxRepairs?: number;
  signal?: AbortSignal;
  /** Ids added to every live "job" event, so the client can place a preview (practice: setId/problemId/stepId). */
  meta?: { conceptId?: string; lectureId?: string; setId?: string; problemId?: string; stepId?: string; coachingId?: string; followUpId?: string; threadId?: string };
  /**
   * A prepared (prefetched) generation runs hidden: it publishes no live events at all, so the
   * client learns nothing about it, until `show()` is called (the learner asked for this content).
   * From then on it publishes like any other job, starting with its current preview.
   */
  visibility?: Visibility;
  /**
   * Live preview while the response streams: the named top-level string fields, published as
   * throttled SSE "job" events. Display only; nothing here is stored beyond the job's partial text.
   */
  preview?: {
    fields: readonly string[];
    /**
     * Run on the preview text before it is published. Return true to withhold it (e.g. it would
     * give a practice key away): previews stop for that job and the client is told it is "revising".
     */
    withhold?: (values: Record<string, string>) => boolean;
  };
}

/** Whether a generation's live events may be published yet (see GenerateOptions.visibility). */
export class Visibility {
  private shown = false;
  private listeners = new Set<() => void>();
  get visible() {
    return this.shown;
  }
  show() {
    if (this.shown) return;
    this.shown = true;
    for (const fn of [...this.listeners]) fn();
    this.listeners.clear();
  }
  /** Runs `fn` when shown (now, if already shown). Returns an unsubscribe function. */
  onShow(fn: () => void): () => void {
    if (this.shown) {
      fn();
      return () => undefined;
    }
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

export interface GeneratorOptions {
  /** Minimum time between preview events for one job (ms). */
  previewMs?: number;
}

export class Generator {
  private controllers = new Map<string, AbortController>();
  private readonly previewMs: number;

  constructor(
    private readonly repo: Repo,
    private readonly router: ProviderRouter,
    private readonly bus: EventBus,
    o: GeneratorOptions = {},
  ) {
    this.previewMs = o.previewMs ?? 250;
  }

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
        if (parsed.success && !(opts.cacheCheck ?? opts.check)?.(parsed.data)) return parsed.data;
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
      let lastPreview = 0;
      let lastShown = "";
      let withheld = false;
      const base = { type: "job" as const, lessonId: opts.lessonId, ...opts.meta, jobId: job.id, task };
      // Hidden (prepared) generations publish nothing until they are shown.
      const publish = (ev: Parameters<EventBus["publish"]>[0]) => {
        if (!opts.visibility || opts.visibility.visible) this.bus.publish(ev);
      };
      // The preview: settled text of each field (an open field's trailing partial word is held back).
      const publishPreview = () => {
        const p = partialFields(text, opts.preview!.fields);
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(p.values)) values[k] = k === p.open ? settledText(v) : v;
        const key = JSON.stringify(values);
        if (key === lastShown || !Object.values(values).some((v) => v.trim())) return;
        if (opts.preview!.withhold?.(values)) {
          withheld = true;
          publish({ ...base, status: "running", chars: text.length, preview: null, revising: true });
          return;
        }
        lastShown = key;
        publish({ ...base, status: "running", chars: text.length, preview: values });
      };
      publish({ ...base, status: "running", chars: 0 });
      // Shown mid-stream: announce the job and its text so far at once.
      const unshow =
        opts.visibility && !opts.visibility.visible
          ? opts.visibility.onShow(() => {
              this.bus.publish({ ...base, status: "running", chars: text.length, ...(withheld ? { preview: null, revising: true } : {}) });
              if (opts.preview && !withheld) {
                lastShown = "";
                publishPreview();
              }
            })
          : undefined;
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
              if (!opts.preview || withheld) publish({ ...base, status: "running", chars: text.length });
            }
            if (opts.preview && !withheld && t - lastPreview >= this.previewMs) {
              lastPreview = t;
              publishPreview();
            }
          },
        });
        raw = res.text;
        provider = res.provider;
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message, true);
        this.repo.savePartial(job.id, text);
        this.repo.finishJob(job.id, err.code === "cancelled" ? "cancelled" : "failed", err.toJSON());
        publish({ ...base, status: "failed", error: err.toJSON() });
        throw err;
      } finally {
        this.controllers.delete(job.id);
        unshow?.();
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
            publish({ ...base, status: "completed" });
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
      // Another attempt follows unless the repairs are used up: the client shows "revising…".
      // The rejection's detail stays in the job row: it can quote what was rejected (e.g. a practice key's value).
      const publicError = { code: err.code, message: `Generated ${task} didn't pass the checks.`, retryable: true };
      publish({ ...base, status: "failed", error: publicError, ...(attempt < maxRepairs ? { revising: true } : {}) });
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

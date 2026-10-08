// Chooses which subscription provider serves a request. Rules:
//  1. Use the selected provider (OpenAI by default).
//  2. On a usage limit, fall back to Claude only if the user explicitly enabled it
//     and its fail-closed preflight passes.
//  3. Otherwise pause. Never fall through to anything usage-billed (no such provider exists).
import type { Repo } from "../db/repo.ts";
import { ProviderError, type AIProvider, type ProviderId, type ProviderStatus, type StreamRequest } from "./types.ts";

export interface ProviderSettings {
  primary: ProviderId;
  /** Explicit approval to use the Claude CLI when the primary hits a usage limit. */
  claudeFallback: boolean;
}

export interface PauseState {
  reason: string;
  code: string;
  since: string;
  usageUrl?: string;
}

const LIMIT_COOLDOWN_MS = 10 * 60_000;

export class ProviderRouter {
  private limitedUntil = new Map<ProviderId, number>();
  paused: PauseState | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly providers: Partial<Record<ProviderId, AIProvider>>,
    /** Set by LEARN_PROVIDER=mock (tests, offline development). Overrides settings. */
    private readonly forced: ProviderId | null = null,
  ) {}

  settings(): ProviderSettings {
    const s = this.repo.getSetting<Partial<ProviderSettings>>("providers", {});
    return { primary: s.primary ?? "openai", claudeFallback: s.claudeFallback ?? false };
  }

  updateSettings(patch: Partial<ProviderSettings>): ProviderSettings {
    const next = { ...this.settings(), ...patch };
    if (next.primary === "mock" && !this.providers.mock) throw new Error("mock provider is not available");
    this.repo.setSetting("providers", next);
    this.paused = null;
    this.limitedUntil.clear();
    return next;
  }

  get(id: ProviderId): AIProvider | undefined {
    return this.providers[id];
  }

  async statuses(): Promise<{ active: ProviderId; settings: ProviderSettings; paused: PauseState | null; providers: ProviderStatus[] }> {
    const settings = this.settings();
    const providers: ProviderStatus[] = [];
    for (const p of Object.values(this.providers)) {
      if (!p) continue;
      try {
        providers.push(await p.status());
      } catch (e) {
        providers.push({ id: p.id, label: p.id, ready: false, state: "error", message: String((e as Error).message), billing: p.id === "mock" ? "none" : "subscription" });
      }
    }
    return { active: this.forced ?? settings.primary, settings, paused: this.paused, providers };
  }

  /** Ordered candidates for a request. Claude appears only with explicit approval. */
  private candidates(): ProviderId[] {
    if (this.forced) return [this.forced];
    const s = this.settings();
    const order: ProviderId[] = [s.primary];
    if (s.primary !== "claude" && s.claudeFallback) order.push("claude");
    return order;
  }

  async stream(req: StreamRequest): Promise<{ text: string; provider: ProviderId }> {
    const order = this.candidates();
    let lastError: ProviderError | null = null;
    for (const id of order) {
      const provider = this.providers[id];
      if (!provider) continue;
      const until = this.limitedUntil.get(id);
      if (until && until > Date.now()) {
        lastError = new ProviderError("usage_limit", `${id} recently reported a usage limit`);
        continue;
      }
      if (id !== order[0]) {
        // Fallback: run the provider's preflight before sending anything.
        const st = await provider.status();
        if (!st.ready) {
          lastError = new ProviderError("unavailable", `Fallback ${st.label} is not ready: ${st.message}`);
          continue;
        }
      }
      try {
        const res = await provider.stream(req);
        this.paused = null;
        return { ...res, provider: id };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError("unavailable", (e as Error).message, true);
        if (err.code === "usage_limit") {
          this.limitedUntil.set(id, Date.now() + LIMIT_COOLDOWN_MS);
          lastError = err;
          continue; // try the approved fallback, if any
        }
        if (err.code === "billing_risk") {
          // Never retry elsewhere automatically after a billing warning: stop and tell the user.
          this.pause(err);
          throw err;
        }
        if (err.code === "auth_required" || err.code === "not_installed" || err.code === "not_enabled") this.pause(err);
        throw err;
      }
    }
    const err = lastError ?? new ProviderError("unavailable", "No AI provider is configured");
    this.pause(err);
    throw err;
  }

  private pause(err: ProviderError) {
    this.paused = {
      reason: err.message,
      code: err.code,
      since: new Date().toISOString(),
      ...(typeof err.detail?.usageUrl === "string" ? { usageUrl: err.detail.usageUrl } : {}),
    };
  }

  resume() {
    this.paused = null;
    this.limitedUntil.clear();
  }
}

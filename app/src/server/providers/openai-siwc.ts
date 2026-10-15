// OpenAI via the official Sign in with ChatGPT DevKit (`@siwc/local`). Inference
// draws on the user's ChatGPT plan allowance. The DevKit is not on npm; it is built
// locally by `npm run setup:openai` and loaded dynamically, so the app runs without it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import open from "open";
import type { Repo } from "../db/repo.ts";
import type { CredentialEncryption } from "./keychain.ts";
import { ProviderError, type AIProvider, type ProviderStatus, type StreamRequest } from "./types.ts";

// Minimal structural types for the parts of @siwc/local we use.
interface SessionState {
  status: "disconnected" | "connecting" | "connected" | "reauth_required";
  sharing: boolean;
  identity?: { name?: string; email?: string };
  error?: { code: string; message: string };
}
interface ChatGPTClient {
  signIn(o?: { reconsent?: boolean }): Promise<SessionState>;
  cancelSignIn(): void;
  getSession(): Promise<SessionState>;
  listModels(o?: { signal?: AbortSignal }): Promise<{ slug: string; displayName: string }[]>;
  disconnect(): Promise<void>;
  streamResponse(o: {
    model: string;
    input: { role: "user" | "assistant" | "developer"; content: string }[];
    instructions?: string;
    signal?: AbortSignal;
    onDelta?: (d: string) => void;
  }): Promise<{ text: string }>;
}

export const USAGE_URL = "https://chatgpt.com/settings/usage";

const USAGE_LIMIT_CODES = new Set(["subscription_sharing_usage_limit_exceeded", "usage_limit_exceeded", "usage_limit_reached", "insufficient_quota"]);
const AUTH_CODES = new Set([
  "sign_in_required", "sharing_not_enabled", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated",
  "refresh_token_reused", "invalid_grant", "invalid_token", "invalid_api_key", "invalid_client", "invalid_id_token", "invalid_token_response",
  "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context", "registration_upgrade_required", "profile_not_found",
]);
const NOT_ENABLED_CODES = new Set(["subscription_sharing_user_not_eligible", "subscription_sharing_invalid_user", "subscription_sharing_v2_client_not_enabled"]);
const INTERRUPTED_CODES = new Set(["stream_interrupted", "response_incomplete", "invalid_stream"]);
const UNSUPPORTED_CODES = new Set(["subscription_sharing_unsupported_capability", "subscription_sharing_route_not_supported", "model_not_found"]);
/** Failures that a later attempt can be expected to get past. */
const TRANSIENT_CODES = new Set([
  "rate_limit_exceeded", "server_error", "network_error", "connection_error", "invalid_response", "invalid_model_catalog", "discovery_failed",
  "refresh_not_ready", "identity_verification_unavailable", "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable",
]);

const safeId = (v: unknown, max = 100): string | undefined => (typeof v === "string" && v.length <= max && /^[\w][\w.:[\]-]*$/.test(v) ? v : undefined);

/** A DevKit message, minus anything credential-shaped (it never should carry one, but this text reaches logs and the browser). */
function safeMessage(m: unknown): string {
  return String(m ?? "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, "[redacted]")
    .replace(/\b(?:sk|rt|at|sess)-[\w-]{12,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Map DevKit errors onto our provider error vocabulary. The DevKit's own code, HTTP status and
 * request id are kept in `detail` (and the code in the message when it is otherwise generic), so a
 * failure can be diagnosed; transient failures are marked retryable.
 */
export function mapChatGPTError(e: any): ProviderError {
  const code = safeId(e?.code) ?? "unknown";
  const status = typeof e?.status === "number" ? e.status : undefined;
  const requestId = safeId(e?.requestId, 160);
  const msg = safeMessage(e?.message ?? e) || "ChatGPT request failed.";
  const detail = { devkitCode: code, ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}) };
  if (USAGE_LIMIT_CODES.has(code)) return new ProviderError("usage_limit", msg, false, { ...detail, usageUrl: USAGE_URL });
  if (AUTH_CODES.has(code) || (status === 401 && !TRANSIENT_CODES.has(code))) return new ProviderError("auth_required", msg, false, detail);
  if (NOT_ENABLED_CODES.has(code)) return new ProviderError("not_enabled", msg, false, detail);
  if (INTERRUPTED_CODES.has(code)) return new ProviderError("interrupted", msg, true, detail);
  if (code === "cancelled") return new ProviderError("cancelled", msg, false, detail);
  if (UNSUPPORTED_CODES.has(code)) return new ProviderError("unsupported", msg, false, detail);
  const transient =
    Boolean(e?.retryable) ||
    TRANSIENT_CODES.has(code) ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    /rate_?limit|overload|temporar|timeout|unavailable/i.test(code) ||
    // A generic failure reported inside an accepted stream (no HTTP error) is usually server-side.
    ((code === "api_error" || code === "unknown") && (status === undefined || status < 400));
  const where = [code !== "unknown" ? code : null, status && status !== 200 ? `HTTP ${status}` : null].filter(Boolean).join(", ");
  return new ProviderError("unavailable", where ? `${msg} (${where})` : msg, transient, detail);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError("cancelled", "Cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("cancelled", "Cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface OpenAIProviderOptions {
  repo: Repo;
  storageDir: string;
  devkitDir: string;
  encryption: CredentialEncryption;
  /** Injected in tests. */
  loadDevkit?: () => Promise<{ createChatGPT: (c: any) => ChatGPTClient }>;
  /** Pause before the one automatic retry of a transient failure (tests set it to 0). */
  retryDelayMs?: number;
}

export class OpenAIProvider implements AIProvider {
  readonly id = "openai" as const;
  private client: ChatGPTClient | null = null;
  private loadError: string | null = null;
  private models: { id: string; label: string }[] | null = null;

  constructor(private readonly o: OpenAIProviderOptions) {}

  get entry() {
    return join(this.o.devkitDir, "packages", "local", "dist", "index.js");
  }

  private async load(): Promise<ChatGPTClient | null> {
    if (this.client) return this.client;
    try {
      let mod: { createChatGPT: (c: any) => ChatGPTClient };
      if (this.o.loadDevkit) mod = await this.o.loadDevkit();
      else {
        if (!existsSync(this.entry)) {
          this.loadError = "Sign in with ChatGPT DevKit is not installed. Run `npm run setup:openai` in app/.";
          return null;
        }
        mod = await import(pathToFileURL(this.entry).href);
      }
      this.client = mod.createChatGPT({
        appName: "Learn",
        appId: "learn",
        redirectPort: 0,
        storageDir: this.o.storageDir,
        credentialEncryption: this.o.encryption,
        openBrowser: (url: string) => open(url),
      });
      this.loadError = null;
      return this.client;
    } catch (e) {
      this.loadError = `Could not load the DevKit: ${(e as Error).message}`;
      return null;
    }
  }

  model(): string | null {
    return this.o.repo.getSetting<string | null>("openai.model", null);
  }

  async status(): Promise<ProviderStatus> {
    const base = { id: this.id, label: "ChatGPT plan (Sign in with ChatGPT)", billing: "subscription" as const, usageUrl: USAGE_URL };
    const client = await this.load();
    if (!client) return { ...base, ready: false, state: "not_installed", message: this.loadError ?? "Not installed" };
    if (!(await this.o.encryption.isAvailable())) {
      return { ...base, ready: false, state: "error", message: "macOS Keychain encryption is unavailable; tokens cannot be stored safely." };
    }
    const s = await client.getSession();
    const account = s.identity?.email ?? s.identity?.name;
    if (s.status === "connecting") return { ...base, ready: false, state: "connecting", message: "Waiting for browser sign-in…", account };
    if (s.status !== "connected") {
      return { ...base, ready: false, state: "signed_out", message: s.status === "reauth_required" ? "Sign in again to renew the connection." : "Not signed in.", account };
    }
    if (!s.sharing) return { ...base, ready: false, state: "signed_out", message: "Signed in, but ChatGPT plan usage (token sharing) was not granted.", account };
    if (!this.model()) return { ...base, ready: false, state: "error", message: "Choose a model in Settings.", account };
    return { ...base, ready: true, state: "ready", message: "Connected", account, model: this.model() ?? undefined };
  }

  async signIn(): Promise<ProviderStatus> {
    const client = await this.load();
    if (!client) throw new ProviderError("not_installed", this.loadError ?? "Not installed");
    try {
      await client.signIn();
    } catch (e) {
      throw mapChatGPTError(e);
    }
    // Pick a default model on first connection.
    if (!this.model()) {
      const models = await this.listModels().catch(() => []);
      if (models[0]) this.o.repo.setSetting("openai.model", models[0].id);
    }
    return this.status();
  }

  cancelSignIn() {
    this.client?.cancelSignIn();
  }

  async disconnect() {
    const client = await this.load();
    await client?.disconnect().catch((e) => {
      throw mapChatGPTError(e);
    });
  }

  async listModels() {
    if (this.models) return this.models;
    const client = await this.load();
    if (!client) throw new ProviderError("not_installed", this.loadError ?? "Not installed");
    try {
      this.models = (await client.listModels()).map((m) => ({ id: m.slug, label: m.displayName }));
      return this.models;
    } catch (e) {
      throw mapChatGPTError(e);
    }
  }

  async stream(req: StreamRequest): Promise<{ text: string }> {
    const client = await this.load();
    if (!client) throw new ProviderError("not_installed", this.loadError ?? "Not installed");
    const model = this.model();
    if (!model) throw new ProviderError("auth_required", "Choose a ChatGPT model in Settings first.");
    for (let attempt = 0; ; attempt++) {
      let received = false;
      try {
        return await client.streamResponse({
          model,
          instructions: req.instructions,
          input: req.messages.map((m) => ({ role: m.role, content: m.content })),
          signal: req.signal,
          onDelta: (d) => {
            received = true;
            req.onDelta?.(d);
          },
        });
      } catch (e) {
        const err = mapChatGPTError(e);
        // One quiet retry of a transient failure that happened before any text arrived (nothing
        // was shown or saved yet). Usage limits, auth and interrupted streams are never retried here.
        if (attempt === 0 && !received && err.code === "unavailable" && err.retryable && !req.signal?.aborted) {
          await wait(this.o.retryDelayMs ?? 1500, req.signal);
          continue;
        }
        throw err;
      }
    }
  }
}

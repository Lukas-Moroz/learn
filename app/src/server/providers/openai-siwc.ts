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

/** Map DevKit error codes onto our provider error vocabulary. */
export function mapChatGPTError(e: any): ProviderError {
  const code: string = e?.code ?? "unknown";
  const msg: string = e?.message ?? String(e);
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new ProviderError("usage_limit", msg, false, { usageUrl: USAGE_URL });
    case "sign_in_required":
    case "sharing_not_enabled":
    case "invalid_refresh_token":
    case "token_expired":
    case "refresh_token_expired":
    case "refresh_token_invalidated":
    case "refresh_token_reused":
    case "invalid_grant":
    case "invalid_token":
      return new ProviderError("auth_required", msg);
    case "subscription_sharing_user_not_eligible":
    case "subscription_sharing_invalid_user":
      return new ProviderError("not_enabled", msg);
    case "stream_interrupted":
    case "response_incomplete":
    case "invalid_stream":
      return new ProviderError("interrupted", msg, true);
    case "cancelled":
      return new ProviderError("cancelled", msg);
    case "subscription_sharing_unsupported_capability":
    case "subscription_sharing_route_not_supported":
      return new ProviderError("unsupported", msg);
    default:
      return new ProviderError("unavailable", msg, Boolean(e?.retryable));
  }
}

export interface OpenAIProviderOptions {
  repo: Repo;
  storageDir: string;
  devkitDir: string;
  encryption: CredentialEncryption;
  /** Injected in tests. */
  loadDevkit?: () => Promise<{ createChatGPT: (c: any) => ChatGPTClient }>;
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
    try {
      return await client.streamResponse({
        model,
        instructions: req.instructions,
        input: req.messages.map((m) => ({ role: m.role, content: m.content })),
        signal: req.signal,
        onDelta: req.onDelta,
      });
    } catch (e) {
      throw mapChatGPTError(e);
    }
  }
}

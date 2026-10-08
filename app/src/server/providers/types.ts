// Provider abstraction. Every AI backend (ChatGPT plan via Sign in with ChatGPT,
// the user's own Claude CLI, the deterministic mock) implements this interface.
// No implementation may use a usage-billed API key.

export type ProviderId = "openai" | "claude" | "mock";

export type ProviderErrorCode =
  | "not_installed" // optional integration not set up (e.g. DevKit not built)
  | "auth_required" // sign-in needed / expired
  | "not_enabled" // provider exists but the user has not opted in
  | "usage_limit" // subscription allowance exhausted
  | "billing_risk" // continuing could incur pay-as-you-go charges: refused
  | "unavailable" // transient network / service failure
  | "interrupted" // stream ended before completion
  | "cancelled"
  | "invalid_response" // output failed schema validation
  | "unsupported";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable = false,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProviderError";
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /** Ready to take requests right now. */
  ready: boolean;
  state: "ready" | "not_installed" | "signed_out" | "not_enabled" | "usage_limited" | "error" | "connecting";
  message: string;
  /** How usage is paid for. "none" for the mock. Never "api". */
  billing: "subscription" | "none";
  model?: string;
  account?: string;
  usageUrl?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamRequest {
  /** Stable task name; used for logging and by the mock to route fixtures. */
  task: string;
  instructions: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface AIProvider {
  readonly id: ProviderId;
  status(): Promise<ProviderStatus>;
  listModels?(): Promise<{ id: string; label: string }[]>;
  /** Resolves only when the provider signals a *completed* response. Partial output is never returned as success. */
  stream(req: StreamRequest): Promise<{ text: string }>;
}

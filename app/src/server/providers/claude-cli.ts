// Optional fallback: the user's own, unmodified, already-logged-in Claude Code CLI
// used as a plain text generator. The app never reads or stores Claude credentials.
// Off unless the user explicitly enables it. Fails closed on any sign of API-key or
// extra-usage (overage) billing. See docs/ARCHITECTURE.md §4.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { Repo } from "../db/repo.ts";
import { ProviderError, type AIProvider, type ProviderStatus, type StreamRequest } from "./types.ts";

/** Env vars that could route the CLI to API-key or cloud billing. Removed from the child env. */
const BILLING_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING))/;

export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!BILLING_ENV.test(k)) out[k] = v;
  return out;
}

export interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  email?: string;
}

/** Pure check of `claude auth status` output. Returns a refusal reason, or null if subscription auth is confirmed. */
export function authRefusal(s: AuthStatus | null): string | null {
  if (!s) return "Could not read `claude auth status`.";
  if (!s.loggedIn) return "The Claude CLI is not logged in. Run `claude` and sign in with your Claude subscription.";
  if (s.authMethod !== "claude.ai") return `The Claude CLI is using "${s.authMethod}" authentication, which may bill an API account. Only a claude.ai subscription login is allowed.`;
  if (s.apiProvider !== "firstParty") return `The Claude CLI is routed to "${s.apiProvider}", which bills a cloud account. Refusing.`;
  return null;
}

export interface ClaudeProviderOptions {
  repo: Repo;
  bin?: string;
  /** Injected in tests. */
  authStatus?: () => AuthStatus | null;
  timeoutMs?: number;
}

export class ClaudeCliProvider implements AIProvider {
  readonly id = "claude" as const;
  private cachedAuth: { at: number; value: AuthStatus | null } | null = null;
  private limitedNote: string | null = null;

  constructor(private readonly o: ClaudeProviderOptions) {}

  private get bin() {
    return this.o.bin ?? "claude";
  }

  enabled(): boolean {
    const s = this.o.repo.getSetting<{ primary?: string; claudeFallback?: boolean }>("providers", {});
    return s.primary === "claude" || s.claudeFallback === true;
  }

  model(): string {
    return this.o.repo.getSetting<string>("claude.model", "sonnet");
  }

  private auth(): AuthStatus | null {
    if (this.cachedAuth && Date.now() - this.cachedAuth.at < 60_000) return this.cachedAuth.value;
    let value: AuthStatus | null = null;
    if (this.o.authStatus) value = this.o.authStatus();
    else {
      const r = spawnSync(this.bin, ["auth", "status"], { encoding: "utf8", env: scrubbedEnv(), timeout: 15_000 });
      try {
        value = r.status === 0 ? (JSON.parse(r.stdout) as AuthStatus) : null;
      } catch {
        value = null;
      }
    }
    this.cachedAuth = { at: Date.now(), value };
    return value;
  }

  async status(): Promise<ProviderStatus> {
    const base = { id: this.id, label: "Claude subscription (your Claude Code CLI)", billing: "subscription" as const };
    const auth = this.auth();
    const refusal = authRefusal(auth);
    if (refusal) return { ...base, ready: false, state: auth ? "signed_out" : "not_installed", message: refusal };
    if (!this.enabled()) {
      return { ...base, ready: false, state: "not_enabled", message: "Available, but not enabled. Enable it in Settings to allow it as a fallback.", account: auth?.email };
    }
    if (this.limitedNote) return { ...base, ready: false, state: "usage_limited", message: this.limitedNote, account: auth?.email };
    return { ...base, ready: true, state: "ready", message: `Connected (${auth?.subscriptionType ?? "subscription"})`, account: auth?.email, model: this.model() };
  }

  async stream(req: StreamRequest): Promise<{ text: string }> {
    if (!this.enabled()) throw new ProviderError("not_enabled", "The Claude fallback is not enabled.");
    const refusal = authRefusal(this.auth());
    if (refusal) throw new ProviderError("billing_risk", refusal);

    // Never --bare: it forces ANTHROPIC_API_KEY auth.
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools", "",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--model", this.model(),
      "--system-prompt", req.instructions,
    ];
    const prompt =
      req.messages.length === 1
        ? req.messages[0].content
        : req.messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n\n") + "\n\nRespond to the final user message.";

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { env: scrubbedEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let text = "";
      let settled = false;
      let stderr = "";
      const finish = (err: ProviderError | null, value?: { text: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        if (child.exitCode === null) child.kill("SIGTERM");
        err ? reject(err) : resolve(value!);
      };
      const onAbort = () => finish(new ProviderError("cancelled", "Cancelled"));
      req.signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => finish(new ProviderError("interrupted", "The Claude CLI timed out.", true)), this.o.timeoutMs ?? 300_000);

      child.on("error", (e) => finish(new ProviderError("not_installed", `Could not start the Claude CLI: ${e.message}`)));
      child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
      child.stdin.end(prompt);

      createInterface({ input: child.stdout }).on("line", (line) => {
        if (settled || !line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "system" && ev.subtype === "init") {
          // Guard 3: confirm the session authenticated with the subscription, not an API key.
          if (ev.apiKeySource && ev.apiKeySource !== "none") {
            finish(new ProviderError("billing_risk", `The Claude CLI started with API-key credentials (${ev.apiKeySource}). Stopped before generating.`));
          }
          return;
        }
        if (ev.type === "rate_limit_event") {
          const info = ev.rate_limit_info ?? {};
          // Guard 4: overage means extra-usage billing. Stop immediately.
          if (info.isUsingOverage === true) {
            finish(new ProviderError("billing_risk", "Your Claude plan limit is reached and continuing would use paid extra usage. Stopped."));
          } else if (info.status === "rejected") {
            this.limitedNote = `Claude usage limit reached${info.resetsAt ? ` (resets ${new Date(info.resetsAt * 1000).toLocaleString()})` : ""}.`;
            finish(new ProviderError("usage_limit", this.limitedNote));
          }
          return;
        }
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
          text += ev.event.delta.text;
          req.onDelta?.(ev.event.delta.text);
          return;
        }
        if (ev.type === "result") {
          if (ev.subtype === "success" && !ev.is_error) {
            this.limitedNote = null;
            finish(null, { text: typeof ev.result === "string" && ev.result.length >= text.length ? ev.result : text });
          } else {
            const msg = String(ev.result ?? ev.subtype ?? "error");
            finish(/limit/i.test(msg) ? new ProviderError("usage_limit", msg) : new ProviderError("unavailable", msg, true));
          }
        }
      });
      child.on("close", (code) => {
        finish(new ProviderError("interrupted", `The Claude CLI exited (${code}) before completing. ${stderr.slice(-300)}`.trim(), true));
      });
    });
  }
}

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db/database.ts";
import { Repo } from "../src/server/db/repo.ts";
import { authRefusal, ClaudeCliProvider, scrubbedEnv } from "../src/server/providers/claude-cli.ts";
import { testEncryption } from "../src/server/providers/keychain.ts";
import { mapChatGPTError, OpenAIProvider } from "../src/server/providers/openai-siwc.ts";
import { ProviderRouter } from "../src/server/providers/router.ts";
import { ProviderError, type AIProvider, type ProviderId, type ProviderStatus } from "../src/server/providers/types.ts";
import { tmpDir } from "./helpers.ts";

const repo = () => new Repo(openDatabase(":memory:"));

function fake(id: ProviderId, behaviour: "ok" | "limit" | "billing" | "down", ready = true) {
  const calls: string[] = [];
  const p: AIProvider & { calls: string[] } = {
    id,
    calls,
    async status(): Promise<ProviderStatus> {
      return { id, label: id, ready, state: ready ? "ready" : "not_enabled", message: "", billing: "subscription" };
    },
    async stream(req) {
      calls.push(req.task);
      if (behaviour === "limit") throw new ProviderError("usage_limit", `${id} limit`, false, { usageUrl: "https://chatgpt.com/settings/usage" });
      if (behaviour === "billing") throw new ProviderError("billing_risk", `${id} would bill`);
      if (behaviour === "down") throw new ProviderError("unavailable", "down", true);
      return { text: `{"from":"${id}"}` };
    },
  };
  return p;
}

const req = { task: "explain", instructions: "", messages: [{ role: "user" as const, content: "x" }] };

describe("provider routing (cost safety)", () => {
  it("defaults to OpenAI and never falls back without explicit approval", async () => {
    const r = repo();
    const openai = fake("openai", "limit");
    const claude = fake("claude", "ok");
    const router = new ProviderRouter(r, { openai, claude });
    expect(router.settings()).toEqual({ primary: "openai", claudeFallback: false });
    await expect(router.stream(req)).rejects.toMatchObject({ code: "usage_limit" });
    expect(claude.calls).toHaveLength(0);
    expect(router.paused?.code).toBe("usage_limit");
    expect(router.paused?.usageUrl).toBe("https://chatgpt.com/settings/usage");
  });

  it("falls back to an approved, ready Claude provider on a usage limit", async () => {
    const r = repo();
    const router = new ProviderRouter(r, { openai: fake("openai", "limit"), claude: fake("claude", "ok") });
    router.updateSettings({ claudeFallback: true });
    expect(await router.stream(req)).toMatchObject({ provider: "claude" });
  });

  it("does not use an approved fallback whose preflight fails", async () => {
    const r = repo();
    const claude = fake("claude", "ok", false);
    const router = new ProviderRouter(r, { openai: fake("openai", "limit"), claude });
    router.updateSettings({ claudeFallback: true });
    await expect(router.stream(req)).rejects.toBeInstanceOf(ProviderError);
    expect(claude.calls).toHaveLength(0);
    expect(router.paused).not.toBeNull();
  });

  it("stops on a billing risk instead of trying anything else", async () => {
    const r = repo();
    const openai = fake("openai", "ok");
    const router = new ProviderRouter(r, { claude: fake("claude", "billing"), openai });
    router.updateSettings({ primary: "claude" });
    await expect(router.stream(req)).rejects.toMatchObject({ code: "billing_risk" });
    expect(openai.calls).toHaveLength(0);
    expect(router.paused?.code).toBe("billing_risk");
  });

  it("does not retry transient failures on another provider", async () => {
    const r = repo();
    const claude = fake("claude", "ok");
    const router = new ProviderRouter(r, { openai: fake("openai", "down"), claude });
    router.updateSettings({ claudeFallback: true });
    await expect(router.stream(req)).rejects.toMatchObject({ code: "unavailable" });
    expect(claude.calls).toHaveLength(0);
  });
});

// A stand-in `claude` binary that replays stream-json events recorded from Claude Code 2.1.280.
function fakeClaude(events: object[], authStatus: object = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }) {
  const dir = tmpDir("fake-claude-");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log(${JSON.stringify(JSON.stringify(authStatus))}); process.exit(0); }
require("fs").writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify({ args, env: Object.keys(process.env) }));
let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
  for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

const init = (apiKeySource = "none") => ({ type: "system", subtype: "init", apiKeySource, model: "claude-sonnet" });
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const rate = (info: object) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false, ...info } });
const result = (text: string) => ({ type: "result", subtype: "success", is_error: false, result: text });

function claudeProvider(bin: string, enabled = true) {
  const r = repo();
  if (enabled) r.setSetting("providers", { primary: "openai", claudeFallback: true });
  return new ClaudeCliProvider({ repo: r, bin });
}

describe("Claude CLI provider (fail closed)", () => {
  it("streams text from a subscription-authenticated CLI with tools and API-key env removed", async () => {
    const { bin, dir } = fakeClaude([init(), rate({ status: "allowed_warning", utilization: 0.87 }), delta('{"a":'), delta("1}"), result('{"a":1}')]);
    process.env.ANTHROPIC_API_KEY = "sk-test-should-not-pass";
    try {
      const deltas: string[] = [];
      const out = await claudeProvider(bin).stream({ ...req, onDelta: (d) => deltas.push(d) });
      expect(out.text).toBe('{"a":1}');
      expect(deltas.join("")).toBe('{"a":1}');
      const { args, env } = JSON.parse(require("node:fs").readFileSync(join(dir, "args.json"), "utf8"));
      expect(env).not.toContain("ANTHROPIC_API_KEY");
      expect(args).not.toContain("--bare");
      expect(args).toEqual(expect.arrayContaining(["-p", "--tools", "", "--no-session-persistence", "--output-format", "stream-json"]));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("refuses when the session reports API-key credentials", async () => {
    const { bin } = fakeClaude([init("ANTHROPIC_API_KEY"), delta("x"), result("x")]);
    await expect(claudeProvider(bin).stream(req)).rejects.toMatchObject({ code: "billing_risk" });
  });

  it("stops immediately when extra-usage (overage) billing would be used", async () => {
    const { bin } = fakeClaude([init(), rate({ status: "allowed", isUsingOverage: true }), delta("x"), result("x")]);
    await expect(claudeProvider(bin).stream(req)).rejects.toMatchObject({ code: "billing_risk" });
  });

  it("reports a usage limit when the plan window is exhausted", async () => {
    const { bin } = fakeClaude([init(), rate({ status: "rejected", resetsAt: 1791532800 })]);
    const p = claudeProvider(bin);
    await expect(p.stream(req)).rejects.toMatchObject({ code: "usage_limit" });
    expect((await p.status()).state).toBe("usage_limited");
  });

  it("treats an exit without a result as an interrupted stream", async () => {
    const { bin } = fakeClaude([init(), delta("partial")]);
    await expect(claudeProvider(bin).stream(req)).rejects.toMatchObject({ code: "interrupted" });
  });

  it("is off unless enabled, and refuses non-subscription auth in preflight", async () => {
    const { bin } = fakeClaude([init(), result("x")]);
    const off = claudeProvider(bin, false);
    expect((await off.status()).state).toBe("not_enabled");
    await expect(off.stream(req)).rejects.toMatchObject({ code: "not_enabled" });
    expect(authRefusal({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })).toMatch(/API account/);
    expect(authRefusal({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" })).toMatch(/cloud account/);
    expect(authRefusal({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })).toBeNull();
    expect(Object.keys(scrubbedEnv({ ANTHROPIC_API_KEY: "x", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/bin", HOME: "/h" }))).toEqual(["PATH", "HOME"]);
  });
});

describe("OpenAI Sign in with ChatGPT provider", () => {
  it("reports not installed until the DevKit is built", async () => {
    const p = new OpenAIProvider({ repo: repo(), storageDir: tmpDir(), devkitDir: "/nonexistent", encryption: testEncryption() });
    const s = await p.status();
    expect(s.state).toBe("not_installed");
    expect(s.message).toMatch(/setup:openai/);
    await expect(p.stream(req)).rejects.toMatchObject({ code: "not_installed" });
  });

  it("maps DevKit errors, and passes instructions + messages through", async () => {
    const r = repo();
    r.setSetting("openai.model", "gpt-test");
    let seen: any = null;
    let mode: "ok" | "limit" | "interrupted" = "ok";
    const client = {
      signIn: async () => ({ status: "connected", sharing: true }),
      cancelSignIn() {},
      getSession: async () => ({ status: "connected", sharing: true, identity: { email: "me@example.com" } }),
      listModels: async () => [{ slug: "gpt-test", displayName: "GPT Test" }],
      disconnect: async () => {},
      streamResponse: async (o: any) => {
        seen = o;
        if (mode === "limit") throw Object.assign(new Error("limit"), { code: "subscription_sharing_usage_limit_exceeded" });
        if (mode === "interrupted") throw Object.assign(new Error("cut"), { code: "stream_interrupted", retryable: true });
        o.onDelta?.("hi");
        return { text: "hi" };
      },
    };
    const p = new OpenAIProvider({ repo: r, storageDir: tmpDir(), devkitDir: "/x", encryption: testEncryption(), loadDevkit: async () => ({ createChatGPT: () => client as any }) });
    expect((await p.status()).ready).toBe(true);
    expect((await p.stream({ ...req, instructions: "be brief" })).text).toBe("hi");
    expect(seen.model).toBe("gpt-test");
    expect(seen.instructions).toBe("be brief");
    expect(seen.input).toEqual([{ role: "user", content: "x" }]);
    mode = "limit";
    await expect(p.stream(req)).rejects.toMatchObject({ code: "usage_limit" });
    mode = "interrupted";
    await expect(p.stream(req)).rejects.toMatchObject({ code: "interrupted", retryable: true });
    expect(mapChatGPTError({ code: "sharing_not_enabled" }).code).toBe("auth_required");
    expect(mapChatGPTError({ code: "subscription_sharing_user_not_eligible" }).code).toBe("not_enabled");
  });
});

# Learn 2.0 — Architecture decision record

Status: accepted (Phase 0). Date: 2026-10-07.

## 1. What existed

The repository is a **pi configuration** (`.pi` directory):

| Piece | What it does | Fate in Learn 2.0 |
|---|---|---|
| `skills/teach/SKILL.md` | The teaching philosophy (unconditional truths first; "how could I have discovered this?"), probe → plan → teach, quiz-option construction procedure | **Reused verbatim at runtime.** The app reads the philosophy and quiz-construction sections out of this file and puts them into every generation prompt, so editing the skill changes the app. |
| `extensions/quiz.ts` | Graded MCQ in the terminal, value-keyed answers, shuffle, "I don't know", optional note | **Logic ported** to `app/src/shared/grading.ts` (normalize, value-keyed correct answer, JSON-string coercion, exact-set grading, Fisher–Yates). TUI rendering replaced by a React component. |
| `extensions/md-log.ts` | Mirrors a session into Obsidian Markdown callouts | **Format ported** to `app/src/shared/markdown-export.ts`; lessons export to the same callout style. |
| `extensions/ask-user-question.ts` | Ungraded popup questions | Kept for pi. In the app, ungraded choices are ordinary UI controls. |
| `skills/visualize`, `agents/*-maker.md`, `extensions/visual-tools` | Subagents render Mermaid/SVG to PNG and look at it | Kept for pi. In the browser, Mermaid renders client-side from validated source; a block whose diagram fails to parse falls back to text and never shows a broken figure. |
| `agents/researcher.md` | Web fact-checking subagent | Kept for pi. Not used by the app (no web access is required to study). |

Nothing in the pi setup is deleted: `pi` in this directory still works exactly as before. The app lives in `app/`.

## 2. Backend options evaluated

**A. Pi RPC (`pi --mode rpc`) as the brain, browser as a thin client.**
Pi streams JSONL events and forwards extension UI requests. Rejected as the core because:
- The lesson state would live in an LLM conversation transcript. The brief requires a deterministic state model (position, detours, checkpoints, mastery) that survives restarts and never depends on the model remembering.
- `ctx.ui.custom` components (quiz, ask-user-question) are TUI render functions; over RPC they would need re-implementing anyway.
- Pi's provider logins for Claude subscriptions are a third-party harness — exactly what Anthropic's terms disallow (see §4).
- Pi is not installed on this machine; the app should not require it.

**B. Pi SDK (`createAgentSession`) embedded in the server.** Same state-ownership problem as A, plus an agent loop with tools that a tutor does not need. Rejected for the same reasons.

**C. Dedicated orchestration layer (chosen).** A small Node server owns all state in SQLite. A deterministic **teaching engine** decides *what happens next* (probe, explain, check, remediate, detour, return, checkpoint). The LLM is called only to *generate content* (source analysis, explanations, questions, reasoning evaluation, misconception hypotheses), always through typed, validated JSON contracts. Pi assets are reused where they carry behavior (skill text, grading logic, export format).

## 3. Stack

- **Server:** Node ≥ 22.13 + TypeScript (run with `tsx`), Express 5, Node's built-in `node:sqlite` behind a small adapter (`db/database.ts`), zod schemas shared with the client. `better-sqlite3` was tried first and dropped: v13 segfaulted on Node 22.9 and v11 crashed in Node 24's garbage collector, and a native module that breaks on every `nvm use` is the wrong trade for a personal tool.
- **Client:** React + Vite. KaTeX via `remark-math`/`rehype-katex`, Mermaid (lazy), PDF.js for source pages. Everything is bundled locally, with no CDN, so saved lessons work offline.
- **Storage:** `~/.learn` by default (`LEARN_DATA_DIR` overrides): `learn.db` (WAL), `sources/` (original files by content hash), `exports/` (Markdown), `secrets/` (encrypted provider state).
- **One command:** `npm start` in `app/` builds the client, starts the server on `127.0.0.1:4317` and opens the browser.

## 4. AI providers and cost safety

All providers implement one interface (`app/src/server/providers/types.ts`): status, model discovery, streaming, cancellation, typed errors (`usage_limit`, `auth_required`, `billing_risk`, `interrupted`, …).

### OpenAI — Sign in with ChatGPT (primary)
- Official DevKit `@siwc/local` (OAuth 2.0 + PKCE, loopback `127.0.0.1` callback, dynamic client registration during consent, scope `chatgpt.tokens.use.direct`). Inference is the Responses API with `store:false, stream:true`; success only on `response.completed`.
- **Not on npm** (private workspace package) and under a *noncommercial* license, which fits personal use. `npm run setup:openai` clones the DevKit at a pinned commit into `app/vendor/` (gitignored) and builds it. The server loads it dynamically, and the provider reports "not installed" when it is absent.
- The DevKit requires an OS-backed `CredentialEncryption`. Ours keeps a random AES-256-GCM key in the macOS **Keychain** (written via `security -i` on stdin so it never appears in argv). Tokens never leave the server process.
- Preview limits that shape the design: no `temperature`, `max_output_tokens`, `previous_response_id`, or hosted tools. So every call sends focused context and asks for JSON in text, which the server validates with zod.
- Usage limit → `subscription_sharing_usage_limit_exceeded`. OpenAI documents that it "does not silently switch the request to another billing path." We pause and link to ChatGPT → Settings → Usage.
- POC (Phase 0): DevKit built from commit `0a36fef`, loaded from the app's Node process, Keychain round-trip verified, unauthenticated request fails closed with `sign_in_required`. **The live browser consent and a real inference call can only be verified by you** (see README).

### Anthropic — Claude CLI (optional fallback, off by default)
- Anthropic's terms (code.claude.com/docs/en/legal-and-compliance): developers may not offer claude.ai login in their own apps, nor collect or intermediate Claude credentials. They *do* allow "an end user signing in to the unmodified Claude Code binary with their own Claude subscription", and say Pro/Max limits assume "ordinary, individual usage of Claude Code and the Agent SDK". Our reading: a personal tool that spawns your own, unmodified, already-logged-in `claude` CLI, and never touches its credentials, falls in the permitted space. The Agent SDK docs warn third-party *products* off subscription login, so this provider is **opt-in**, labelled as your own CLI, and never shipped as "sign in with Claude".
- Fail-closed guards (verified against real CLI output on 2026-10-07, Claude Code 2.1.280):
  1. Preflight `claude auth status` must report `loggedIn`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`.
  2. The child env is scrubbed of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, Bedrock/Vertex/Foundry switches. `--bare` is never used (it *forces* API-key auth).
  3. The stream's `system/init` event must report `apiKeySource: "none"`, otherwise the process is killed before any text is used.
  4. A `rate_limit_event` with `isUsingOverage: true` (extra-usage billing) kills the process and pauses the provider. `status: "rejected"` is a usage limit.
- Tools disabled (`--tools ""`), no session persistence, no MCP, no settings sources. It is a pure text generator.

### Routing
`ProviderRouter`: use the selected provider (OpenAI by default). On `usage_limit`, switch to Claude **only if** you enabled it *and* its preflight passes. Otherwise the app enters a **paused** state: all saved lessons, reviews and deterministic grading keep working, and new generation waits. No code path calls a usage-billed API. There is no API-key provider at all.

**Mock provider:** deterministic fixtures (a full probability → second-order Markov curriculum) behind the same interface. Used by tests and `LEARN_PROVIDER=mock`. It can simulate stream interruption and usage limits.

## 5. Module boundaries

```
app/src/shared/      zod schemas + pure logic used by server & client
  schemas.ts         blocks, questions, attempts, refs, AI contracts
  grading.ts         ported quiz.ts grading
  mastery.ts         evidence → status (Not assessed / Developing / Demonstrated / Needs review)
  similarity.ts      anti-repetition + anti-parroting checks
  markdown-export.ts md-log-compatible export
app/src/server/
  db/                schema + repositories (deterministic state lives here)
  ingest/            PDF/PPTX extraction, hashing, dedupe, folder ordering
  alignment/         citation validation (page exists, quote actually on page)
  graph/             shared concept graph + course-specific contexts
  ai/                prompt builders, principle loader, JSON-contract calls, cache
  providers/         openai-siwc, claude-cli, mock, router, keychain encryption
  teaching/          engine (state machine), planner (next action), diagnosis,
                     remediation strategies, checkpoints, review scheduling
  routes/            HTTP + SSE
app/src/web/         React UI
```

## 6. Key invariants

1. **The LLM never owns state.** Position, detour stack, attempts, evidence, misconceptions, checkpoints are rows written in transactions by the engine.
2. **Nothing generated is committed until it completes and validates.** Streaming output goes to an `ai_jobs` row. A failed or interrupted stream leaves the job `failed` and creates no block, attempt or checkpoint.
3. **Citations are checked, not trusted.** A ref to a non-existent page is dropped. A quote not found on its page is removed. Generated text without a surviving ref is labelled *supplementary*.
4. **Correctness and reasoning are graded separately.** Selection grading is deterministic. Written reasoning gets its own verdict, and a correct pick with flawed reasoning earns recognition evidence only.
5. **Mastery is multi-dimensional evidence**, never one correct answer.
6. **Same document, same work:** sources are content-addressed (SHA-256). Re-import of an unchanged file reuses extraction and analysis. A changed file becomes a new version of the same document, and history is kept.

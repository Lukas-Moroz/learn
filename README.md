# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This repository has two parts that share one teaching philosophy (`skills/teach/SKILL.md`):

1. **Learn 2.0** (`app/`): a local, browser-based adaptive tutor for course material and research papers. This is the main way to use it now.
2. **The original pi configuration** (`skills/`, `extensions/`, `agents/`): unchanged and still works in a terminal with [pi](https://github.com/earendil-works/pi). See [the pi setup](#the-original-pi-setup) below.

---

## Learn 2.0

Open Learn in your browser and choose a course and lecture. You read an AI-written lesson aligned to the original slides or paper and answer questions inside it. Teaching adapts to what you actually understand. Close the browser whenever you like; it resumes exactly where you were. It uses only AI subscriptions you already pay for, and never a pay-as-you-go API.

### What it does

- **Source-driven lessons.** Import PDFs (and PowerPoint). Each document is analysed once: research question and contributions for papers, structure and progression for lectures, plus the prerequisite concepts it assumes. You get a learning path that follows the source but can leave it when understanding requires it.
- **Two positions, always visible.** *Source position* (e.g. "Lecture 4, slide 9") and *learning position* (the concept you're on) are tracked separately. A prerequisite detour shows why it matters and where you'll return to.
- **Honest provenance.** Every reference is checked against the stored page text before it's shown: missing pages are dropped and quotes that aren't on the page are removed. Explanations not grounded in the source are labelled *supplementary*. Click any reference to open the original page.
- **Questions that test ideas, not wording.** Each question has an "I don't know" option, Sure/Unsure/Guess confidence and an optional written explanation. Distractors are specific misconceptions. A new question never reuses an earlier scenario or the phrasing of the explanation you just read.
- **Evidence-based mastery.** Recognition, explanation, application, transfer to an unfamiliar context, retention and calibration are tracked separately. *Demonstrated* needs confident understanding and application, plus transfer for central concepts. A correct answer with flawed written reasoning counts only as recognition. A correct guess counts as nothing.
- **Misconception remediation.** The engine records the misconception behind a wrong answer. It re-teaches with a genuinely different strategy (first principles → worked example → contrasting cases → analogy with its limits stated → …). After two misses it backtracks into the weakest prerequisite, then reconnects. If nothing clicks, it sets the concept aside for review instead of eating the session.
- **Math that explains itself.** Each equation comes with why it exists, what each term means here, what happens as terms change, and its assumptions; derivations are optional and collapsed. KaTeX and Mermaid are bundled, so everything works offline.
- **Checkpoints and review.** Checkpoints at conceptual transitions summarise what you learned, what you can explain, what's uncertain and which misconceptions were resolved. Spaced retrieval practice (1, 3, 7, 21… days) runs offline from stored questions.
- **Always saved.** Every answer and step is written to SQLite in a transaction. Generated content is committed only once it has fully arrived and validated, so a dropped connection never leaves half a lesson.
- **Markdown export** in the same callout format as the pi `md-log` extension (Obsidian-friendly).

### Quick start

Requirements: macOS, Node.js **22.13 or newer** (`node --version`), git.

```bash
cd app
npm install
npm start            # builds the UI, starts http://127.0.0.1:4317 and opens your browser
```

Try it without any AI account (deterministic demo content, zero usage):

```bash
npm run seed:demo                # adds a demo course with a generated Markov-chains lecture
LEARN_PROVIDER=mock npm start
```

To develop with hot reload, run `npm run dev` (UI at http://localhost:5173).

### Connecting your AI subscription

**ChatGPT plan (default provider)**, through OpenAI's official [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) DevKit:

```bash
cd app
npm run setup:openai     # clones and builds the official DevKit into app/vendor/ (not on npm)
npm start
```

Then open **Settings (⚙) → Sign in with ChatGPT**. Your browser handles the official OAuth consent. Choose a model in Settings afterwards.

- Usage comes from your ChatGPT plan's shared allowance (the Codex/Work allowance, not unlimited chat). Check it at <https://chatgpt.com/settings/usage>.
- Tokens are encrypted with a key kept in your macOS Keychain and never reach the browser.
- The DevKit's license is noncommercial, which covers personal use.

**Claude (optional fallback, off by default).** If you use Claude Code, Learn can use your own logged-in `claude` CLI as a text generator when the ChatGPT allowance runs out. Turn it on in Settings. Learn never reads your Claude credentials. It refuses to run, and pauses, if:

- `claude auth status` doesn't show a claude.ai subscription login,
- the session reports an API key,
- the CLI is routed to a cloud provider, or
- it would use paid extra usage.

My reading of Anthropic's [published terms](https://code.claude.com/docs/en/legal-and-compliance) is that this personal use of the unmodified CLI is permitted. The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#4-ai-providers-and-cost-safety); decide for yourself before enabling it.

**When a limit is reached**, Learn pauses new generation and says so. Reading, reviewing and answering stored questions keep working. Written reasoning you submit while paused is evaluated later. There is no code path to a usage-billed API.

### Using it

- **Courses:** create a course, then drop PDF/PPTX files on it or enter a local folder path. Lectures are ordered naturally ("Lecture 2" before "Lecture 10"); fix the order with ↑/↓. Re-importing an unchanged file does nothing; a changed file becomes a new version and your history is kept.
- **No document?** Type a learning goal ("second-order Markov models") on the home page.
- **Keyboard:** `1`–`9` choose · `0` I don't know · `S`/`U`/`G` confidence · `R` write reasoning · `Enter` submit · `⌘/Ctrl+Enter` continue · `Esc` closes panels · `←`/`→` page through the source.
- **Progress panel:** click *Progress* or the concept name in the bar to see every concept's status and evidence.
- **Keep moving:** after a miss, choose *Try again*, *Show solution*, or *Skip step*. Skipping moves straight to the next step or problem and keeps the skipped step available to revisit. In lessons, *Skip this concept* or *Skip prerequisite review* moves past a frustrating portion; in review, *Skip question* leaves it due for later. Explanations and practice check questions are optional, and skipping never counts as a correct answer.

### Where your data lives

Everything is local, in `~/.learn` (override with `LEARN_DATA_DIR`):

| Path | Contents |
|---|---|
| `learn.db` | SQLite: courses, lessons, answers, evidence, misconceptions, concept graph |
| `sources/` | imported files, named by SHA-256 |
| `exports/` | Markdown exports |
| `secrets/chatgpt/` | encrypted ChatGPT sign-in (key in macOS Keychain) |

Back up `~/.learn` to back up everything. Nothing is uploaded except the focused lesson context sent to your chosen AI provider.

### Tests

```bash
cd app
npm test             # deterministic; uses the mock provider and never consumes subscription usage
npm run typecheck
npm run eval:live    # OPT-IN: ~4 requests to your configured provider to grade teaching quality
```

`npm test` covers the acceptance scenarios end to end: low-confidence answers, flawed reasoning, remediation detours, restart mid-detour, source references, multi-lecture courses, unchanged re-imports, interrupted streams, usage limits and offline use. It also runs a full educational evaluation, in which a simulated learner with two misconceptions works from probability foundations to explaining second-order Markov models in a new context.

### Architecture

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. In short: a local Node server owns all state in SQLite, and a deterministic planner (`app/src/server/teaching/planner.ts`) decides each teaching move. The AI only writes content, through validated JSON contracts. The prompts load the philosophy and quiz-construction sections from `skills/teach/SKILL.md` at runtime, so editing the skill changes the app.

### Not done yet

- Google Drive sync (local file and folder import work today)
- Rendering PowerPoint slides as images (the source panel shows slide text and speaker notes)
- A live check of the ChatGPT sign-in: it needs your browser consent, and is the first thing to try

---

## The original pi setup

This repo **is** a `.pi` directory: the teaching philosophy encoded in a skill, a few small extensions, and agent definitions.

- `skills/teach/`: the philosophy and the process (also used by Learn 2.0)
- `skills/visualize/`: adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `extensions/ask-user-question/`: the agent asks you questions through a UI popup
- `extensions/quiz/`: graded questions with instant feedback (✓/✗, correct answer, explanation)
- `extensions/md-log/`: link a markdown file to the session
- `extensions/visual-tools/`: tools for visualization subagents
- `agents/`: `researcher`, `svg-maker`, `mermaid-maker`, the subagents the system delegates to

### Install

From your learning project's root:

```bash
git clone https://github.com/amosblomqvist/learn .pi
```

Then open pi in that directory (or copy the pieces you want into your existing project config).

### Requirements

- [pi](https://github.com/earendil-works/pi)
- A subagent implementation, so the system can spawn the researcher and the visual makers. Recommended: [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux only). Any other implementation works too, but expect to adapt the agent definitions; e.g. `agents/researcher.md` lists `safe_bash`, which is specific to that extension.
- `ask-user-question`: use the copy bundled here. Popups from different extensions serialize through a shared UI lock, which only works when it's the same implementation.

You can run the pi system without subagents; you just lose the researcher (fact verification) and the generated visuals. The teaching skill is written for one learner; edit it to fit how you learn best.

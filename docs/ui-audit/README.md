# Learn UI audit — October 8, 2026

The core learning flow works. The highest priority changes are keyboard accessibility, error recovery, and keeping the learner oriented as new content appears. The existing calm reading layout and source references are useful foundations.

**Live follow-up:** after sign-in, [real ChatGPT generation also passed](live/README.md): five OpenAI generation jobs, answer/reasoning feedback, and refresh persistence. That report records an additional issue with shuffled answer identifiers in AI feedback.

## Results and scope

- **Playwright: 17 scenarios, 7 passed, 10 failed checks.** These are ordinary failing assertions documenting the current issues; some checks cover the same issue, so this is not a count of ten separate bugs.
- **Existing Vitest suite: 73/73 passed.** The initial sandboxed run could not open loopback sockets; all tests passed when rerun with loopback access.
- **TypeScript and production web build passed.**
- Chrome, desktop 1440×1000, phone layouts 390×844 and 320×844, light and dark themes. Phone coverage uses browser viewport emulation, not a physical phone.
- Actual UI interactions exercised course creation, PDF upload, lesson creation, source rendering/navigation, questions, remediation, drafts, saved answers, concepts, progress, and review answers. Request failures were deliberately injected with Playwright routes.
- Every final browser test uses a fresh in-memory database and the real application server with the deterministic mock provider. Account metadata is removed from rendered status responses. Live sign-in and AI generation, PPTX import, folder import, full lesson completion, and Safari/Firefox were not exercised by this browser suite.

Artifacts: [test source](ui.spec.mjs), [JSON results](results.json), [axe findings](accessibility.json), and the locally generated [HTML report](playwright-report/index.html). Screenshots below are evidence, not proposed redesigns. Full-page captures can place the sticky header partway down the image; the viewport capture shows the actual visible learning position.

## Changes to prioritize

| Priority | Observed behavior | Suggested change and why | Evidence / location |
|---|---|---|---|
| High | The four math-only answer options expose an empty accessible name. Axe flags four critical `button-name` violations. The lesson progress bar also has no accessible name. | Give choices meaningful spoken labels, such as “two thirds,” and label the progress bar “Lesson progress.” Associate the radio group with the question, include “I don't know” in that group, and support expected radio keyboard navigation. A learner using a screen reader needs to distinguish the choices and progress. | Tests 06–07; [QuestionCard](../../app/src/web/components/QuestionCard.tsx#L169), [TopBar](../../app/src/web/components/TopBar.tsx#L57). |
| High | Tab escapes Settings into the covered page. `aria-modal` is absent, and Escape does not return focus to the Settings button. | Use a shared accessible dialog primitive with initial focus, contained Tab navigation, an inert background, Escape handling, and focus restoration. Apply it to Settings and both drawers; Settings was tested, the drawers share the implementation pattern. This prevents keyboard users from accidentally navigating the covered page. These behaviors follow the [W3C modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). | Test 08; [SettingsDialog](../../app/src/web/components/SettingsDialog.tsx). |
| High | Pressing Enter on the focused “Sure” button does not select it. The question container intercepts Enter and calls submit before the button can activate. | Handle shortcuts only when their target is the question container or a suitable noninteractive element. Preserve native Enter/Space behavior on buttons. Keep deliberate submission on Submit and document any separate submit shortcut. Keyboard users should be able to activate the same controls as mouse users. | Test 10; [QuestionCard](../../app/src/web/components/QuestionCard.tsx#L115). |
| High | Failed course creation shows no visible error. A failed course-list request leaves the home screen without an error or retry. A failed source-page request is shown as “No text on this page.” | Add explicit loading, success, empty, and error states. Preserve form input, show a persistent inline error and Retry, and disable repeated submissions while busy. In the source drawer, distinguish a fetch failure from a successfully loaded blank page. Learners need to know whether their work saved and whether a source is actually missing. | Tests 12–14; [creation failure](screenshots/course-create-failure.png), [source failure](screenshots/source-load-failure.png); [HomePage](../../app/src/web/pages/HomePage.tsx#L84), [SourceDrawer](../../app/src/web/components/SourceDrawer.tsx#L32). |
| High | After “I don't know” → Continue, the new question is entirely outside the viewport, although the card receives focus. | Move to the beginning of the new explanation so it can be read, then provide a clear “Answer the question” action. Whenever focus moves to the question, bring it into view below the sticky header. This preserves the teaching sequence while preventing learners from answering a focused but invisible card. | Test 09; [actual viewport](screenshots/new-question-viewport.png); [QuestionCard](../../app/src/web/components/QuestionCard.tsx#L78). |
| Medium | A 320px home viewport has a 336px document width. The grid requires a minimum 320px track inside a page with horizontal padding. At 390px it fits, but lecture names remain heavily truncated. | Use `minmax(min(100%, 320px), 1fr)` or a single-column mobile grid, and audit flexible children for minimum-width constraints. Put the lecture title on its own wrapping row and move ordering controls into an edit mode. This makes the page usable on narrow screens and lets learners recognize their material. | Test 11; [320px screenshot](screenshots/home-320.png), [390px screenshot](screenshots/home-390.png); [styles](../../app/src/web/styles.css#L130). |
| Medium | Searching Concepts for a nonexistent term says “No concepts yet. They appear as you study,” despite seven existing concepts. | Distinguish an empty library from an empty search result. Show “No concepts match ‘…’” and a Clear filter action. The current message incorrectly implies that studied concepts were lost. | Test 15; [ConceptsPage](../../app/src/web/pages/ConceptsPage.tsx#L59). |

## UI and product improvements

These are design recommendations based on the screenshots and flow, rather than additional automated failures.

1. **Make the first screen explain the next step.** Add an H1 such as “What would you like to learn?” with two clear choices: Upload course material and Start with a learning goal. Keep Continue first for returning learners. The current page starts with small section labels and competing “Start” buttons; the initial home scan also reports a missing H1.
2. **Give the current lesson more prominence.** On a phone, the full overview and seven-item learning path occupy more than a screen before the question. Keep an expandable overview/path and collapse completed sections into a readable history. Keep source and concept position visible. This reduces repeated scrolling without losing the context that makes the tutor valuable. See [mobile lesson](screenshots/lesson-mobile.png).
3. **Make course cards useful at a glance.** A desktop card truncates even “Lecture 4 - Markov Chains.” Let titles wrap, label `0/7` as “0 of 7 concepts completed,” and move folder paths and reordering into secondary controls. The default card should emphasize the lecture and its next action. See [desktop home](screenshots/home-desktop.png).
4. **Offer a desktop split view for source comparison.** The source drawer renders well, but its overlay covers part of the lesson. Allow a pinned lesson/source split at sufficient width, retaining a drawer on phones. This would make checking a claim against a slide easier. See [source viewer](screenshots/source-desktop.png).
5. **Explain progress in learner language.** The distinction between a correct answer and demonstrated understanding is useful, but “Needs solid evidence …” and the evidence dimension labels are abstract. Add a short next-step sentence such as “You recognized this idea; next we'll test it in a new situation.” Explain Background/Central labels on demand. See [answer feedback](screenshots/answer-feedback.png) and [progress panel](screenshots/progress-desktop.png).
6. **Simplify provider setup and phone controls.** Label Mock as “Demo mode,” give Settings and theme controls larger touch areas, and progressively disclose CLI/setup and billing details. Keep the active provider and any actionable paused state obvious. Technical setup details currently occupy most of the Settings dialog. See [Settings](screenshots/settings-desktop.png).
7. **Recognize a fresh session correctly.** Starting a learning goal shows “Welcome back” before the learner has studied it, because the initial plan already exists. Use an introductory “Ready to begin?” state, and reserve the recap for an actual resumed session. This makes the session history feel trustworthy.
8. **Give Review a session structure.** Add a due count, “Question 1 of N,” and a completion summary after the queue is answered. Label reused questions “Retrieval practice”; the tested review card retained “What do you already know?” from its original lesson purpose. Existing review questions and feedback work, but clearer labels and session bounds would help learners understand what they are doing. See [review question](screenshots/review-question.png) and [review feedback](screenshots/review-feedback.png).

I would implement accessibility and error recovery first, then the lesson reading/scroll behavior and mobile card layout, followed by onboarding and source split view.

## Run the audit again

Install the main app dependencies first. With Node 22.13+ and Google Chrome installed:

```bash
cd docs/ui-audit
npm install
npm test
```

`pretest` builds the production UI. Playwright starts and stops the disposable server on `127.0.0.1:4329`; each test resets its in-memory database. Imported fixture PDFs are written under `/private/tmp/learn-ui-audit-isolated`, overridable with `LEARN_AUDIT_DATA`. The suite does not need subscription sign-in or the normal `~/.learn` database.

The original audit installed its browser tools in a temporary directory without changing the app package:

```bash
LEARN_AUDIT_MODULES=/private/tmp/learn-ui-audit-tools/node_modules \
  node /private/tmp/learn-ui-audit-tools/node_modules/@playwright/test/cli.js \
  test --config docs/ui-audit/playwright.config.mjs
```

The assertions use Playwright's [auto-retrying browser checks](https://playwright.dev/docs/test-assertions). The ten failed checks are retained so the suggested fixes can be verified later. Application behavior was not changed as part of this review.

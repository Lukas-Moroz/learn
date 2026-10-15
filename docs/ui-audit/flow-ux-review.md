# Learn learning-flow review — October 13, 2026

The main friction was deciding what to do after a miss: explanations and grading controls competed with navigation, and opening an explanation could make retrying depend on another generated question. The revised flow gives learners a clear way to try again, get help, or move forward.

- **Practice:** “Try again,” “Skip step,” and “Show solution” sit together immediately after the verdict. Skipping opens the following step, or the next problem after the final step. An unanswered skip records no answer and reveals no key; a skip after a miss keeps the original attempt. Skips survive refresh and can be revisited. Warm-ups, coaching, check questions, and follow-ups are optional. Opening a detailed explanation never blocks retrying or skipping while AI is preparing its check.
- **Lessons:** buttons describe what happens next, such as “See a different explanation” and “Review a prerequisite.” “Skip this concept” moves ahead, while “Skip prerequisite review” returns to the original concept. The learner's previous answers remain saved, and skipped concepts are marked as set aside. Feedback receives focus after answering; detailed progress and written reasoning fold away so the next actions remain easy to reach on a phone.
- **Review:** one active question appears at a time. A wrong answer can go directly to the next question. “Skip question” records no attempt, keeps that question due, and offers a way to revisit skipped questions in the session summary.
- **Reading and phone layout:** the practice overview folds once the learner starts, completed steps fold, the next input receives focus after a skip, and the decision buttons fit 390px and 320px viewports. Optional help and grading controls stay behind disclosures. “Check answer” and “I don't know yet” use consistent language.

## Verification

The focused [Playwright suite](flow.spec.mjs) passed **15 of 15 scenarios** against the real application server, Chrome, an in-memory database, and deterministic demo generation. It covers warm-up skips, unanswered and missed step skips, refresh persistence, return-and-retry, paused coaching, optional ready/pending checks, progression between problems, review skips without writes, lesson skips, and returning from prerequisite review. Phone checks verify that post-answer decisions are visible without manual scrolling, and include a dark-theme practice capture. Phone coverage uses browser viewport emulation. A pending-check case holds just that browser response in the pending state; its miss and navigation still use the real server.

The application suite passed **270 of 270 tests**; TypeScript checking and the production web build passed. The focused suite uses a separate [server](flow-server.ts), [configuration](flow.config.mjs), and [results](flow-results/results.json), preserving the earlier audit. It never uses the normal `~/.learn` database. This follow-up concentrates on practice, lesson, and review flows; it does not repeat every screen or exercise live AI providers or physical phones.

Evidence: [practice decisions on desktop](flow-results/screenshots/practice-wrong-desktop.png), [320px decisions](flow-results/screenshots/practice-wrong-320.png), [dark theme at 390px](flow-results/screenshots/practice-wrong-390-dark.png), [step after skipping at 390px](flow-results/screenshots/practice-after-skip-390.png), [optional check being prepared](flow-results/screenshots/practice-optional-check-pending-desktop.png), [lesson decisions on a phone](flow-results/screenshots/lesson-wrong-390.png).

## Repeat the focused check

With app and audit dependencies installed, run `npm run test:flow` in `docs/ui-audit`. It builds the UI and starts the disposable server at `127.0.0.1:4330`.

The temporary tools used for this review can also run it from the repository root after `npm --prefix app run build:web`:

```sh
LEARN_AUDIT_MODULES=/private/tmp/learn-ui-audit-tools/node_modules \
  node /private/tmp/learn-ui-audit-tools/node_modules/@playwright/test/cli.js \
  test --config docs/ui-audit/flow.config.mjs
```

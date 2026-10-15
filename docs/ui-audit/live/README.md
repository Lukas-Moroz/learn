# Real ChatGPT generation test — October 8, 2026

**Passed using the signed-in app and its selected `gpt-5.6-sol` model.** Five real generation jobs completed successfully through the OpenAI provider. None used mock content or Claude, and none needed a validation repair. This was a short browser smoke test of generation and persistence, rather than a complete course or a statistical teaching-quality evaluation.

The test created one lesson, [Conditional Probability Through Weather](http://127.0.0.1:4317/#/lesson/7a44f887-4846-430b-92dc-34e7055b32a4), in the normal app database. Existing lessons were not answered or edited. Claude fallback was disabled during requests and restored to its original enabled setting afterwards.

| Check | Result | Generation time |
|---|---|---|
| Start a learning goal from the home UI | Real four-concept plan saved | 16.1 seconds |
| Continue to a diagnostic | Real question and answer options rendered | 20.1 seconds |
| Answer “I don't know” and continue | Real explanation, equations, and a Mermaid diagram rendered | 24.6 seconds |
| Generate the next understanding check | New scenario and question saved | 18.7 seconds |
| Answer with written reasoning | Choice graded correct; reasoning judged `sound`, with no issues | 34.6 seconds |
| Refresh the page | All block IDs and the evaluated answer remained identical | Passed; no new generation |

Evidence: [provider job receipts](jobs.json), [browser results](results.json), [saved lesson response](lesson.json), [generated content screenshot](03-explanation-and-check.png), and [reasoning feedback screenshot](04-reasoning-feedback.png). The receipts were collected with a read-only SQLite connection and contain job metadata, not credentials. Every generation receipt records `provider: openai` and `status: completed`.

The initial browser harness had a missing base URL after the successful planning request. It was corrected and the existing test lesson was resumed, so planning was not repeated. [The initial record](planning-run.json) documents that harness failure separately from the successful application request.

## Findings from real content

**Fix choice references in generated feedback.** The diagnostic feedback says “Option B reverses outcome and event,” but the UI numbers choices and displays the shuffled order D, C, B, A. Option B is therefore visible as choice 3, and its letter is never shown. Refer to answer text in feedback, or render stable identifiers that match the explanation. Add a generation check for references to identifiers the learner cannot see. This matters because otherwise a mathematically correct explanation can appear to contradict the visible choices.

**Make long generation waits understandable.** Explanation plus follow-up question took about 43 seconds of provider time; evaluating reasoning took about 35 seconds. Keep stage-specific progress and cancellation easy to find and explain that written reasoning is being evaluated separately from the choice. A short standalone sample should not be treated as a latency benchmark.

**Improve navigation through generated lessons.** The full lesson capture was over 4,700 pixels tall after the first explanation/check. Collapsible completed cards and a jump to the current activity would help. The real explanation was coherent, distinguished outcomes from events, and used a different weather scenario for the check; the main difficulty was navigating its accumulated content.

This test checks completed inference, rather than relying on the connected badge alone, following the [official OpenAI verification guidance](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

## Run again intentionally

With the app already running and ChatGPT selected:

```bash
cd docs/ui-audit
LEARN_LIVE_TEST=1 node live-generation.mjs
```

The script uses the audit dependencies, creates a new test lesson, temporarily disables Claude fallback, and asks for an answer JSON after displaying the generated question. Supply a zero-based option index and written reasoning, for example `{"index":1,"note":"Your explanation of the selected answer."}`. Each run consumes plan allowance. The current report's generated scenario is not guaranteed to recur.

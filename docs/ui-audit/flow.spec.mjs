// Learning-flow regressions use the real application with disposable deterministic fixtures.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const modules = process.env.LEARN_AUDIT_MODULES;
const { test, expect } = await import(modules ? pathToFileURL(path.join(modules, '@playwright/test/index.mjs')).href : '@playwright/test');
const here = path.dirname(fileURLToPath(import.meta.url));
const output = process.env.LEARN_FLOW_OUTPUT || path.join(here, 'flow-results');
const headers = { 'x-learn': '1' };
let fixture;

test.beforeEach(async ({ page, request }) => {
  const response = await request.post('/__audit/reset', { headers });
  expect(response.ok(), 'Use the disposable flow server supplied with this suite').toBeTruthy();
  fixture = await response.json();
  const status = await (await request.get('/api/status')).json();
  expect(status.active).toBe('mock');
  expect(status.dataDir).not.toMatch(/\/\.learn\/?$/);
  // Keep account/provider metadata out of the regression captures.
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const provider of body.providers) delete provider.account;
    await route.fulfill({ response, json: body });
  });
  await fs.mkdir(path.join(output, 'screenshots'), { recursive: true });
});

const step = (page, id) => page.locator(`#step-${id}`);
async function snapshot(request, id) {
  return (await request.get(`/api/practice/problems/${id}`)).json();
}
async function practice(page, request, index = 0, skipFirst = false) {
  const id = fixture.problemIds[index];
  await request.post(`/api/practice/problems/${id}/primer/skip`, { headers });
  const p = await snapshot(request, id);
  if (skipFirst) await request.post(`/api/practice/steps/${p.steps[0].id}/skip`, { headers });
  await page.goto(`/#/practice/${fixture.setId}/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: `Problem ${index + 1}: ${p.title}` })).toBeVisible();
  return p;
}
async function wrongNumber(page, request, { pause = false } = {}) {
  const p = await practice(page, request, 0, true);
  if (pause) await request.post('/__audit/pause-coaching', { headers });
  const card = step(page, p.steps[1].id);
  await card.locator('.step-answer input').fill('999');
  await card.getByRole('button', { name: 'Sure', exact: true }).click();
  await card.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(card.locator('.verdict')).toContainText('Not quite');
  return { p, card };
}
async function capture(page, name) {
  await page.screenshot({ path: path.join(output, 'screenshots', `${name}.png`) });
}

test('practice: optional warm-up can be skipped to start the problem', async ({ page, request }) => {
  const p = await snapshot(request, fixture.problemIds[0]);
  await page.goto(`/#/practice/${fixture.setId}/${p.id}`);
  await page.getByRole('button', { name: 'Skip warm-up', exact: true }).click();
  await expect(step(page, p.steps[0].id).locator('.step-answer input').first()).toBeFocused();
  await expect(step(page, p.steps[0].id).getByRole('button', { name: 'Check answer', exact: true })).toBeEnabled();
  const saved = await snapshot(request, p.id);
  expect(saved.primer.status).toBe('skipped');
  expect(saved.steps[0].attempts).toEqual([]);
});

test('practice: skip an unanswered step, persist it, and return to try it', async ({ page, request }) => {
  const p = await practice(page, request);
  await step(page, p.steps[0].id).getByRole('button', { name: 'Skip step', exact: true }).click();
  const next = step(page, p.steps[1].id);
  await expect(next.locator('.step-answer input')).toBeFocused();
  await expect(next).toBeInViewport();
  const saved = await snapshot(request, p.id);
  expect(saved.steps[0].status).toBe('skipped');
  expect(saved.steps[0].attempts).toEqual([]);
  expect(saved.steps[0].reveal).toBeUndefined();
  await capture(page, 'practice-after-skip-desktop');
  await page.reload();
  await expect(next.getByRole('button', { name: 'Check answer', exact: true })).toBeVisible();
  const prior = page.locator(`#fold-${p.steps[0].id}`);
  await prior.locator('summary').first().click();
  await prior.getByRole('button', { name: 'Try this step', exact: true }).click();
  await expect(prior.locator('.step-answer input').first()).toBeFocused();
  await expect(prior.getByRole('button', { name: 'Check answer', exact: true })).toBeEnabled();
});

test('practice: wrong answer offers nearby choices and skip reaches the next step', async ({ page, request }) => {
  const { p, card } = await wrongNumber(page, request);
  const decision = card.locator('.step-decision');
  await expect(decision.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await expect(decision.getByRole('button', { name: 'Show solution', exact: true })).toBeEnabled();
  await expect(decision.getByRole('button', { name: 'Skip step', exact: true })).toBeEnabled();
  expect(await card.evaluate((el) => {
    const choice = el.querySelector('.step-decision');
    const coach = el.querySelector('.coach');
    return !coach || Boolean(choice.compareDocumentPosition(coach) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await capture(page, 'practice-wrong-desktop');
  await decision.getByRole('button', { name: 'Skip step', exact: true }).click();
  await expect(step(page, p.steps[2].id).locator('.step-answer textarea')).toBeFocused();
  const saved = await snapshot(request, p.id);
  expect(saved.steps[1].status).toBe('skipped');
  expect(saved.steps[1].attempts).toHaveLength(1);
  expect(saved.steps[1].attempts[0].correct).toBe(false);
  expect(saved.steps[1].reveal).toBeUndefined();
});

test('practice: paused coaching allows retry and skipping without waiting', async ({ page, request }) => {
  const { p, card } = await wrongNumber(page, request, { pause: true });
  await request.post('/__audit/idle', { headers });
  await page.reload();
  await expect(card.getByText('Waiting for AI.', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(card.locator('.step-answer input')).toHaveValue('999');
  await expect(card.locator('.step-answer input')).toBeFocused();
  await card.getByRole('button', { name: 'Skip step', exact: true }).click();
  await expect(step(page, p.steps[2].id).locator('.step-answer textarea')).toBeFocused();
});

test('practice: opening optional explanation never requires its check before retry', async ({ page, request }) => {
  const { card } = await wrongNumber(page, request);
  await request.post('/__audit/idle', { headers });
  await page.reload();
  await card.locator('.coach-full > summary').click();
  await expect(card.locator('.coach-full .question')).toBeVisible();
  await expect(card.locator('.coach-full .feedback')).toHaveCount(0);
  await expect(card.locator('.step-decision').getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await capture(page, 'practice-optional-check-desktop');
  await card.locator('.step-decision').getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(card.locator('.step-answer input')).toBeFocused();
  await expect(card.locator('.step-answer input')).toHaveValue('999');
});

test('practice: a pending optional check does not disable retry or skip', async ({ page, request }) => {
  const { p, card } = await wrongNumber(page, request);
  await request.post('/__audit/idle', { headers });
  // Hold just the question preparation state in the browser while retaining the real miss and navigation API.
  await page.route(`**/api/practice/problems/${p.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const coaching = body.steps[1].coaching.at(-1);
    coaching.check = null;
    coaching.checkStatus = 'pending';
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await card.locator('.coach-full > summary').click();
  await expect(card.locator('.coach-full').getByText('Optional quick check', { exact: true })).toBeVisible();
  const choices = card.locator('.step-decision');
  await expect(choices.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await expect(choices.getByRole('button', { name: 'Skip step', exact: true })).toBeEnabled();
  await choices.scrollIntoViewIfNeeded();
  await capture(page, 'practice-optional-check-pending-desktop');
  await choices.getByRole('button', { name: 'Skip step', exact: true }).click();
  await expect(step(page, p.steps[2].id).locator('.step-answer textarea')).toBeFocused();
});

test('practice: skipping the final step opens the next problem, then all problems', async ({ page, request }) => {
  const first = await practice(page, request);
  for (const s of first.steps) await step(page, s.id).getByRole('button', { name: 'Skip step', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/practice/${fixture.setId}/${fixture.problemIds[1]}$`));
  const second = await snapshot(request, fixture.problemIds[1]);
  await request.post(`/api/practice/problems/${second.id}/primer/skip`, { headers });
  await page.reload();
  for (const s of second.steps) await step(page, s.id).getByRole('button', { name: 'Skip step', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/practice/${fixture.setId}$`));
  expect((await snapshot(request, second.id)).steps.every((s) => s.status === 'skipped')).toBe(true);
  await expect(page.getByRole('link', { name: 'Revisit skipped steps', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Revisit skipped steps', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/practice/${fixture.setId}/${first.id}$`));
});

for (const width of [390, 320]) {
  test(`practice: wrong-answer choices and skipped destination fit ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    const { p, card } = await wrongNumber(page, request);
    const choices = card.locator('.step-decision');
    await expect(choices).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const name of ['Try again', 'Show solution', 'Skip step']) await expect(choices.getByRole('button', { name, exact: true })).toBeInViewport();
    await capture(page, `practice-wrong-${width}`);
    if (width === 390) {
      await page.getByRole('button', { name: /Theme:/ }).click();
      await page.getByRole('button', { name: /Theme:/ }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      for (const name of ['Try again', 'Show solution', 'Skip step']) await expect(choices.getByRole('button', { name, exact: true })).toBeInViewport();
      await capture(page, 'practice-wrong-390-dark');
      await page.getByRole('button', { name: /Theme:/ }).click();
    }
    await choices.getByRole('button', { name: 'Skip step', exact: true }).click();
    await expect(step(page, p.steps[2].id).locator('.step-answer textarea')).toBeFocused();
    await expect(step(page, p.steps[2].id).locator('.step-answer textarea')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await capture(page, `practice-after-skip-${width}`);
  });
}

test('review: wrong answer advances directly; skip leaves the next question due', async ({ page, request }) => {
  await request.post('/__audit/review', { headers });
  await page.goto('/#/review');
  await expect(page.getByText('Question 1 of 2', { exact: true })).toBeVisible();
  const initial = (await (await request.get('/api/review')).json()).filter((i) => i.due);
  const card = page.locator('.question:visible');
  await card.getByRole('radio', { name: 'The idea has no connection to probability or information.', exact: true }).click();
  await card.getByRole('button', { name: 'Sure', exact: true }).click();
  await card.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(card.locator('.verdict')).toContainText('Not quite');
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(page.getByText('Question 2 of 2', { exact: true })).toBeVisible();
  await expect(page.locator('.question:visible')).toHaveCount(1);
  let writes = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/review')) writes++; });
  await page.getByRole('button', { name: 'Skip question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review finished', exact: true })).toBeVisible();
  expect(writes).toBe(0);
  const stillDue = (await (await request.get('/api/review')).json()).filter((i) => i.due);
  expect(stillDue.some((i) => i.question.id === initial[1].question.id)).toBe(true);
  await page.getByRole('button', { name: 'Review skipped questions', exact: true }).click();
  await expect(page.getByText('Question 2 of 2', { exact: true })).toBeVisible();
  await expect(page.locator('.question:visible .feedback')).toHaveCount(0);
});

test('review: skipping everything records no answers and can be revisited', async ({ page, request }) => {
  await request.post('/__audit/review', { headers });
  await page.goto('/#/review');
  let writes = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/review')) writes++; });
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Skip question', exact: true }).click();
  await expect(page.getByText('No answers recorded this time.', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect((await (await request.get('/api/review')).json()).filter((i) => i.due)).toHaveLength(2);
  await page.getByRole('button', { name: 'Review skipped questions', exact: true }).click();
  await expect(page.getByText('Question 1 of 2', { exact: true })).toBeVisible();
});

async function lesson(page, request, detour = false) {
  const response = await request.post(detour ? '/__audit/detour' : '/__audit/lesson', { headers });
  expect(response.ok(), await response.text()).toBeTruthy();
  const seeded = await response.json();
  await page.goto(`/#/lesson/${seeded.lessonId}`);
  await expect(page.getByRole('button', { name: 'Check answer', exact: true })).toBeVisible();
  const resume = page.getByRole('button', { name: 'Continue: answer the open question', exact: true });
  if (await resume.isVisible()) await resume.click();
  return seeded;
}

async function skipLesson(page, seeded, label) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/lessons/${seeded.lessonId}/skip`)),
    page.getByRole('button', { name: label, exact: true }).click(),
  ]);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('lesson: skip an unanswered concept and keep the next question after reload', async ({ page, request }) => {
  const seeded = await lesson(page, request);
  const view = await skipLesson(page, seeded, 'Skip this concept');
  expect(view.state.conceptId).not.toBe(seeded.conceptId);
  const prior = view.blocks.find((b) => b.question?.id === seeded.questionId).question;
  expect(prior.skipped).toBe(true);
  expect(prior.attempt).toBeUndefined();
  expect(view.concepts.find((c) => c.conceptId === seeded.conceptId).status).toBe('deferred');
  await expect(page.locator('.question:visible').last()).toBeInViewport();
  await capture(page, 'lesson-after-skip-desktop');
  await page.reload();
  const restored = await (await request.get(`/api/lessons/${seeded.lessonId}`)).json();
  expect(restored.state.pendingQuestionId).toBe(view.state.pendingQuestionId);
  await expect(page.getByRole('button', { name: 'Check answer', exact: true })).toBeVisible();
});

for (const width of [1440, 390]) {
test(`lesson: wrong answer explains the next action and lets the learner move on at ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const seeded = await lesson(page, request);
  const card = page.locator('.question:visible').last();
  await card.getByRole('radio').nth(seeded.wrongIndex).click();
  await card.getByRole('button', { name: 'Sure', exact: true }).click();
  await card.getByRole('button', { name: 'Check answer', exact: true }).click();
  await expect(card.locator('.verdict')).toContainText('Not quite');
  await expect(card.locator('.feedback[aria-label="Answer feedback"]')).toBeFocused();
  await expect(page.getByRole('button', { name: 'See a different explanation', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Skip this concept', exact: true })).toBeEnabled();
  if (width === 390) {
    await expect(page.getByRole('button', { name: 'See a different explanation', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Skip this concept', exact: true })).toBeInViewport();
  }
  await capture(page, width === 390 ? 'lesson-wrong-390' : 'lesson-wrong-desktop');
  if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const view = await skipLesson(page, seeded, 'Skip this concept');
  expect(view.state.conceptId).not.toBe(seeded.conceptId);
  expect(view.blocks.find((b) => b.question?.id === seeded.questionId).question.attempt.correct).toBe(false);
  await expect(page.locator('.question:visible').last()).toBeInViewport();
});
}

test('lesson: skip prerequisite review and return to the original concept', async ({ page, request }) => {
  const seeded = await lesson(page, request, true);
  await expect(page.getByRole('button', { name: 'Skip prerequisite review', exact: true })).toBeEnabled();
  const view = await skipLesson(page, seeded, 'Skip prerequisite review');
  expect(view.state.detours).toBe(0);
  expect(view.state.conceptId).toBe(seeded.originalConceptId);
  expect(view.blocks.find((b) => b.question?.id === seeded.questionId).question.skipped).toBe(true);
  await expect(page.locator('.question:visible').last()).toBeInViewport();
});

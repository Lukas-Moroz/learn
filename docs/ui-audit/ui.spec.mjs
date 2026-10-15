// Run only against a disposable LEARN_PROVIDER=mock server: these tests create lessons/courses.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const modules = process.env.LEARN_AUDIT_MODULES;
const { test, expect } = await import(modules ? pathToFileURL(path.join(modules, '@playwright/test/index.mjs')).href : '@playwright/test');
const { default: AxeBuilder } = await import(modules ? pathToFileURL(path.join(modules, '@axe-core/playwright/dist/index.mjs')).href : '@axe-core/playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const screenshots = path.join(here, 'screenshots');

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post('/__audit/reset', { headers: { 'x-learn': '1' } });
  expect(reset.ok(), 'Use the disposable server supplied with this suite').toBeTruthy();
  const status = await (await request.get('/api/status')).json();
  expect(status.active, 'Use a disposable mock server for this audit').toBe('mock');
  expect(status.dataDir, 'Never run this audit against the normal user database').not.toMatch(/\/\.learn\/?$/);
  await fs.mkdir(screenshots, { recursive: true });
  // Hide account metadata in screenshots/traces. Generation still uses the real mock server.
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const provider of body.providers) delete provider.account;
    await route.fulfill({ response, json: body });
  });
});

async function home(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Probabilistic Models (demo)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demo mode', exact: true })).toBeVisible();
}

async function freshLesson(page, request) {
  const response = await request.post('/api/lessons', { headers: { 'x-learn': '1' }, data: { objective: 'Understand second-order Markov models' } });
  expect(response.ok()).toBeTruthy();
  const { lessonId } = await response.json();
  await page.goto(`/#/lesson/${lessonId}`);
  await openFirstQuestion(page);
  return lessonId;
}

async function openFirstQuestion(page) {
  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  const proceed = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(submit.or(proceed)).toBeVisible();
  if (await proceed.isVisible()) await proceed.click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
}

async function mathOnlyQuestion(page, request) {
  await freshLesson(page, request);
  await expect(page.locator('.options .katex').first()).toBeVisible();
}

async function capture(page, name, fullPage = true) {
  await page.screenshot({ path: path.join(screenshots, name + '.png'), fullPage });
}

test('01 desktop and phone visual inspection captures', async ({ page }) => {
  await home(page);
  await capture(page, 'home-desktop');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await capture(page, `home-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await capture(page, 'settings-desktop');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('02 create course, upload PDF, start source lesson, render and navigate PDF', async ({ page }) => {
  await home(page);
  const title = `UI audit upload ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Course title' }).fill(title);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card).toBeVisible();
  const dataDir = process.env.LEARN_AUDIT_DATA || '/private/tmp/learn-ui-audit-isolated';
  const files = await fs.readdir(path.join(dataDir, 'sources'));
  const pdf = files.find(file => file.endsWith('.pdf'));
  expect(pdf, 'Seed the demo before running').toBeTruthy();
  await card.locator('input[type=file]').setInputFiles({ name: 'Lecture 4 - Markov Chains.pdf', mimeType: 'application/pdf', buffer: await fs.readFile(path.join(dataDir, 'sources', pdf)) });
  await expect(card.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await capture(page, 'lesson-desktop');
  await page.locator('.navstrip .item').filter({ hasText: 'Source' }).getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Original source' });
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect.poll(() => dialog.locator('canvas').evaluate(c => c.width)).toBeGreaterThan(300);
  await capture(page, 'source-desktop');
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog).toContainText('page 4 of 12');
  await dialog.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(dialog.locator('.page-text')).not.toBeEmpty();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog).toContainText('page 3 of 12');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'lesson-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('radio').nth(1).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Sure', exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.feedback .verdict').last()).toContainText(/Correct|Not quite/);
  const verdict = await page.locator('.feedback .verdict').last().innerText();
  await capture(page, 'answer-feedback');
  await page.reload();
  await expect(page.locator('.feedback .verdict').last()).toHaveText(verdict);
  await expect(page.getByRole('region', { name: 'Where you left off' })).toBeVisible();
});

test('03 objective entry starts a lesson', async ({ page }) => {
  await home(page);
  await page.getByRole('textbox', { name: 'Learning objective' }).fill('Understand second-order Markov models');
  await page.getByRole('textbox', { name: 'Learning objective' }).press('Enter');
  await expect(page).toHaveURL(/#\/lesson\//);
  await openFirstQuestion(page);
});

test('04 answer draft and reasoning survive refresh', async ({ page, request }) => {
  await freshLesson(page, request);
  await page.getByRole('radio').nth(1).click();
  await page.getByRole('button', { name: 'Unsure', exact: true }).click();
  await page.getByRole('button', { name: /Explain your reasoning/ }).click();
  await page.getByRole('textbox').fill('I subtract the chance of blue from one.');
  await page.reload();
  await expect(page.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Unsure', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox')).toHaveValue('I subtract the chance of blue from one.');
});

test('05 I do not know leads to a new explanation and question', async ({ page, request }) => {
  await freshLesson(page, request);
  await page.getByRole('radio', { name: "I don't know", exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.feedback .verdict').last()).toContainText("don't know yet");
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await expect(page.locator('.question')).toHaveCount(2);
  await capture(page, 'remediation-desktop');
});

test('06 selected answer exposes a meaningful accessible name', async ({ page, request }) => {
  await mathOnlyQuestion(page, request);
  await expect(page.getByRole('radio').first()).toHaveAccessibleName(/\S/);
});

test('07 lesson has no serious or critical axe violations', async ({ page, request }) => {
  await mathOnlyQuestion(page, request);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await fs.writeFile(path.join(here, 'accessibility.json'), JSON.stringify(result.violations, null, 2));
  expect(result.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, count: v.nodes.length }))).toEqual([]);
});

test('08 Settings traps focus and restores it on Escape', async ({ page }) => {
  await home(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI providers' });
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await expect.soft(dialog).toHaveAttribute('aria-modal', 'true');
  let escaped = false;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    if (!await page.evaluate(() => !!document.activeElement.closest('[role=dialog]'))) { escaped = true; break; }
  }
  expect.soft(escaped, 'Tab must remain inside an open modal').toBe(false);
  await page.keyboard.press('Escape');
  await expect.soft(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('09 newly generated question is brought into the viewport', async ({ page, request }) => {
  await freshLesson(page, request);
  await page.getByRole('radio', { name: "I don't know", exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await capture(page, 'new-question-viewport', false);
  await expect(page.locator('.question').last()).toBeInViewport();
});

test('10 Enter on confidence selects confidence without submitting', async ({ page, request }) => {
  await freshLesson(page, request);
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Sure', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Sure', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  await expect(page.locator('.feedback')).toHaveCount(0);
});

test('11 mobile home fits 390 and 320 pixel viewports', async ({ page }) => {
  await home(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect.soft(scrollWidth, `Home must fit width ${width}`).toBeLessThanOrEqual(width);
  }
});

test('12 failed course creation displays an actionable error', async ({ page }) => {
  await home(page);
  await page.route('**/api/courses', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: { code: 'error', message: 'Could not save course. Try again.' } } }) : route.continue());
  await page.getByRole('textbox', { name: 'Course title' }).fill('Network failure example');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await capture(page, 'course-create-failure');
  await expect(page.getByText('Could not save course. Try again.', { exact: true })).toBeVisible();
});

test('13 failed home load offers an error and retry', async ({ page }) => {
  await page.route('**/api/courses', route => route.fulfill({ status: 503, json: { error: { code: 'error', message: 'Server temporarily unavailable' } } }));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Course title' })).toBeVisible();
  await capture(page, 'home-load-failure');
  await expect(page.getByRole('button', { name: /retry|try again/i })).toBeVisible();
});

test('14 failed source fetch reports an error rather than an empty page', async ({ page }) => {
  await home(page);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Probabilistic Models (demo)', exact: true }) });
  await card.locator('.lecture-row').getByRole('button', { name: /Continue|Start/ }).click();
  await expect(page.locator('.navstrip')).toBeVisible();
  await page.route('**/api/sources/*/pages/*', route => route.fulfill({ status: 503, json: { error: { code: 'error', message: 'Source temporarily unavailable' } } }));
  await page.locator('.navstrip .item').filter({ hasText: 'Source' }).getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Original source' });
  await expect(dialog).toBeVisible();
  await capture(page, 'source-load-failure');
  await expect(dialog.getByText(/could not|failed|unavailable|try again/i)).toBeVisible();
});

test('15 concepts filter distinguishes no results from no studied concepts', async ({ page, request }) => {
  await freshLesson(page, request);
  await page.getByRole('link', { name: 'Concepts', exact: true }).click();
  await expect(page.locator('details').first()).toBeVisible();
  await capture(page, 'concepts-desktop');
  await page.getByRole('textbox', { name: 'Filter concepts' }).fill('nonexistent-xyz');
  await expect(page.getByText(/no (matching concepts|results|matches)/i)).toBeVisible();
});

test('16 review, concept details, progress drawer and dark theme work', async ({ page, request }) => {
  await freshLesson(page, request);
  await page.locator('.navstrip .item').filter({ hasText: 'Progress' }).getByRole('button').click();
  await expect(page.getByRole('dialog', { name: 'Lesson progress' })).toBeVisible();
  await capture(page, 'progress-desktop');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  await capture(page, 'review-desktop');
  await page.getByRole('link', { name: 'Concepts', exact: true }).click();
  await expect(page.locator('details').first()).toBeVisible();
  await page.locator('details').first().locator('summary').click();
  await expect(page.locator('details').first()).toHaveAttribute('open', '');
  await page.getByRole('button', { name: /Theme:/ }).click();
  await page.getByRole('button', { name: /Theme:/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await capture(page, 'concepts-dark');
  const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
  expect(violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)).toEqual([]);
});

test('17 a wrong answer schedules review and stored review questions can be answered', async ({ page, request }) => {
  await freshLesson(page, request);
  const labels = await page.locator('.options .option').allTextContents();
  const wrong = labels.findIndex(label => !label.includes('\\tfrac{2}{3}'));
  expect(wrong).toBeGreaterThanOrEqual(0);
  await page.locator('.options .option').nth(wrong).click();
  await page.getByRole('button', { name: 'Sure', exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.feedback .verdict')).toContainText('Not quite');
  await page.getByRole('link', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await capture(page, 'review-question');
  await page.getByRole('radio', { name: "I don't know", exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.feedback .verdict')).toContainText("don't know yet");
  await capture(page, 'review-feedback');
});

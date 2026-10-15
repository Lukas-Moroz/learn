// Explicit opt-in: consumes ChatGPT plan allowance and creates one clearly labelled test lesson.
// Use the existing signed-in app. Do not point this at the disposable mock server.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
if (process.env.LEARN_LIVE_TEST !== '1') throw new Error('Set LEARN_LIVE_TEST=1 to authorize real generation.');
const modules = process.env.LEARN_AUDIT_MODULES;
const { chromium, expect } = await import(modules ? pathToFileURL(path.join(modules, '@playwright/test/index.mjs')).href : '@playwright/test');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'live');
await fs.mkdir(dir, { recursive: true });
const url = process.env.LEARN_LIVE_URL || 'http://127.0.0.1:4317';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 1000 }, timezoneId: 'Pacific/Honolulu', colorScheme: 'light' });
const page = await context.newPage();
page.setDefaultTimeout(180000);
const result = { startedAt: new Date().toISOString(), url, steps: [], errors: [], api: [] };
const start = Date.now();
let originalSettings;
let fallbackChanged = false;
let lessonId;
page.on('pageerror', e => result.errors.push(e.message));
page.on('response', response => {
  const u = new URL(response.url());
  if (u.pathname.startsWith('/api/') && response.request().method() === 'POST') {
    const record = { path: u.pathname, status: response.status(), elapsedMs: Date.now() - start };
    result.api.push(record);
    console.log('API', JSON.stringify(record));
  }
});
await page.route('**/api/status', async route => {
  const response = await route.fetch();
  const body = await response.json();
  for (const provider of body.providers) delete provider.account;
  await route.fulfill({ response, json: body });
});
async function step(name, fn) {
  const began = Date.now();
  console.log('START', name);
  await fn();
  const record = { name, status: 'passed', elapsedMs: Date.now() - began };
  result.steps.push(record);
  console.log('PASS', JSON.stringify(record));
  await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(result, null, 2));
}
async function snapshot(name) { await page.screenshot({ path: path.join(dir, name + '.png'), fullPage: true }); }
async function view() { return (await page.request.get(`/api/lessons/${lessonId}`)).json(); }
try {
  const status = await (await page.request.get(url + '/api/status')).json();
  const provider = status.providers.find(p => p.id === 'openai');
  expect(status.active).toBe('openai');
  expect(provider.ready).toBe(true);
  result.provider = { id: provider.id, model: provider.model, state: provider.state };
  result.dataDir = status.dataDir;
  originalSettings = status.settings;
  if (originalSettings.claudeFallback) {
    const changed = await page.request.patch(url + '/api/settings/providers', { headers: { 'x-learn': '1' }, data: { claudeFallback: false } });
    expect(changed.ok()).toBeTruthy();
    fallbackChanged = true;
  }
  await step('Live lesson planning through the home UI', async () => {
    if (process.env.LEARN_LIVE_LESSON) {
      lessonId = process.env.LEARN_LIVE_LESSON;
      result.lessonId = lessonId;
      result.resumedExistingTestLesson = true;
      await page.goto(`${url}/#/lesson/${lessonId}`);
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible({ timeout: 20000 });
      const v = await view();
      expect(v.blocks.some(b => b.type === 'plan')).toBe(true);
      result.title = v.lesson.title;
      result.path = v.concepts.map(c => ({ name: c.name, role: c.role }));
      await snapshot('01-plan');
      return;
    }
    await page.goto(url);
    await page.getByRole('textbox', { name: 'Learning objective' }).fill(`Live AI test ${new Date().toISOString()}: Teach me conditional probability using weather examples. Keep the path short: probability basics and conditional probability.`);
    const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/lessons' && r.request().method() === 'POST', { timeout: 180000 });
    await page.getByRole('textbox', { name: 'Learning objective' }).press('Enter');
    const response = await responsePromise;
    const body = await response.json();
    expect(response.ok(), JSON.stringify(body)).toBeTruthy();
    lessonId = body.lessonId;
    result.lessonId = lessonId;
    await expect(page).toHaveURL(new RegExp(lessonId), { timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible({ timeout: 20000 });
    const v = await view();
    expect(v.blocks.some(b => b.type === 'plan')).toBe(true);
    result.title = v.lesson.title;
    result.path = v.concepts.map(c => ({ name: c.name, role: c.role }));
    await snapshot('01-plan');
  });
  await step('Generate a real diagnostic question', async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible({ timeout: 180000 });
    const v = await view();
    const q = v.blocks.find(b => b.question?.id === v.state.pendingQuestionId)?.question;
    expect(q?.options.length).toBeGreaterThan(1);
    result.diagnostic = q;
    console.log('DIAGNOSTIC', JSON.stringify(q));
    await snapshot('02-diagnostic');
  });
  await step('I do not know triggers a real explanation and a new check', async () => {
    await page.getByRole('radio', { name: "I don't know", exact: true }).click();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.locator('.feedback .verdict').last()).toContainText("don't know yet", { timeout: 20000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible({ timeout: 180000 });
    const v = await view();
    const explanations = v.blocks.filter(b => b.type === 'explanation');
    expect(explanations.length).toBeGreaterThan(0);
    result.explanation = explanations.at(-1);
    const q = v.blocks.find(b => b.question?.id === v.state.pendingQuestionId)?.question;
    expect(q.id).not.toBe(result.diagnostic.id);
    result.check = q;
    console.log('EXPLANATION', JSON.stringify(result.explanation.payload));
    console.log('READY_FOR_ANSWER', JSON.stringify(q));
    await snapshot('03-explanation-and-check');
  });
  // Human/agent chooses a real answer from the generated question instead of
  // hard-coding an answer position or inspecting hidden answer keys.
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = JSON.parse(await input.question('ANSWER_JSON {"index":0,"note":"..."}: '));
  input.close();
  await step('Submit an answer with written reasoning and receive real evaluation', async () => {
    expect(Number.isInteger(answer.index)).toBe(true);
    expect(answer.index).toBeGreaterThanOrEqual(0);
    expect(answer.index).toBeLessThan(result.check.options.length);
    expect(answer.note.length).toBeGreaterThan(10);
    const card = page.locator('.question').last();
    await card.locator('.options .option').nth(answer.index).click();
    await card.getByRole('button', { name: 'Sure', exact: true }).click();
    await card.getByRole('button', { name: /Explain your reasoning/ }).click();
    await card.getByRole('textbox').fill(answer.note);
    await card.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(card.locator('.feedback')).toBeVisible({ timeout: 180000 });
    const v = await view();
    const q = v.blocks.find(b => b.question?.id === result.check.id).question;
    expect(q.attempt.reasoningStatus).toBe('done');
    expect(q.attempt.reasoning?.summary.length).toBeGreaterThan(0);
    result.answer = answer;
    result.attempt = q.attempt;
    console.log('FEEDBACK', JSON.stringify(q.attempt));
    await snapshot('04-reasoning-feedback');
  });
  await step('Generated content and evaluated answer survive refresh', async () => {
    const before = await view();
    await page.reload();
    await expect(page.locator('.feedback').last()).toBeVisible({ timeout: 20000 });
    const after = await view();
    expect(after.blocks.map(b => b.id)).toEqual(before.blocks.map(b => b.id));
    const q = after.blocks.find(b => b.question?.id === result.check.id).question;
    expect(q.attempt).toEqual(result.attempt);
    await snapshot('05-resumed');
  });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.failure = { message: error.message, stack: error.stack };
  console.error('FAILED', error.message);
  await snapshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  if (lessonId) await fs.writeFile(path.join(dir, 'lesson.json'), JSON.stringify(await view().catch(() => null), null, 2));
  if (fallbackChanged) {
    const restored = await page.request.patch(url + '/api/settings/providers', { headers: { 'x-learn': '1' }, data: { claudeFallback: originalSettings.claudeFallback } });
    result.fallbackRestored = restored.ok();
    console.log('FALLBACK_RESTORED', result.fallbackRestored);
  }
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
}

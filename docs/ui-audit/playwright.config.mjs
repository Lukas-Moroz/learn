import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export default {
  testDir: here,
  testMatch: 'ui.spec.mjs',
  timeout: 45000,
  expect: { timeout: 5000 },
  workers: 1,
  retries: 0,
  webServer: {
    command: 'node --import tsx ../docs/ui-audit/server.ts',
    cwd: path.resolve(here, '../../app'),
    url: 'http://127.0.0.1:4329/api/status',
    reuseExistingServer: false,
    timeout: 30000,
  },
  outputDir: path.join(here, 'test-results'),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(here, 'results.json') }],
    ['html', { outputFolder: path.join(here, 'playwright-report'), open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4329',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Pacific/Honolulu',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
};

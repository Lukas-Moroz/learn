import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = process.env.LEARN_FLOW_OUTPUT || path.join(here, 'flow-results');
export default {
  testDir: here,
  testMatch: 'flow.spec.mjs',
  timeout: 45000,
  expect: { timeout: 7000 },
  workers: 1,
  retries: 0,
  webServer: {
    command: 'node --import tsx ../docs/ui-audit/flow-server.ts',
    cwd: path.resolve(here, '../../app'),
    url: 'http://127.0.0.1:4330/api/status',
    reuseExistingServer: false,
    timeout: 45000,
  },
  outputDir: path.join(output, 'tests'),
  reporter: [['list'], ['json', { outputFile: path.join(output, 'results.json') }], ['html', { outputFolder: path.join(output, 'report'), open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4330', channel: 'chrome', headless: true,
    viewport: { width: 1440, height: 1000 }, timezoneId: 'Pacific/Honolulu', colorScheme: 'light',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
};

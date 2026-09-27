import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.ACB_UI_TEST_DIR ||= resolve('.local', 'ui-tests', randomUUID());
export default defineConfig({
  testDir: './tests/ui', timeout: 30000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['json', { outputFile: '.local/ui-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:17861', channel: 'msedge', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node dist/server/main.js', url: 'http://127.0.0.1:17861/health', reuseExistingServer: false, timeout: 30000, env: { ACB_PORT: '17861', ACB_CALLBACK_PORT: '17863', ACB_DATA_DIR: process.env.ACB_UI_TEST_DIR } },
});

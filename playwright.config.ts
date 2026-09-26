import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests (e2e/*.spec.ts) against the production server, in the
 * locally installed Chrome (channel "chrome": no browser download). Each spec
 * starts its own server under a throwaway STORYSCRIPT_HOME (e2e/support.ts);
 * the global setup builds the web app once (skip with E2E_NO_BUILD=1).
 *
 *   npx playwright test            # or: npm run e2e
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '.look/e2e-results',
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

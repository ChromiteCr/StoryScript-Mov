/**
 * Screenshots of every page of the demo project at desktop width, for
 * checking typography and hierarchy by eye (S2d1). Writes .look/type/<label>/.
 *
 *   npx tsx scripts/type-shots.ts before
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { buildWeb, signInAnywhere, startApp } from '../e2e/support.ts';

const label = process.argv[2] ?? 'now';
const OUT = resolve(import.meta.dirname, '..', '.look', 'type', label);
mkdirSync(OUT, { recursive: true });

if (!process.env.E2E_NO_BUILD) buildWeb();
const app = await startApp({ demo: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'zh-CN' });
  await signInAnywhere(page, app);
  for (const view of ['script', 'boards', 'plan', 'set', 'media', 'deliver', 'settings']) {
    await page.goto(`${app.base}/#/${view}`);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${view}.png`) });
  }
} finally {
  await browser.close();
  await app.stop();
}
console.log(`写入 ${OUT}`);

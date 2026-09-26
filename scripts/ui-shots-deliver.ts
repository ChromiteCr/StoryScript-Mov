/**
 * Deliver page + demo mode screenshots (M7). Builds the web app, starts the
 * production server with --demo under a throwaway STORYSCRIPT_HOME (the demo
 * project is created and opened on start; AI replays fixtures/replay, nothing
 * leaves the machine) and captures, in the installed Chrome, at 1440x900 and
 * 390x844:
 *
 *   demo-1x-*     every workflow page of the demo project
 *   deliver-2x-*  the deliver checklist, a finished download, the board and
 *                 call-sheet print previews, the missing report in print media
 *   deliver-30-*  the checklist of a fresh, empty project
 *
 * PNGs go to .look/ui-deliver/.
 *
 *   npx tsx scripts/ui-shots-deliver.ts [--no-build] [--out .look/ui-deliver]
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';
import { buildWeb, createProject, ROOT, signIn, signInAnywhere, startApp, type RunningApp } from '../e2e/support.ts';

interface Size {
  name: string;
  width: number;
  height: number;
}

const DESKTOP: Size = { name: '1440', width: 1440, height: 900 };
const PHONE: Size = { name: '390', width: 390, height: 844 };
const PAGES = [
  ['script', '剧本'],
  ['boards', '分镜'],
  ['plan', '计划'],
  ['set', '现场'],
  ['media', '素材'],
  ['deliver', '交付'],
] as const;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(350);
}

async function shot(page: Page, out: string, size: Size, name: string, list: string[], fullPage = false): Promise<void> {
  await settle(page);
  const path = join(out, `${size.name}-${name}.png`);
  await page.screenshot({ path, fullPage });
  list.push(path);
  const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  if (overflow > 0) console.warn(`  ! ${size.name}-${name}: page scrolls sideways by ${overflow}px`);
  console.log(`  ${path}`);
}

async function go(page: Page, app: RunningApp, stage: string, title: string): Promise<void> {
  const url = `${app.base}/#/${stage}`;
  // same hash = no navigation (a print preview is page state): reload instead
  if (page.url() === url) await page.reload();
  else await page.goto(url);
  await page.getByRole('heading', { name: title, level: 1 }).waitFor();
}

async function walk(browser: Browser, app: RunningApp, out: string, size: Size): Promise<string[]> {
  const list: string[] = [];
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size === PHONE ? 2 : 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.warn(`  ! console: ${msg.text()}`);
  });

  const landed = await signInAnywhere(page, app);
  if (landed !== '剧本') console.warn(`  ! --demo landed on "${landed}", expected the script page of the demo project`);

  // ---- demo mode: every page has content
  for (const [i, [stage, title]] of PAGES.entries()) {
    await go(page, app, stage, title);
    // (below 1024px the boards page opens on its sheet tab and the media grid follows the roots list)
    if (stage === 'boards' && size === DESKTOP) await page.locator('button[data-shot] img').first().waitFor();
    if (stage === 'media') await page.locator('button[data-asset]').first().waitFor({ state: 'attached' });
    await shot(page, out, size, `demo-1${i}-${stage}`, list);
  }

  // ---- deliver checklist
  await go(page, app, 'deliver', '交付');
  await page.locator('[data-deliver-item="project-json"]').waitFor();
  await shot(page, out, size, 'deliver-20', list);
  if (size === PHONE) {
    await shot(page, out, size, 'deliver-20-full', list, true);
  } else {
    await page.locator('[data-deliver-item="project-json"]').scrollIntoViewIfNeeded();
    await shot(page, out, size, 'deliver-21-bottom', list);
  }

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载镜头表 CSV' }).click()]);
  console.log(`  download: ${dl.suggestedFilename()}`);
  await page.getByRole('status').filter({ hasText: '已下载' }).waitFor();
  await page.locator('[data-deliver-item="shots-csv"]').scrollIntoViewIfNeeded();
  await shot(page, out, size, 'deliver-22-downloaded', list);

  await page.locator('[data-deliver-item="boards"]').getByRole('button', { name: /打印预览/ }).click();
  await page.locator('[data-print-page]').first().waitFor();
  await page.getByRole('button', { name: '打印', exact: true }).waitFor();
  await shot(page, out, size, 'deliver-23-boards-print', list);

  await go(page, app, 'deliver', '交付');
  await page.locator('[data-deliver-item="callsheet"]').getByRole('button', { name: /打印预览/ }).click();
  await page.getByRole('region', { name: /拍摄单（打印预览）/ }).waitFor();
  await shot(page, out, size, 'deliver-24-callsheet-print', list);

  if (size === DESKTOP) {
    await go(page, app, 'deliver', '交付');
    await page.locator('[data-deliver-item="missing"]').waitFor();
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const path = join(out, `${size.name}-deliver-25-missing-print.png`);
    await page.screenshot({ path, fullPage: true });
    list.push(path);
    console.log(`  ${path}`);
    await page.emulateMedia({ media: 'screen' });
  }

  // ---- an empty project
  const emptyDir = join(app.projectsDir, `空项目-${size.name}`);
  await signIn(page, app);
  await createProject(page, emptyDir, `空项目 ${size.name}`);
  await go(page, app, 'deliver', '交付');
  await page.locator('[data-deliver-item="project-json"]').waitFor();
  await shot(page, out, size, 'deliver-30-empty', list);
  await context.close();
  return list;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'no-build': { type: 'boolean', default: false },
      out: { type: 'string', default: '.look/ui-deliver' },
    },
  });
  const out = resolve(ROOT, values.out);
  await mkdir(out, { recursive: true });
  if (!values['no-build']) {
    console.log('building @storyscript/web …');
    buildWeb();
  }
  const all: string[] = [];
  for (const size of [DESKTOP, PHONE]) {
    // a fresh --demo server per size: each walk starts in the freshly built demo project
    const app = await startApp({ demo: true });
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ channel: 'chrome' });
      console.log(`${size.width}x${size.height}`);
      all.push(...(await walk(browser, app, out, size)));
    } catch (err) {
      console.error(`--- server output ---\n${app.log()}`);
      throw err;
    } finally {
      await browser?.close();
      await app.stop();
    }
  }
  console.log(`${all.length} screenshots in ${out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

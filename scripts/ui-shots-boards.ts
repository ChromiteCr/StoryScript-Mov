/**
 * Board page screenshots (M4). Builds the web app, starts the production
 * server with --demo under a throwaway STORYSCRIPT_HOME (the AI steps replay
 * fixtures/replay, nothing leaves the machine), walks the script page to 12
 * shots through the UI, then captures the board page in the installed Chrome:
 * grid, pencil and structure frames, a drag in progress, the edited frame,
 * the stale banner, the print preview and its print-media render, the
 * topview pages — at 1440x900 and 390x844. PNGs go to .look/ui-boards/.
 *
 *   npx tsx scripts/ui-shots-boards.ts [--no-build] [--out .look/ui-boards]
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { BoardView, Shot } from '@storyscript/contracts';
import { api, buildWeb, createProject, importAndBreakdownBookshop, ROOT, signIn, startApp, type RunningApp } from '../e2e/support.ts';

interface Size {
  name: string;
  width: number;
  height: number;
}

const DESKTOP: Size = { name: '1440', width: 1440, height: 900 };
const PHONE: Size = { name: '390', width: 390, height: 844 };

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(300);
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

/** Every thumbnail <img> in the left column has decoded. */
async function thumbsReady(page: Page): Promise<void> {
  // (a function, not a string: CSP forbids eval; typed by hand, this file has no DOM lib)
  await page.waitForFunction(() => {
    type Img = { complete: boolean; naturalWidth: number };
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Img> } }).document;
    const imgs = Array.from(doc.querySelectorAll('button[data-shot] img'));
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  });
}

async function selectCard(page: Page, index: number): Promise<void> {
  await page.locator('button[data-shot]').nth(index).click();
}

async function dragBy(page: Page, selector: string, dx: number, dy: number, hold?: () => Promise<void>): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no handle ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  if (hold) await hold();
  await page.mouse.up();
}

async function desktop(browser: Browser, app: RunningApp, out: string): Promise<string[]> {
  const list: string[] = [];
  const size = DESKTOP;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.warn(`  ! console: ${msg.text()}`);
  });
  await signIn(page, app);
  await createProject(page, join(app.projectsDir, '周末短片'), '周末短片');
  await importAndBreakdownBookshop(page, app.base);

  await page.goto(`${app.base}/#/boards`);
  await page.locator('button[data-shot]').nth(11).waitFor();
  await thumbsReady(page);
  await shot(page, out, size, '10-grid', list);

  await selectCard(page, 3); // over-the-shoulder
  await page.locator('[data-handle="foot"]').first().waitFor();
  await shot(page, out, size, '11-board-pencil', list);
  await page.getByRole('radio', { name: '结构线稿' }).click();
  await shot(page, out, size, '12-board-structure', list);
  await page.getByRole('radio', { name: '铅笔稿' }).click();

  await dragBy(page, '[data-handle="foot"][data-subject="s1"]', 90, 30, async () => {
    await shot(page, out, size, '13-editing-drag', list);
  });
  await dragBy(page, '[data-handle="arrow-to"]', -60, 40);
  await shot(page, out, size, '14-edited', list);
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await page.getByText('v2 · 手动调整').first().waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出这一格 PNG' }).click()]);
  const png = join(out, `${size.name}-frame-${download.suggestedFilename()}`);
  await download.saveAs(png);
  console.log(`  ${png}`);
  await page.getByLabel('版本历史').selectOption({ index: 1 });
  await shot(page, out, size, '15-old-version', list);
  await page.getByRole('button', { name: '回到最新版本' }).click();

  // Change the shot (MS → MCU) behind the page's back: the board turns stale.
  const current = (await api<BoardView[]>(page, 'GET', '/api/v1/boards'))[3]!;
  const s = (await api<Shot[]>(page, 'GET', '/api/v1/shots')).find((x) => x.id === current.shot_id)!;
  await api(page, 'PATCH', `/api/v1/shots/${s.id}`, { expected_revision: s.revision, fields: { ...s.fields, shot_size: 'MCU' } });
  await page.goto(`${app.base}/#/script`);
  await page.goto(`${app.base}/#/boards`);
  await page.getByText('镜头内容已修改').waitFor();
  await thumbsReady(page);
  await shot(page, out, size, '16-stale', list);

  await page.getByRole('button', { name: '打印分镜' }).click();
  await page.getByRole('button', { name: '打印', exact: true }).waitFor({ timeout: 30_000 });
  await shot(page, out, size, '17-print-preview', list);
  await page.emulateMedia({ media: 'print' });
  await shot(page, out, size, '18-print-media', list, true);
  // what "存储为 PDF" produces (A4, the app's @page margins)
  const pdf = join(out, 'boards.pdf');
  await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
  console.log(`  ${pdf}`);
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: '返回分镜' }).click();
  await page.getByRole('button', { name: '俯视站位页' }).click();
  await page.getByRole('button', { name: '打印', exact: true }).waitFor({ timeout: 30_000 });
  await shot(page, out, size, '19-topview-print', list);
  await page.emulateMedia({ media: 'print' });
  await shot(page, out, size, '20-topview-print-media', list, true);
  const topPdf = join(out, 'topview.pdf');
  await page.pdf({ path: topPdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
  console.log(`  ${topPdf}`);
  await page.emulateMedia({ media: 'screen' });
  await context.close();
  return list;
}

async function phone(browser: Browser, app: RunningApp, out: string): Promise<string[]> {
  const list: string[] = [];
  const size = PHONE;
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  // the project is still open on the server: the token lands straight in the workbench
  await page.goto(`${app.base}/#t=${app.token}`);
  await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /剧本/ }).waitFor();
  await page.goto(`${app.base}/#/boards`);
  await page.getByRole('tab', { name: '镜头' }).click();
  await page.locator('button[data-shot]').nth(11).waitFor();
  await thumbsReady(page);
  await shot(page, out, size, '10-grid', list);
  await selectCard(page, 1);
  await page.locator('[data-handle="foot"]').first().waitFor();
  await shot(page, out, size, '11-board', list);
  await page.getByRole('tab', { name: '属性' }).click();
  await shot(page, out, size, '12-inspector', list);
  await page.getByRole('tab', { name: '镜头' }).click();
  await selectCard(page, 3);
  await page.getByText('镜头内容已修改').waitFor();
  await shot(page, out, size, '13-stale', list);
  await page.getByRole('button', { name: '打印分镜' }).click();
  await page.getByRole('button', { name: '打印', exact: true }).waitFor({ timeout: 30_000 });
  await shot(page, out, size, '14-print-preview', list);
  await context.close();
  return list;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'no-build': { type: 'boolean', default: false }, out: { type: 'string' } } });
  const out = resolve(ROOT, values.out ?? '.look/ui-boards');
  await mkdir(out, { recursive: true });
  if (!values['no-build']) buildWeb();
  const app = await startApp({ demo: true });
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    const all = [...(await desktop(browser, app, out)), ...(await phone(browser, app, out))];
    console.log(`${all.length} screenshots in ${out}`);
  } catch (err) {
    console.error(`--- server output ---\n${app.log()}`);
    throw err;
  } finally {
    await browser?.close();
    await app.stop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

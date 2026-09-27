import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { ProjectExport } from '@storyscript/contracts';
import { ROOT, signInAnywhere, startApp, type RunningApp } from './support.ts';

/**
 * E2E (M7): `storyscript-mov --demo` creates the demo project under the
 * state directory and opens it on start. Every workflow page has content,
 * the replay banner stays up, and the deliver page lists every export with
 * working project JSON and CSV downloads. Nothing leaves the machine.
 */

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ demo: true });
});

test.afterAll(async () => {
  await app?.stop();
});

async function go(page: Page, stage: string, title: string): Promise<void> {
  await page.goto(`${app.base}/#/${stage}`);
  await page.getByRole('heading', { name: title, level: 1 }).waitFor();
}

async function download(page: Page, button: string): Promise<{ name: string; text: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
  return { name: dl.suggestedFilename(), text: await readFile(await dl.path(), 'utf8') };
}

test('--demo opens the demo project; every page has content; deliver exports', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // landed straight in the demo project, on the script page
  expect(await signInAnywhere(page, app)).toBe('剧本');
  await expect(page.getByText('演示回放，非真实模型输出')).toBeVisible();
  await expect(page.getByRole('banner').getByText('旧书（演示）', { exact: true })).toBeVisible();

  // script: scenes and applied shots
  await expect(page.locator('li[id^="shot-"]').first()).toBeVisible();
  expect(await page.locator('li[id^="shot-"]').count()).toBeGreaterThanOrEqual(10);

  // boards: automatic boards with thumbnails
  await go(page, 'boards', '分镜');
  await expect(page.locator('button[data-shot] img').first()).toBeVisible();
  expect(await page.locator('button[data-shot]').count()).toBeGreaterThanOrEqual(10);

  // plan: one approved day
  await go(page, 'plan', '计划');
  const status = page.getByRole('region', { name: '计划状态' });
  await expect(status).toContainText('已批准');
  await expect(status.getByRole('button', { name: '批准计划' })).toHaveCount(0);

  // set: shooting order from the approved plan, takes logged
  await go(page, 'set', '现场');
  await expect(page.getByText(/按已批准计划/).first()).toBeVisible();
  await expect(page.locator('[data-shot]').first()).toBeVisible();
  await expect(page.getByText(/^T\d{2}$/).first()).toBeVisible();

  // media: six pre-probed clips with posters, every coverage state
  await go(page, 'media', '素材');
  await expect(page.locator('button[data-asset]')).toHaveCount(6);
  await expect(page.locator('button[data-asset] img').first()).toBeVisible();
  const coverage = page.getByRole('table', { name: '按场的覆盖状态' });
  for (const label of ['可用', '已拍待定', '需补拍', '免拍']) await expect(coverage.getByText(label, { exact: true }).first()).toBeVisible();

  // deliver: the full checklist, nothing unavailable
  await go(page, 'deliver', '交付');
  const items = page.locator('[data-deliver-item]');
  await expect(items).toHaveCount(10);
  expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-deliver-item')))).toEqual([
    'boards',
    'topview',
    'callsheet',
    'slates',
    'take-log',
    'takes-media',
    'coverage-csv',
    'missing',
    'shots-csv',
    'project-json',
  ]);
  // every export has content; the plan is approved; the boards stay 草案 while shots are unlocked
  expect(await items.evaluateAll((els) => els.filter((e) => !['ready', 'draft'].includes(e.getAttribute('data-state') ?? '')).length)).toBe(0);
  for (const id of ['callsheet', 'slates', 'take-log', 'takes-media', 'coverage-csv', 'missing', 'shots-csv', 'project-json']) {
    await expect(page.locator(`[data-deliver-item="${id}"]`)).toHaveAttribute('data-state', 'ready');
  }
  await expect(page.locator('[data-deliver-item="boards"]')).toContainText('未锁定');

  const json = await download(page, '下载项目 JSON');
  expect(json.name).toMatch(/^旧书（演示）-项目-\d{4}-\d{2}-\d{2}\.json$/);
  const data = ProjectExport.parse(JSON.parse(json.text));
  expect(data.project.name).toBe('旧书（演示）');
  expect(data.shots.length).toBeGreaterThanOrEqual(10);
  expect(data.plans).toHaveLength(1);
  expect(data.takes.length).toBeGreaterThan(0);
  expect(data.media_assets).toHaveLength(6);
  expect(json.text).not.toContain(app.tmp); // demo project folder
  expect(json.text).not.toContain(ROOT); // demo footage folder (samples/demo-media/clips)
  expect(json.text).not.toMatch(/"abs_path"|api_key|credentials/);
  await expect(page.getByRole('status').filter({ hasText: '已下载' })).toBeVisible();

  const shots = await download(page, '下载镜头表 CSV');
  expect(shots.name).toMatch(/^旧书（演示）-镜头表-\d{4}-\d{2}-\d{2}\.csv$/);
  // BOM is on by default (Excel opens Chinese correctly)
  expect(shots.text.startsWith('\uFEFF场,镜,景别,')).toBe(true);

  const cov = await download(page, '下载覆盖状态 CSV');
  for (const label of ['可用', '已拍待定', '需补拍', '免拍']) expect(cov.text).toContain(label);

  const tm = await download(page, '下载场记与素材 CSV');
  expect(tm.text.split('\r\n')[0]).toContain('stream_index,in_pts,out_pts,time_base_num,time_base_den');

  expect(pageErrors).toEqual([]);
});

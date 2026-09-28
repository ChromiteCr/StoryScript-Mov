import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, signUpHosted, startHostedApp, type HostedApp } from './support.ts';

/**
 * Hosted server, footage on the member's computer (S1d): a group member
 * opens a project folder (A-roll/B-roll subfolders) in the
 * browser, and the library fills from facts the browser read locally — no
 * video is uploaded. The clip plays from a blob: URL; another team sees none
 * of it. (Accounts are made through the API here; hosted-accounts covers
 * the sign-up screens.) The file-list path (<input webkitdirectory>) is read-only, so the
 * folder gets no .storyscript-mov records.
 */

const CLIPS = join(ROOT, 'samples', 'demo-media', 'clips');
let app: HostedApp;
let folder = '';

test.beforeAll(async () => {
  app = await startHostedApp();
  const parent = mkdtempSync(join(tmpdir(), 'ssm-folder-'));
  folder = join(parent, '我的短片');
  for (const [sub, files] of [
    ['A-roll', ['A001C003.mov', 'S01-001-T01.mp4', 'S01-002-T01.mov']],
    ['B-roll', ['B002C001.mov', 'IMG_1234.mov', 'S01-003-T02.mp4']],
  ] as const) {
    mkdirSync(join(folder, sub), { recursive: true });
    for (const f of files) cpSync(join(CLIPS, f), join(folder, sub, f));
  }
  cpSync(join(CLIPS, 'notes.txt'), join(folder, 'notes.txt'));
});

test.afterAll(async () => {
  await app?.stop();
  if (folder) rmSync(join(folder, '..'), { recursive: true, force: true });
});

test('a team opens its project folder: facts and posters only, local playback, other teams see nothing', async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signUpHosted(page, app, 'lin@school.test', '小林', '一组');
  await page.goto(app.base);
  await expect(page.getByRole('banner').getByText('一组：小林')).toBeVisible();
  await page.goto(`${app.base}/#/media`);
  await expect(page.getByRole('heading', { name: '素材', level: 1 })).toBeVisible();
  await expect(page.getByText('打开项目文件夹后，素材会出现在这里。')).toBeVisible();

  // the directory chooser itself is native; the page takes the same files from its folder input
  await page.getByTestId('project-folder-input').setInputFiles(folder);
  const ask = page.getByRole('dialog', { name: '把这个文件夹用作本队的项目文件夹？' });
  await expect(ask).toContainText('视频不会上传');
  await ask.getByRole('button', { name: '使用这个文件夹' }).click();

  await expect(page.getByRole('status').filter({ hasText: '共 6 个素材' })).toBeVisible({ timeout: 60_000 });
  const cards = page.locator('button[data-asset]');
  await expect(cards).toHaveCount(6);
  // H.264 clips always get a poster grabbed in the browser (HEVC depends on the machine, ProRes never)
  expect(await page.locator('button[data-asset] img[src*="/poster"]').count()).toBeGreaterThanOrEqual(3);

  // subfolders, like an explorer
  const tree = page.getByRole('region', { name: '文件夹' });
  await expect(tree.getByRole('button', { name: /A-roll\s*3/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /B-roll\s*3/ })).toBeVisible();
  await tree.getByRole('button', { name: /A-roll/ }).click();
  await expect(cards).toHaveCount(3);

  // facts read in the browser: timecode from the tmcd track, local playback
  await page.locator('button[data-asset]').filter({ hasText: 'A001C003.mov' }).click();
  const inspector = page.getByRole('region', { name: '检查器' });
  await expect(inspector).toContainText('01:00:00:00');
  await expect(inspector.locator('video')).toHaveAttribute('src', /^blob:/);

  await page.screenshot({ path: test.info().outputPath('hosted-media.png') });

  // read-only open (file list): no records written into the folder
  expect(existsSync(join(folder, '.storyscript-mov'))).toBe(false);

  // another team: nothing of this
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await signUpHosted(p2, app, 'zhou@school.test', '小周', '二组');
  await p2.goto(app.base);
  await expect(p2.getByRole('banner').getByText('二组：小周')).toBeVisible();
  await p2.goto(`${app.base}/#/media`);
  await expect(p2.getByText('打开项目文件夹后，素材会出现在这里。')).toBeVisible();
  await expect(p2.locator('button[data-asset]')).toHaveCount(0);
  await other.close();

  expect(pageErrors).toEqual([]);
});

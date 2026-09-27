import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, signIn, startApp, type RunningApp } from './support.ts';

/**
 * Local app (S1e): open a folder like in an editor. A folder that is not a
 * project yet is made one in place; its data goes into .storyscript-mov and
 * the footage in its subfolders is scanned without registering anything.
 */

const CLIPS = join(ROOT, 'samples', 'demo-media', 'clips');
let app: RunningApp;
let parent = '';

test.beforeAll(async () => {
  app = await startApp({ noKey: true });
  parent = mkdtempSync(join(tmpdir(), 'ssm-open-folder-'));
});
test.afterAll(async () => {
  await app?.stop();
  if (parent) rmSync(parent, { recursive: true, force: true });
});

test('open a plain folder with footage, make it a project, its footage is scanned', async ({ page }) => {
  const folder = join(parent, '雨夜短片');
  for (const [sub, f] of [
    ['A-roll', 'S01-001-T01.mp4'],
    ['A-roll', 'S01-002-T01.mov'],
    ['B-roll', 'A001C003.mov'],
  ] as const) {
    mkdirSync(join(folder, sub), { recursive: true });
    cpSync(join(CLIPS, f), join(folder, sub, f));
  }

  await signIn(page, app);
  await page.getByRole('button', { name: '打开文件夹…' }).click();
  const openDrawer = page.getByRole('dialog', { name: '打开文件夹' });
  await openDrawer.getByLabel('项目文件夹').fill(folder);
  await openDrawer.getByRole('button', { name: '打开', exact: true }).click();
  await expect(openDrawer.getByText('这个文件夹还不是 StoryScript-Mov 项目').first()).toBeVisible();
  await openDrawer.getByRole('button', { name: '在这里新建项目' }).click();

  const create = page.getByRole('dialog', { name: '新建项目' });
  await expect(create.getByLabel('项目文件夹')).toHaveValue(folder);
  await expect(create.getByLabel('项目名')).toHaveValue('雨夜短片');
  await create.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /剧本/ }).waitFor();

  // the project's data sits in .storyscript-mov; the footage folders are untouched
  expect(readdirSync(folder).sort()).toEqual(['.storyscript-mov', 'A-roll', 'B-roll']);
  expect(existsSync(join(folder, '.storyscript-mov', 'project.json'))).toBe(true);

  await page.goto(`${app.base}/#/media`);
  await expect(page.locator('button[data-asset]')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByText('项目文件夹里的素材（A-roll、B-roll 等子文件夹），打开项目时自动扫描')).toBeVisible();
});

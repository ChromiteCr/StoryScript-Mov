import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, createProject, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S2c: a pasted shot list is read as shots, not one scene per shot. The
 * preview says so, lists each scene's shots, and any line can be switched
 * between 正文 / 场 / 镜 by its tag; the import makes the shots.
 */

const SHOT_LIST = readFileSync(join(ROOT, 'fixtures', 'scripts', '04-shotlist.txt'), 'utf8');
let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ noKey: true });
});
test.afterAll(async () => {
  await app?.stop();
});

test('paste a shot list: 2 scenes and 9 shots, a line switched by hand, then imported', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'shot-list'), '放学后');
  await page.goto(`${app.base}/#/script`);

  await page.getByRole('textbox', { name: '剧本文本' }).fill(SHOT_LIST);
  await page.getByRole('button', { name: '识别场次和镜头' }).click();
  const preview = page.getByRole('region', { name: '逐行预览', exact: true });
  await expect(preview.getByText('这是分镜脚本：识别出 2 场、9 个镜头')).toBeVisible();

  const scenes = page.getByRole('region', { name: /^场次 2/ });
  await expect(scenes.getByRole('list', { name: '第 1 场的镜头' }).getByRole('listitem')).toHaveCount(5);
  await expect(scenes.getByText('中景 · 手持 · 5 秒 · 小林起身走向门口')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('shot-list-preview.png') });

  // line 2 ("第四组") is plain text; one click makes it a scene heading, two a shot, three plain again
  const tag = preview.getByRole('button', { name: /^第 2 行是正文/ });
  await tag.click();
  await expect(preview.getByRole('button', { name: /^第 2 行是场次标题/ })).toBeVisible();
  await preview.getByRole('button', { name: /^第 2 行是场次标题/ }).click();
  await expect(preview.getByRole('button', { name: /^第 2 行是镜头/ })).toBeVisible();
  await preview.getByRole('button', { name: /^第 2 行是镜头/ }).click();
  await expect(preview.getByRole('button', { name: /^第 2 行是正文/ })).toBeVisible();

  await page.getByRole('button', { name: '导入 2 场和 9 个镜头' }).click();
  const table = page.getByRole('region', { name: /镜头表/ });
  await table.waitFor();
  await expect(page.getByText(/按分镜脚本新建 9 个镜头/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('shot-list-imported.png') });
  expect(pageErrors).toEqual([]);
});

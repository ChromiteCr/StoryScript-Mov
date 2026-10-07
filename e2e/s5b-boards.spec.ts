import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BoardView, Shot } from '@storyscript/contracts';
import { RENDERER_VERSION } from '@storyscript/core';
import { api, createProject, importAndBreakdownBookshop, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S5b (demo replay, nothing leaves the machine): a person's feeling and an
 * object's name from the shot editor reach the board — the board goes stale,
 * 重新生成 lays it out with 生气 and the name, the inspector shows them; the
 * inspector's 时段 turns the frame to night and saves a new version.
 */

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ demo: true });
});
test.afterAll(async () => {
  await app?.stop();
});

test('S5b boards: 情绪 and 物件名称 from the shot editor, 时段 in the board inspector', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-s5b'), 'E2E 情绪与光影');
  await importAndBreakdownBookshop(page, app.base);
  const nav = page.getByRole('navigation', { name: '工作流程' });

  const shots = await api<Shot[]>(page, 'GET', '/api/v1/shots');
  const shot = shots.find((s) => s.fields.subjects.length >= 1 && !s.locked) ?? shots.find((s) => s.fields.subjects.length >= 1)!;

  await test.step('the shot editor: 情绪 生气 for the first person, 物件名称', async () => {
    await page.locator(`li[id="shot-${shot.id}"] [data-shot-summary]`).click();
    const emotion = page.getByRole('combobox', { name: '情绪' }).first();
    await expect(emotion.locator('option')).toHaveText(['自动（按动作）', '平静', '开心', '难过', '生气', '害怕', '吃惊', '紧张']);
    await emotion.selectOption('angry');
    await page.getByLabel('物件名称').fill('旧书');
    await page.screenshot({ path: test.info().outputPath('shot-editor-emotion.png') });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await api<Shot[]>(page, 'GET', '/api/v1/shots')).find((s) => s.id === shot.id)?.fields.subjects[0]?.emotion).toBe('angry');
    const saved = (await api<Shot[]>(page, 'GET', '/api/v1/shots')).find((s) => s.id === shot.id)!;
    expect(saved.fields.object_name).toBe('旧书');
  });

  const board = async () => (await api<BoardView[]>(page, 'GET', '/api/v1/boards')).find((b) => b.shot_id === shot.id)!;

  await test.step('the board is stale; 重新生成 draws the angry face; the inspector shows 生气', async () => {
    await nav.getByRole('link', { name: /分镜/ }).click();
    await page.locator(`button[data-shot="${shot.id}"]`).click();
    await expect(page.getByText('镜头内容已修改')).toBeVisible();
    await page.getByRole('button', { name: '重新生成（会丢失手动调整）' }).click();
    await expect(page.getByText('镜头内容已修改')).toHaveCount(0);
    const b = await board();
    expect(b).toMatchObject({ stale: false, renderer_version: RENDERER_VERSION });
    expect(b.spec.scene.subjects[0]!.emotion).toBe('angry');
    await expect(page.getByRole('region', { name: `镜 ${b.shot_code} 分镜稿` }).locator('img').first()).toBeVisible();
    await page.getByRole('combobox', { name: '选择人物' }).selectOption(b.spec.scene.subjects[0]!.id);
    await expect(page.getByRole('combobox', { name: '情绪' })).toHaveValue('angry');
  });

  await test.step('时段 夜: unsaved change, then a saved version at night', async () => {
    const time = page.getByRole('combobox', { name: '时段' });
    await expect(time.locator('option')).toHaveText(['日', '黄昏', '夜']);
    await time.selectOption('night');
    await expect(page.getByText('有未保存的修改')).toBeVisible();
    await page.getByRole('button', { name: '保存为新版本' }).click();
    await expect.poll(async () => (await board()).spec.scene.time).toBe('night');
    expect((await board()).user_edited).toBe(true);
    await page.screenshot({ path: test.info().outputPath('board-night.png') });
  });

  expect(pageErrors).toEqual([]);
});

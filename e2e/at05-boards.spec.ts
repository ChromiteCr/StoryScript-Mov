import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BoardView } from '@storyscript/contracts';
import { api, createProject, importAndBreakdownBookshop, signIn, startApp, type RunningApp } from './support.ts';

/**
 * E2E segment 1 (AT-05, no key): new project → import 01-bookshop.txt → AI
 * breakdown (demo replay) → apply → the board page shows 12 thumbnails →
 * select one → drag a person → move an arrow end → undo → save as a new
 * version → reload: same version and content → a concurrent save elsewhere
 * gets the 409 prompt → the print view paginates 3 frames per page.
 */

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ demo: true });
});

test.afterAll(async () => {
  await app?.stop();
});

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const c = await center(handle);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(c.x + (dx * i) / 6, c.y + (dy * i) / 6);
  await page.mouse.up();
}

const boardsOf = (page: Page) => api<BoardView[]>(page, 'GET', '/api/v1/boards');

test('AT-05 board page: edit, undo, save a version, reload, 409, print', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-boards'), 'E2E 分镜');
  await importAndBreakdownBookshop(page, app.base);

  // boards were laid out when the breakdown was applied
  await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /分镜/ }).click();
  const cards = page.locator('button[data-shot]');
  await expect(cards).toHaveCount(12);
  await expect(cards.first().locator('img')).toBeVisible();
  const initial = await boardsOf(page);
  expect(initial.map((b) => [b.version, b.user_edited, b.stale])).toEqual(Array.from({ length: 12 }, () => [1, false, false]));

  // select the over-the-shoulder shot 004
  await cards.nth(3).click();
  const sheet = page.getByRole('region', { name: '镜 004 分镜稿' });
  await expect(sheet).toBeVisible();
  const before = initial[3]!;
  expect(before.shot_code).toBe('004');
  const person = sheet.locator('[data-handle="foot"][data-subject="s1"]');
  const arrowTo = sheet.locator('[data-handle="arrow-to"]').first();

  // drag the person to screen right
  await drag(page, person, 90, 0);
  await expect(page.getByText('有未保存的修改')).toBeVisible();
  // a trip to another page keeps the unsaved edit (restored in this tab)
  const nav = page.getByRole('navigation', { name: '工作流程' });
  await nav.getByRole('link', { name: /剧本/ }).click();
  await page.getByRole('region', { name: /镜头表/ }).waitFor();
  await nav.getByRole('link', { name: /分镜/ }).click();
  await expect(sheet).toBeVisible();
  await expect(page.getByText('有未保存的修改')).toBeVisible();
  const afterPerson = await center(arrowTo);

  // move the eyeline's end, then undo only that
  await drag(page, arrowTo, -70, 45);
  const moved = await center(arrowTo);
  expect(Math.hypot(moved.x - afterPerson.x, moved.y - afterPerson.y)).toBeGreaterThan(30);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Math.round((await center(arrowTo)).x)).toBe(Math.round(afterPerson.x));
  await expect(page.getByText('有未保存的修改')).toBeVisible();

  // save as a new version
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await expect(page.getByText('v2 · 手动调整').first()).toBeVisible();
  const saved = (await boardsOf(page))[3]!;
  expect(saved).toMatchObject({ version: 2, user_edited: true, parent_board_id: before.id, stale: false });
  const s0 = before.spec.scene.subjects.find((s) => s.id === 's1')!;
  const s1 = saved.spec.scene.subjects.find((s) => s.id === 's1')!;
  expect(Math.hypot(s1.x - s0.x, s1.z - s0.z)).toBeGreaterThan(0.05);
  // the undone arrow edit is not in the saved version: the eyeline only followed the person
  const eye0 = before.spec.overlay.arrows.find((a) => a.kind === 'eyeline')!;
  const eye1 = saved.spec.overlay.arrows.find((a) => a.kind === 'eyeline')!;
  expect(eye0.mode === 'anchored' && eye1.mode === 'anchored').toBe(true);
  if (eye0.mode === 'anchored' && eye1.mode === 'anchored') {
    expect(eye1.world_from).toEqual(eye0.world_from);
    expect(eye1.world_to.x - eye0.world_to.x).toBeCloseTo(s1.x - s0.x, 3);
  }
  // the other boards are untouched
  expect((await boardsOf(page)).filter((b) => b.version === 1)).toHaveLength(11);
  const personAt = await center(person);

  // reload: same selection, version and content
  await page.reload();
  await expect(sheet).toBeVisible();
  await expect(page.getByText('v2 · 手动调整').first()).toBeVisible();
  expect((await boardsOf(page))[3]).toEqual(saved);
  const personAfter = await center(person);
  expect(Math.abs(personAfter.x - personAt.x)).toBeLessThan(1.5);
  expect(Math.abs(personAfter.y - personAt.y)).toBeLessThan(1.5);

  // another window saves first → our save gets the 409 prompt → refresh loads v3
  await api(page, 'PATCH', `/api/v1/boards/${saved.id}`, { expected_revision: saved.revision, spec: saved.spec });
  await drag(page, person, -40, 0);
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '保存失败：分镜已在别处更新' })).toBeVisible();
  await page.getByRole('button', { name: /刷新（载入 v3）/ }).click();
  await expect(page.getByText('v3 · 手动调整').first()).toBeVisible();
  await expect(page.getByText('有未保存的修改')).toHaveCount(0);

  // single-frame PNG, composed on a canvas in the browser
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出这一格 PNG' }).click()]);
  expect(download.suggestedFilename()).toBe('E2E_分镜-004-v3.png');
  const png = await readFile(await download.path());
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1840 + 96); // frame width + margins

  // the shot changes elsewhere → stale banner → keep, then regenerate
  const shotApi = async () => (await api<{ id: string; revision: number; fields: Record<string, unknown> }[]>(page, 'GET', '/api/v1/shots'))[3]!;
  let s = await shotApi();
  await api(page, 'PATCH', `/api/v1/shots/${s.id}`, { expected_revision: s.revision, fields: { ...s.fields, shot_size: 'MCU' } });
  await page.reload();
  await expect(page.getByText('镜头内容已修改')).toBeVisible();
  await expect(cards.nth(3).getByText('镜头已改')).toBeVisible();
  await page.getByRole('button', { name: '保留我的调整' }).click();
  await expect(page.getByText('镜头内容已修改')).toHaveCount(0);
  expect((await boardsOf(page))[3]).toMatchObject({ version: 3, revision: 1, stale: false });
  s = await shotApi();
  await api(page, 'PATCH', `/api/v1/shots/${s.id}`, { expected_revision: s.revision, fields: { ...s.fields, shot_size: 'CU' } });
  await page.reload();
  await page.getByRole('button', { name: '重新生成（会丢失手动调整）' }).click();
  await expect(page.getByText('v4 · 自动生成').first()).toBeVisible();
  expect((await boardsOf(page))[3]).toMatchObject({ version: 4, user_edited: false, stale: false });

  // print view: 12 frames at 2.39 → 4 pages of 3
  await page.getByRole('button', { name: '打印分镜' }).click();
  await expect(page.locator('[data-print-page]')).toHaveCount(4);
  await expect(page.locator('[data-print-cell]')).toHaveCount(12);
  await expect(page.getByRole('button', { name: '打印', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('[data-print-page="1"]')).toContainText('草案');
  await expect(page.locator('[data-print-page="2"]')).toContainText('v4');
  const pdfPath = join(app.tmp, 'boards.pdf');
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  const pdf = (await readFile(pdfPath)).toString('latin1');
  expect(pdf.match(/\/Type\s*\/Page(?!s)/g)?.length).toBe(4);
  await page.emulateMedia({ media: 'screen' });

  expect(pageErrors).toEqual([]);
});

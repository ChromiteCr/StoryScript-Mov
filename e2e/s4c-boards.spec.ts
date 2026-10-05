import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { BoardSpec, BoardView, BreakdownOutput, RelayoutBoardsResult } from '@storyscript/contracts';
import { effectiveGesture, gestureCount, RENDERER_VERSION } from '@storyscript/core';
import { api, createProject, importAndBreakdownBookshop, ROOT, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S4c (demo replay, nothing leaves the machine): the boards page after a
 * renderer upgrade. A project of 12 boards, one edited by hand, every board
 * marked as drawn by an older renderer → the page offers 用新画法重排 11 个分镜
 * → one click → 重排了 11 个，跳过手改的 1 个, every untouched shot has a new
 * version on the current renderer and the edited one is exactly as it was →
 * nothing left to offer, and the API agrees (a second call changes nothing).
 * Then the board editor: the pose list has the four new poses, 换个动作 shows
 * up exactly when core has more than one gesture for the pose and steps through
 * them; the shot editor offers the new props and places; a draft with variety
 * warnings shows them under 镜头变化 without blocking 应用所选.
 */

const SCENE2 = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'replay', '01-bookshop.breakdown-v1.scene-2.json'), 'utf8')) as { output_json: BreakdownOutput }).output_json;

/** marks a board as laid out by a renderer that is not the current one */
const OLD_RENDERER = 'board-m1.0';

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ demo: true });
});
test.afterAll(async () => {
  await app?.stop();
});

const boardsOf = (page: Page) => api<BoardView[]>(page, 'GET', '/api/v1/boards');
const versionsOf = (page: Page, shotId: string) => api<{ version: number; user_edited: boolean; renderer_version: string }[]>(page, 'GET', `/api/v1/shots/${shotId}/boards`);

test('S4c boards: renderer upgrade → 重排 → counts and new versions; gestures, new poses, variety hints', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const projectDir = join(app.projectsDir, 'e2e-s4c');
  await signIn(page, app);
  await createProject(page, projectDir, 'E2E 新画法');
  await importAndBreakdownBookshop(page, app.base);

  const nav = page.getByRole('navigation', { name: '工作流程' });
  const cards = page.locator('button[data-shot]');
  const oldNotice = page.getByText(/个分镜还是旧画法排的版/);
  let editedShotId = '';

  await test.step('12 boards on the current renderer: nothing to lay out again', async () => {
    await nav.getByRole('link', { name: /分镜/ }).click();
    await expect(cards).toHaveCount(12);
    await expect(cards.first().locator('img')).toBeVisible();
    await expect(oldNotice).toHaveCount(0);
    await expect(page.getByRole('button', { name: /用新画法重排/ })).toHaveCount(0);
    const list = await boardsOf(page);
    expect(list.every((b) => b.version === 1 && b.renderer_version === RENDERER_VERSION)).toBe(true);
  });

  await test.step('one board is edited by hand, then the project looks like one from before the upgrade', async () => {
    const list = await boardsOf(page);
    const target = list.find((b) => b.spec.scene.subjects.length >= 2) ?? list[3]!;
    editedShotId = target.shot_id;
    const spec: BoardSpec = structuredClone(target.spec);
    spec.camera.focal_mm = 85;
    await api(page, 'PATCH', `/api/v1/boards/${target.id}`, { expected_revision: target.revision, spec });

    // a second connection to the project database (WAL): every stored board gets the old marker
    const db = new DatabaseSync(join(projectDir, '.storyscript-mov', 'project.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('UPDATE board SET renderer_version = ?').run(OLD_RENDERER);
    } finally {
      db.close();
    }
    await page.reload();
    await expect(cards).toHaveCount(12);
  });

  await test.step('the notice and one button for the 11 that can be laid out again', async () => {
    await expect(page.getByText('有 11 个分镜还是旧画法排的版')).toBeVisible();
    const button = page.getByRole('button', { name: '用新画法重排 11 个分镜（手改过的不动）' });
    await expect(button).toBeEnabled();
    // the scene holds all of them: one button, not one per scope
    await expect(page.getByRole('button', { name: /用新画法重排/ })).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('relayout-offer.png') });

    await button.click();
    await expect(page.getByText('重排了 11 个，跳过手改的 1 个')).toBeVisible();
    await expect(oldNotice).toHaveCount(0);
    await expect(page.getByRole('button', { name: /用新画法重排/ })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('relayout-done.png') });
  });

  await test.step('the server agrees: new versions on the current renderer, the edited board untouched', async () => {
    const list = await boardsOf(page);
    expect(list).toHaveLength(12);
    for (const b of list) {
      const vs = await versionsOf(page, b.shot_id);
      expect(vs.map((v) => v.version), b.shot_code).toEqual([1, 2]);
      if (b.shot_id === editedShotId) {
        expect(b.user_edited).toBe(true);
        expect(b.renderer_version).toBe(OLD_RENDERER);
      } else {
        expect(b).toMatchObject({ version: 2, user_edited: false, renderer_version: RENDERER_VERSION, stale: false });
        expect(vs[0]!.renderer_version).toBe(OLD_RENDERER);
      }
    }
    // a second request has nothing to do
    const again = await api<RelayoutBoardsResult>(page, 'POST', '/api/v1/boards/relayout', { scene_id: null });
    expect(again).toEqual({ relaid: 0, kept_edited: 1, already_current: 11 });

    await page.getByRole('button', { name: '知道了' }).click();
    await expect(page.getByText('重排了 11 个')).toHaveCount(0);
    await page.reload();
    await expect(cards).toHaveCount(12);
    await expect(oldNotice).toHaveCount(0);
  });

  await test.step('the pose list has the four new poses; 换个动作 follows what core offers', async () => {
    const list = await boardsOf(page);
    const index = list.findIndex((b) => b.shot_id !== editedShotId && b.spec.scene.subjects.length >= 1);
    expect(index).toBeGreaterThanOrEqual(0);
    const board = list[index]!;
    const person = board.spec.scene.subjects[0]!;
    await cards.nth(index).click();
    await expect(page.getByRole('region', { name: `镜 ${board.shot_code} 分镜稿` })).toBeVisible();

    const pose = page.getByRole('combobox', { name: '姿势' });
    await expect(pose.locator('option')).toHaveText(['站', '走', '跑', '坐', '指向', '蹲', '躺', '跪', '伸手', '打电话']);

    const change = page.getByRole('button', { name: '换个动作' });
    const n = Math.min(gestureCount(person.pose), 16);
    if (n <= 1) {
      // TODO(S4c lead): once core has gesture variants this branch is only taken for poses with a single one
      await expect(change).toHaveCount(0);
    } else {
      const from = effectiveGesture(person, board.spec.seed);
      await expect(page.getByText(`${from + 1} / ${n}`, { exact: true })).toBeVisible();
      await change.click();
      await expect(page.getByText('有未保存的修改')).toBeVisible();
      await expect(page.getByText(`${((from + 1) % n) + 1} / ${n}`, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '保存为新版本' }).click();
      await expect(page.getByText('v3 · 手动调整').first()).toBeVisible();
      const saved = (await boardsOf(page))[index]!;
      expect(saved).toMatchObject({ version: 3, user_edited: true });
      expect(saved.spec.scene.subjects[0]!.gesture).toBe((from + 1) % n);
    }

    // lying down: the figure is drawn (no error), and the button follows the new pose's variants
    await pose.selectOption('lie');
    await expect(page.getByText('有未保存的修改')).toBeVisible();
    await expect(page.getByRole('region', { name: `镜 ${board.shot_code} 分镜稿` }).locator('img').first()).toBeVisible();
    await expect(change).toHaveCount(gestureCount('lie') > 1 ? 1 : 0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(pose).toHaveValue(person.pose);
  });

  await test.step('the shot editor offers the new props and places', async () => {
    await nav.getByRole('link', { name: /剧本/ }).click();
    await page.getByRole('region', { name: /镜头表/ }).waitFor();
    await page.locator('li[id^="shot-"]').first().locator('[data-shot-summary]').click();
    const props = page.getByRole('group', { name: '道具与陈设' });
    await expect(props.getByRole('button')).toHaveCount(18);
    for (const label of ['床', '沙发', '书架', '灯', '树', '手机', '杯子', '书', '包']) await expect(props.getByRole('button', { name: label, exact: true })).toBeVisible();
    const env = page.getByRole('combobox', { name: '环境' });
    await expect(env.locator('option')).toHaveText(['未指定', '开阔外景', '室内', '街道', '野外（树林、山坡）', '走廊', '教室']);
    await props.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('shot-editor-props.png') });
  });

  await test.step('a draft with variety warnings: shown under 镜头变化, not blocking 应用所选', async () => {
    // a pending breakdown draft for scene 2 with variety warnings, as the server's check attaches them
    const scenes = (await api<{ scenes: { id: string; heading: string }[] }>(page, 'GET', '/api/v1/scripts/current')).scenes;
    const scene2 = scenes[1]!;
    const issues = [
      { level: 'warning', code: 'VARIETY_FEW_SIZES', message: '5 个镜头只用了 2 种景别', item: null },
      { level: 'warning', code: 'VARIETY_SIZE_RUN', message: '第 1 到 3 个镜头景别、角度、运动都一样', item: 2 },
    ];
    const db = new DatabaseSync(join(projectDir, '.storyscript-mov', 'project.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare(
        `INSERT INTO shot_draft (id, kind, scope_json, model, prompt_version, raw_output, parsed_json, issues_json, attempts, usage_json, status, created_at)
         VALUES (?, 'breakdown', ?, 'replay', 'breakdown-v3', NULL, ?, ?, 1, NULL, 'pending', ?)`,
      ).run(randomUUID(), JSON.stringify({ scene_id: scene2.id }), JSON.stringify(SCENE2), JSON.stringify(issues), new Date().toISOString());
    } finally {
      db.close();
    }

    await page.goto(`${app.base}/#/script`);
    await page.reload();
    const region = page.getByRole('region', { name: scene2.heading, exact: true });
    await region.getByRole('button', { name: '审阅草案' }).click();
    const dialog = page.getByRole('dialog', { name: /AI 拆镜草案 · 第 2 场/ });
    await expect(dialog).toBeVisible();

    const variety = dialog.getByRole('note').filter({ has: page.getByText('镜头变化', { exact: true }) });
    await expect(variety).toBeVisible();
    await expect(variety.getByText('5 个镜头只用了 2 种景别')).toBeVisible();
    await expect(variety.getByText('#3')).toBeVisible();
    await expect(variety.getByText('第 1 到 3 个镜头景别、角度、运动都一样')).toBeVisible();
    await expect(variety.getByText('丰富变化')).toBeVisible();
    // listed once, not again on the card
    await expect(dialog.getByText('第 1 到 3 个镜头景别、角度、运动都一样')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('variety-draft.png') });

    // hints only: every item can still be ticked and applied
    await expect(dialog.getByRole('button', { name: /^应用所选（5）/ })).toBeEnabled();
    await dialog.getByRole('button', { name: '放弃草案' }).click();
    await expect(dialog).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

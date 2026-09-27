import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BoardView, RasterView, ScriptImportResult, Shot, ShotFields } from '@storyscript/contracts';
import { IMAGE_TEST_KEY, startFakeImage, type FakeImage } from '../apps/server/test/helpers/fake-image.ts';
import { api, BOOKSHOP, createProject, signIn, startApp, type RunningApp } from './support.ts';

/**
 * AT-18 (FakeImage, web): a fake image service on 127.0.0.1 → settings page:
 * configure the image model (key write-only, dialect detected, "未验证"), free
 * check, paid trial behind its confirmation → board page: the redraw entry is
 * greyed out before configuration; confirmation dialog shows host, dialect,
 * model, the control image, the prompt summary and the filtered words →
 * candidate appears → onion skin (opacity, AI only, lines only) → adopt →
 * the frame shows "AI 图 + 标注" with the "AI 生成" corner mark → PNG → a
 * structure edit marks it stale ("镜头构图已改") → the print view uses the
 * adopted raster with the corner mark → saving the edit leaves the raster
 * behind on the old version, flagged stale by the server.
 *
 * Not in demo mode (demo never sends image requests): shots are created via
 * the API (manual shots), everything AI-related goes through the UI.
 */

let app: RunningApp;
let fake: FakeImage;

test.beforeAll(async () => {
  fake = await startFakeImage();
  // the server inherits this process's environment: make sure the settings page decides
  for (const k of ['STORYSCRIPT_IMAGE_BASE_URL', 'STORYSCRIPT_IMAGE_API_KEY', 'STORYSCRIPT_IMAGE_MODEL']) delete process.env[k];
  app = await startApp();
});

test.afterAll(async () => {
  await app?.stop();
  await fake?.close();
});

function fields(p: Partial<ShotFields> & Pick<ShotFields, 'source'>): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: [],
    props: [],
    env: 'interior',
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 4,
    narrative_purpose: '',
    action: '',
    dialogue_quote: null,
    assumptions: [],
    questions: [],
    ...p,
  };
}

const subject = (alias: string, screen: 'L' | 'C' | 'R') => ({ alias, screen, depth: null, facing: null, pose: null });

async function setupShots(page: Page): Promise<void> {
  const text = await readFile(BOOKSHOP, 'utf8');
  const imported = await api<ScriptImportResult>(page, 'POST', '/api/v1/scripts', { text, source_name: '01-bookshop.txt', format: 'txt', heading_overrides: [] });
  const scene = imported.scenes[0]!;
  await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] });
  await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '林晓', aliases: [] });
  const source = { paragraph_id: scene.paragraph_ids[1]!, quote: '' };
  await api<Shot>(page, 'POST', '/api/v1/shots', {
    scene_id: scene.id,
    fields: fields({ shot_size: 'MS', subjects: [subject('c1', 'L'), subject('c2', 'R')], action: '老周把《某片》的旧海报递给林晓', source }),
    manual_note: 'AT-18 两人镜头',
  });
  await api<Shot>(page, 'POST', '/api/v1/shots', {
    scene_id: scene.id,
    fields: fields({ shot_size: 'EWS', angle: 'low', lens: 'wide', set_piece: true, env: 'open', props: ['building'], subjects: [subject('c1', 'C')], action: '林晓站在旧楼前', source }),
    manual_note: 'AT-18 大场面',
  });
}

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

test('AT-18 AI pencil redraw: settings → confirm → candidate → onion skin → adopt → stale → print', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-redraw'), 'E2E 重绘');
  await setupShots(page);
  const nav = page.getByRole('navigation', { name: '工作流程' });

  // ---- before configuration: the entry is greyed out and says why
  await nav.getByRole('link', { name: /分镜/ }).click();
  const cards = page.locator('button[data-shot]');
  await expect(cards).toHaveCount(2);
  await cards.first().click();
  const redrawButton = page.getByRole('button', { name: 'AI 铅笔重绘（实验）' });
  await expect(redrawButton).toBeDisabled();
  await expect(page.locator('[data-redraw-blocked]')).toContainText('未配置图像模型');

  // ---- settings → 模型 → 图像模型
  await page.goto(`${app.base}/#/settings`);
  await page.getByRole('tab', { name: '模型' }).click();
  const form = page.getByRole('region', { name: '图像模型 · 连接设置' });
  await form.getByLabel('地址（base_url）').fill(fake.url);
  await form.getByLabel('模型', { exact: true }).fill('fake-image-model');
  await form.getByLabel('API key').fill(IMAGE_TEST_KEY);
  await expect(form.getByLabel('写法')).toHaveValue('auto');
  await form.getByRole('button', { name: '保存' }).click();
  const state = page.getByRole('region', { name: '图像模型（实验）' });
  await expect(state).toContainText('已配置');
  await expect(state).toContainText('openai-edits');
  await expect(state).toContainText('未验证');
  await expect(state).toContainText(IMAGE_TEST_KEY.slice(-4));
  // write-only: the key never comes back to the page
  await expect(page.locator('body')).not.toContainText(IMAGE_TEST_KEY);
  await expect(form.getByLabel('API key')).toHaveValue('');

  await form.getByRole('button', { name: '免费检查' }).click();
  await expect(form.getByRole('status').filter({ hasText: '免费检查通过' })).toBeVisible();
  expect(fake.imageRequests()).toHaveLength(0);

  await form.getByRole('button', { name: '付费试生成…' }).click();
  const paid = page.getByRole('dialog', { name: '付费试生成' });
  await expect(paid).toContainText('将生成 1 张最小尺寸图片，费用以服务商账单为准');
  await paid.getByRole('button', { name: '确认生成' }).click();
  await expect(form.getByRole('status').filter({ hasText: '付费试生成成功' })).toBeVisible({ timeout: 30_000 });
  expect(fake.imageRequests()).toHaveLength(1);

  // ---- board page: set_piece shot is marked 推荐
  await nav.getByRole('link', { name: /分镜/ }).click();
  await cards.nth(1).click();
  await expect(page.getByRole('region', { name: '镜 002 分镜稿' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: '分镜稿工具' }).getByText('推荐', { exact: true })).toBeVisible();
  await cards.first().click();
  const sheet = page.getByRole('region', { name: '镜 001 分镜稿' });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('toolbar', { name: '分镜稿工具' }).getByText('推荐', { exact: true })).toHaveCount(0);

  // ---- confirmation: host, dialect, model, what is sent, cost
  await expect(redrawButton).toBeEnabled();
  await redrawButton.click();
  const confirm = page.getByRole('dialog', { name: /AI 铅笔重绘（实验）· 镜 001/ });
  await expect(confirm.locator('[data-redraw-host]')).toHaveText(new URL(fake.url).host);
  await expect(confirm).toContainText('openai-edits');
  await expect(confirm).toContainText('fake-image-model');
  await expect(confirm).toContainText('未验证');
  await expect(confirm.getByRole('list', { name: '提示词摘要' })).toContainText('exactly 2 people');
  await expect(confirm.getByRole('list', { name: '被过滤掉的词' })).toContainText('《某片》');
  await expect(confirm).toContainText('费用以服务商账单为准');
  await expect
    .poll(() =>
      confirm.locator('img[data-control-preview]').evaluate((el) => {
        // (no DOM lib in the node-side tsconfig)
        const img = el as unknown as { complete: boolean; naturalWidth: number };
        return img.complete && img.naturalWidth > 0;
      }),
    )
    .toBe(true);
  expect(fake.imageRequests()).toHaveLength(1); // nothing sent before confirming
  await confirm.getByRole('button', { name: '确认发送' }).click();
  await expect(confirm).toHaveCount(0);

  // ---- candidate appears and opens in the onion-skin comparison
  const list = page.getByRole('list', { name: 'AI 候选列表' });
  await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  expect(fake.imageRequests()).toHaveLength(2);
  expect(fake.imageRequests()[1]!.kind).toBe('edits');
  const item = list.getByRole('listitem').first();
  await expect(item).toContainText('候选');
  await expect(item).toContainText('fake-image-model');
  await expect(item).toContainText('输入 1,200');
  const layer = sheet.locator('[data-ai-layer]');
  await expect(layer).toHaveAttribute('data-ai-layer', 'onion');
  await expect(layer).toHaveAttribute('data-ai-opacity', '50');
  await expect
    .poll(() => layer.locator('image').first().evaluate((el) => (el as unknown as { getBBox(): { width: number } }).getBBox().width))
    .toBeGreaterThan(0);

  const bar = page.getByRole('group', { name: 'AI 图层' });
  await bar.getByLabel('AI 图不透明度').fill('80');
  await expect(bar.locator('output')).toHaveText('80%');
  await expect(layer).toHaveAttribute('data-ai-opacity', '80');
  await bar.getByRole('radio', { name: '只看 AI 图' }).click();
  await expect(layer).toHaveAttribute('data-ai-layer', 'ai');
  await bar.getByRole('radio', { name: '只看线稿' }).click();
  await expect(sheet.locator('[data-ai-layer]')).toHaveCount(0);
  await bar.getByRole('radio', { name: '叠加对比' }).click();
  await expect(layer).toHaveAttribute('data-ai-layer', 'onion');

  // ---- adopt → "AI 图 + 标注" with the corner mark
  await bar.getByRole('button', { name: '采用' }).click();
  await expect(layer).toHaveAttribute('data-ai-layer', 'overlay');
  await expect(sheet.locator('[data-ai-badge]')).toHaveCount(1);
  await expect(sheet.getByText('AI 生成', { exact: true })).toBeVisible();
  await expect(item).toContainText('已采用');
  const rasters = await api<RasterView[]>(page, 'GET', `/api/v1/boards/${(await boardsOf(page))[0]!.id}/rasters`);
  expect(rasters).toHaveLength(1);
  expect(rasters[0]).toMatchObject({ status: 'adopted', stale: false, ai_label_on: true, source_type: 'model_generated' });
  const adoptedId = rasters[0]!.id;
  expect((await boardsOf(page))[0]!.adopted_raster_id).toBe(adoptedId);
  await expect(cards.first()).toHaveAttribute('aria-label', /已采用 AI 图/);

  // single-frame PNG: AI raster + annotations + corner mark
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出这一格 PNG' }).click()]);
  const png = await readFile(await download.path());
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1840 + 96);

  // ---- a structure edit (not saved yet) → stale, nothing is redrawn
  const requestsBefore = fake.imageRequests().length;
  await drag(page, sheet.locator('[data-handle="foot"]').first(), 80, 0);
  await expect(page.getByText('有未保存的修改')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '镜头构图已改，AI 图可能不再对应' })).toBeVisible();
  await expect(sheet.locator('[data-ai-badge="stale"]')).toHaveCount(1);
  await expect(item).toContainText('构图已改');
  await expect(redrawButton).toBeDisabled(); // unsaved: redraw uses the saved board

  // ---- print view: the saved board's adopted raster, with the corner mark
  await page.getByRole('button', { name: '打印分镜' }).click();
  const aiCell = page.locator('[data-print-cell="001"]');
  await expect(aiCell.locator(`[data-ai-raster="${adoptedId}"]`)).toHaveCount(1);
  await expect(aiCell.getByText('AI 生成', { exact: true })).toBeVisible();
  await expect(page.locator('[data-print-cell="002"] [data-ai-raster]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打印', exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: '返回分镜' }).click();

  // ---- save the edit: the adoption stays on v1, flagged stale by the server
  await expect(page.getByText('有未保存的修改')).toBeVisible();
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await expect(page.getByText('v2 · 手动调整').first()).toBeVisible();
  await expect(sheet.locator('[data-ai-layer]')).toHaveCount(0);
  const left = list.getByRole('listitem').first();
  await expect(left).toContainText('v1');
  await expect(left).toContainText('构图已改');
  await expect(page.getByRole('status').filter({ hasText: '镜头构图已改，AI 图可能不再对应' })).toContainText('v1 采用的 AI 图对应旧构图');
  const after = await boardsOf(page);
  expect(after[0]).toMatchObject({ version: 2, adopted_raster_id: null });
  const v1 = await api<RasterView[]>(page, 'GET', `/api/v1/boards/${after[0]!.parent_board_id}/rasters`);
  expect(v1[0]).toMatchObject({ id: adoptedId, status: 'adopted', stale: true });
  expect(fake.imageRequests()).toHaveLength(requestsBefore); // never redrawn automatically

  expect(pageErrors).toEqual([]);
});

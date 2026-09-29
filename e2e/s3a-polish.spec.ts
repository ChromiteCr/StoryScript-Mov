import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BreakdownOutput, PolishOutput, ScriptImportResult, Shot, ShotRevision } from '@storyscript/contracts';
import { POLISH_MODE_HINT } from '@storyscript/core';
import { reply, startFakeOpenAI, type FakeOpenAI } from '../apps/server/test/helpers/fake-openai.ts';
import { api, BOOKSHOP, createProject, ROOT, SCENE_1, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S3a (fake OpenAI service on 127.0.0.1): breakdown of scene 1 (three shots)
 * → 选择 mode: 全选本场 skips the locked shot, its checkbox and its menu item
 * are disabled → AI 润色（2）→ 优化 + a request → one request, one draft →
 * the review shows 改前 / 改后, the changed fields and the model's note →
 * 应用所选 → the rows show the new values and 拍法. A second polish from the
 * shot editor meets an edit made in between: the conflict notice, and the
 * draft is dropped. Also the selection bar on a phone-sized window.
 */

const SCENE1 = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'replay', '01-bookshop.breakdown-v1.scene-1.json'), 'utf8')) as { output_json: BreakdownOutput }).output_json;

const REQUEST = '更有压迫感，加一个环绕镜头';
const NOTES_1 = '稳定器绕书架半圈，缓慢抬头';
const NOTES_2 = '滑轨慢推，肩部入画';

let app: RunningApp;
let fake: FakeOpenAI;

test.beforeAll(async () => {
  fake = await startFakeOpenAI();
  app = await startApp({ noKey: true });
});

test.afterAll(async () => {
  await app?.stop();
  await fake?.close();
});

const noSource = (s: Shot) => {
  const { source: _source, ...rest } = s.fields;
  return rest;
};

test('S3a polish: select shots → request → review before/after → apply; a conflict is caught', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-polish'), '润色测试');

  // ---- model settings, the script, the roster, three shots for scene 1
  await test.step('set up: model, bookshop script, roster, breakdown of scene 1', async () => {
    await api(page, 'PUT', '/api/v1/settings/providers/text', { base_url: fake.url, model: 'fake-model', api_key: 'sk-e2e-polish-1234' });
    const text = readFileSync(BOOKSHOP, 'utf8');
    await api<ScriptImportResult>(page, 'POST', '/api/v1/scripts', { text, source_name: '01-bookshop.txt', format: 'txt', heading_overrides: [] });
    await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] });
    await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '林晓', aliases: [] });
    await page.goto(`${app.base}/#/script`);
    await page.reload();
    const scene1 = page.getByRole('region', { name: SCENE_1, exact: true });
    await scene1.waitFor();

    fake.enqueue(reply.json({ shots: SCENE1.shots.slice(0, 3) }));
    await scene1.getByRole('button', { name: 'AI 拆镜' }).click();
    await page.getByRole('button', { name: '开始拆镜' }).click();
    const draft = page.getByRole('dialog', { name: /AI 拆镜草案 · 第 1 场/ });
    await draft.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });
    await draft.getByRole('button', { name: /应用所选/ }).click();
    await draft.waitFor({ state: 'detached' });
    await expect(scene1.locator('li[id^="shot-"]')).toHaveCount(3);
    expect(fake.chatRequests()).toHaveLength(1);
  });

  const shots = (await api<Shot[]>(page, 'GET', '/api/v1/shots')).sort((x, y) => x.narrative_pos - y.narrative_pos);
  const [a, b, c] = shots as [Shot, Shot, Shot];
  const scene1 = page.getByRole('region', { name: SCENE_1, exact: true });
  const table = page.getByRole('region', { name: /镜头表/ });
  const toggle = table.getByRole('button', { name: '选择', exact: true });
  const bar = page.getByRole('region', { name: '已选镜头' });

  // ---- lock the third shot, then 选择 mode
  await test.step('选择 mode: the locked shot cannot be ticked or sent to AI 润色', async () => {
    await scene1.getByRole('button', { name: `锁定 ${c.code}` }).click();
    await expect(scene1.getByRole('button', { name: `解锁 ${c.code}` })).toBeVisible();

    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(scene1.getByRole('checkbox')).toHaveCount(0);
    await expect(bar).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(scene1.getByRole('checkbox')).toHaveCount(3);

    await expect(bar.getByText('已选 0 个镜头')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'AI 润色（0）' })).toBeDisabled();

    // the locked shot: its checkbox and its menu item are disabled
    await expect(scene1.getByRole('checkbox', { name: `选择镜头 ${c.code}` })).toBeDisabled();
    await scene1.getByRole('button', { name: `${c.code} 的操作` }).click();
    await expect(page.getByRole('menuitem', { name: 'AI 润色…' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'AI 润色…' })).toHaveCount(0);

    // 全选本场 ticks the two unlocked shots only
    await scene1.getByRole('button', { name: '全选本场' }).click();
    await expect(bar.getByText('已选 2 个镜头')).toBeVisible();
    await expect(scene1.getByRole('checkbox', { name: `选择镜头 ${a.code}` })).toBeChecked();
    await expect(scene1.getByRole('checkbox', { name: `选择镜头 ${b.code}` })).toBeChecked();
    await expect(scene1.getByRole('checkbox', { name: `选择镜头 ${c.code}` })).not.toBeChecked();
    await scene1.getByRole('button', { name: '取消本场' }).click();
    await expect(bar.getByText('已选 0 个镜头')).toBeVisible();

    // one by one
    await scene1.getByRole('checkbox', { name: `选择镜头 ${a.code}` }).check();
    await scene1.getByRole('checkbox', { name: `选择镜头 ${b.code}` }).check();
    await expect(bar.getByText('已选 2 个镜头')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'AI 润色（2）' })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('selecting.png') });
  });

  // ---- the request dialog
  const dialog = page.getByRole('dialog', { name: 'AI 润色（2 个镜头）' });
  await test.step('the request: 方式, 润色要求, 风格 and 难度, and what is sent', async () => {
    await bar.getByRole('button', { name: 'AI 润色（2）' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`镜头：${a.code}、${b.code}`)).toBeVisible();

    await expect(dialog.getByRole('button', { name: '细化', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: '优化', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '优化', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: '细化', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByText(POLISH_MODE_HINT.improve)).toBeVisible();

    const wish = dialog.getByLabel('润色要求（可不填）');
    await expect(wish).toHaveAttribute('maxlength', '500');
    await expect(wish).toHaveAttribute('placeholder', '例如：更有压迫感；把对话拍得更克制；加一个环绕镜头');
    await wish.fill(REQUEST);
    await expect(dialog.getByText(`${REQUEST.length}/500`)).toBeVisible();

    await expect(dialog.getByLabel('风格', { exact: true }).locator('option:checked')).toHaveText('不指定');
    await expect(dialog.getByRole('button', { name: '稳妥', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText('将发送这 2 个镜头的内容和出处段落、角色名单（2 人）、你写的润色要求到')).toBeVisible();
    await expect(dialog.getByText('每步最多外发 3 次')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('polish-dialog.png') });
  });

  // ---- one request, then the draft opens on its own
  const review = page.getByRole('dialog', { name: 'AI 润色草案' });
  await test.step('submit: one outgoing request and a draft with 改前 / 改后', async () => {
    const out: PolishOutput = {
      shots: [
        { ref: 's1', change_note: '改成低角度环绕，压迫感更强', fields: { ...noSource(a), angle: 'low', movement: 'orbit', camera_notes: NOTES_1 } },
        { ref: 's2', change_note: '高机位慢推，把人物压在画面下方', fields: { ...noSource(b), angle: 'high', movement: 'push_in', camera_notes: NOTES_2 } },
      ],
    };
    fake.enqueue(reply.json(out));
    await dialog.getByRole('button', { name: '开始润色' }).click();
    await expect(dialog).toHaveCount(0);
    await review.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });

    expect(fake.chatRequests()).toHaveLength(2);
    const sent = fake.chatRequests()[1]!.body!.messages!.at(-1)!.content;
    expect(sent).toContain('〔s1〕');
    expect(sent).toContain('〔s2〕');
    expect(sent).toContain(REQUEST);
    expect(sent).not.toContain('〔s3〕');

    await expect(review.getByText('方式 优化')).toBeVisible();
    await expect(review.getByText('难度 稳妥')).toBeVisible();
    await expect(review.getByText('风格 不指定')).toBeVisible();
    await expect(review.getByText(REQUEST, { exact: false }).first()).toBeVisible();

    const card1 = review.locator('li').filter({ has: page.locator('#polish-item-0') });
    const card2 = review.locator('li').filter({ has: page.locator('#polish-item-1') });
    await expect(review.locator('#polish-item-0')).toBeChecked();
    await expect(review.locator('#polish-item-1')).toBeChecked();
    await expect(card1.getByText(a.code, { exact: true })).toBeVisible();
    await expect(card1.getByText('角度、运动、拍法说明')).toBeVisible();
    await expect(card1.getByText('改成低角度环绕，压迫感更强')).toBeVisible();
    await expect(card1.getByRole('region', { name: '改前' })).toContainText('平视');
    await expect(card1.getByRole('region', { name: '改前' })).toContainText('固定');
    await expect(card1.getByRole('region', { name: '改后' })).toContainText('仰拍');
    await expect(card1.getByRole('region', { name: '改后' })).toContainText('环绕');
    await expect(card1.getByRole('region', { name: '改后' })).toContainText(`拍法：${NOTES_1}`);
    await expect(card2.getByRole('region', { name: '改后' })).toContainText('俯拍');
    await expect(card2.getByRole('region', { name: '改后' })).toContainText(`拍法：${NOTES_2}`);
    await expect(review.getByRole('button', { name: '应用所选（2）' })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('polish-review.png') });
  });

  // ---- apply: the rows change in place
  await test.step('apply: the rows show the new values and 拍法', async () => {
    await review.getByRole('button', { name: '应用所选（2）' }).click();
    await expect(review).toHaveCount(0);
    await expect(page.getByText('已润色 2 个镜头。')).toBeVisible();

    const rowA = scene1.locator(`li[id="shot-${a.id}"]`);
    const rowB = scene1.locator(`li[id="shot-${b.id}"]`);
    await expect(rowA).toContainText('仰拍 · 24mm · 环绕');
    await expect(rowA.locator('[data-shot-camera-notes]')).toHaveText(`拍法：${NOTES_1}`);
    await expect(rowB).toContainText('俯拍 · 50mm · 推');
    await expect(rowB.locator('[data-shot-camera-notes]')).toHaveText(`拍法：${NOTES_2}`);
    // the locked shot was not touched
    await expect(scene1.locator(`li[id="shot-${c.id}"]`)).toContainText('平视');
    await expect(scene1.locator(`li[id="shot-${c.id}"] [data-shot-camera-notes]`)).toHaveCount(0);

    // saved as an AI revision, the script source kept
    const now = await api<Shot[]>(page, 'GET', '/api/v1/shots');
    const na = now.find((s) => s.id === a.id)!;
    expect(na.revision).toBe(a.revision + 1);
    expect(na.fields.source).toEqual(a.fields.source);
    const revs = await api<ShotRevision[]>(page, 'GET', `/api/v1/shots/${a.id}/revisions`);
    expect(revs.at(-1)).toMatchObject({ origin: 'ai', reason: `AI 润色（优化）：${REQUEST}` });

    await bar.getByRole('button', { name: '取消', exact: true }).click();
    await expect(bar).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(scene1.getByRole('checkbox')).toHaveCount(0);
  });

  // ---- a shot edited after the request: 409 → the notice, and the draft can be dropped
  await test.step('the editor button; an edit made after the request is caught on apply', async () => {
    await scene1.locator(`li[id="shot-${a.id}"]`).locator('[data-shot-summary]').click();
    await page.getByRole('button', { name: 'AI 润色…' }).click();
    const one = page.getByRole('dialog', { name: 'AI 润色（1 个镜头）' });
    await expect(one).toBeVisible();

    const current = (await api<Shot[]>(page, 'GET', '/api/v1/shots')).find((s) => s.id === a.id)!;
    fake.enqueue(reply.json({ shots: [{ ref: 's1', change_note: '改了动作', fields: { ...noSource(current), action: '模型改的动作' } }] } satisfies PolishOutput));
    await one.getByRole('button', { name: '开始润色' }).click();
    await review.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });
    expect(fake.chatRequests()).toHaveLength(3);

    // someone edits the shot while the draft is open
    await api(page, 'PATCH', `/api/v1/shots/${a.id}`, { expected_revision: current.revision, fields: { ...current.fields, action: '手改的动作' } });
    await review.getByRole('button', { name: '应用所选（1）' }).click();
    const notice = review.getByRole('note').filter({ hasText: '镜头在润色之后被改过：关掉草案重新润色，或放弃这些改动' });
    await expect(notice).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('polish-conflict.png') });
    await notice.getByRole('button', { name: '放弃草案' }).click();
    await expect(review).toHaveCount(0);

    const after = (await api<Shot[]>(page, 'GET', '/api/v1/shots')).find((s) => s.id === a.id)!;
    expect(after.fields.action).toBe('手改的动作');
    expect(after.revision).toBe(current.revision + 1);
  });

  // ---- a phone-sized window: the selection bar stays reachable
  await test.step('narrow screen: the bar and the checkboxes work', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await scene1.getByRole('checkbox', { name: `选择镜头 ${b.code}` }).check();
    await expect(bar.getByText('已选 1 个镜头')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'AI 润色（1）' })).toBeInViewport();
    await expect(bar.getByRole('button', { name: 'AI 润色（1）' })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('polish-narrow.png') });
    await bar.getByRole('button', { name: 'AI 润色（1）' }).click();
    const narrowDialog = page.getByRole('dialog', { name: 'AI 润色（1 个镜头）' });
    await expect(narrowDialog).toBeVisible();
    await expect(narrowDialog.getByRole('button', { name: '开始润色' })).toBeInViewport();
    await narrowDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(narrowDialog).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

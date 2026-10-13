import { expect, test, type Page } from '@playwright/test';
import type { CurrentScript, Plan, Shot, ShotTip, ShotTipsView } from '@storyscript/contracts';
import { shotsInShootingOrder } from '@storyscript/core';
import { api, signInAnywhere, startApp, type RunningApp } from './support.ts';

/**
 * S5c 拍摄提示 (demo replay, nothing leaves the machine), on the demo
 * project's bookshop shots:
 *  - shot 1-001 in the shot editor shows the first guess (按镜头字段估计, a
 *    difficulty tag and gear) before any model call;
 *  - AI 生成本场拍摄提示 → the confirmation (回放录好的示例) → the recorded
 *    tips: an ordered list, 常见失误, a source line 「AI · HH:MM」;
 *  - a new 运动 saved → 「镜头改过，提示可能过时」 with 重新生成本场 (whose
 *    confirmation is titled 重新生成本场拍摄提示);
 *  - 2-001 set to 环绕 is guessed 难: the shot list marks it 难;
 *  - 拍摄单 print preview: 附拍摄提示 is off by default; ticked, the appendix
 *    lists the tipped shots in shooting order, the changed one 可能过时;
 *  - 重新生成本场 clears the stale notice;
 *  - a scene without a recording fails with its reason and can be retried;
 *  - at phone width the shot editor drawer with tips does not scroll sideways.
 */

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ demo: true });
});
test.afterAll(async () => {
  await app?.stop();
});

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

async function scrollWidth(p: Page): Promise<number> {
  return Number(await p.evaluate('document.documentElement.scrollWidth'));
}

test('S5c: 拍摄提示 — first guess, recorded tips, stale after an edit, 难 badge, call sheet appendix', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setViewportSize(DESKTOP);

  // the demo project opens on the script page with the bookshop shots
  expect(await signInAnywhere(page, app)).toBe('剧本');
  const script = (await api<CurrentScript | null>(page, 'GET', '/api/v1/scripts/current'))!;
  const [scene1, scene2] = script.scenes;
  expect(scene1 && scene2).toBeTruthy();
  const sceneNo = new Map(script.scenes.map((s) => [s.id, s.display_no] as const));
  const shots = () => api<Shot[]>(page, 'GET', '/api/v1/shots');
  const initial = await shots();
  const byCode = (sceneId: string, code: string) => initial.find((s) => s.scene_id === sceneId && s.code === code && !s.archived)!;
  const a = byCode(scene1!.id, '001');
  const b = byCode(scene2!.id, '001');
  expect(a && b).toBeTruthy();
  const tipsView = () => api<ShotTipsView>(page, 'GET', '/api/v1/tips');
  const tipOf = async (id: string): Promise<ShotTip> => (await tipsView()).tips.find((t) => t.shot_id === id)!;

  const group = page.getByRole('region', { name: '拍摄提示', exact: true });
  const openShot = async (shot: Shot) => {
    await page.locator(`li[id="shot-${shot.id}"] [data-shot-summary]`).click();
    await expect(page.getByRole('textbox', { name: '镜号' })).toHaveValue(shot.code);
  };
  const setMovement = async (label: string) => {
    await page.getByRole('combobox', { name: '运动', exact: true }).selectOption({ label });
    await page.getByRole('button', { name: '保存', exact: true }).click();
  };

  await test.step('shot 1-001: the first guess, no model call', async () => {
    const guess = await tipOf(a.id);
    expect(guess).toMatchObject({ source: 'rule', difficulty: 'easy', gear: ['tripod'], tips: [], mistake: null, stale: false });

    await openShot(a);
    await expect(group).toBeVisible();
    await expect(group.getByText('按镜头字段估计', { exact: true })).toBeVisible();
    await expect(group.getByText('难度：易', { exact: true })).toBeVisible();
    await expect(group.getByText('三脚架', { exact: true })).toBeVisible();
    await expect(group.locator('ol > li')).toHaveCount(0);
    await expect(group.getByText(/常见失误：/)).toHaveCount(0);
    await expect(group.getByText('镜头改过，提示可能过时')).toHaveCount(0);
    // the tips are loaded; no shot of the demo is guessed 难, so the list marks nothing
    expect((await tipsView()).tips.some((t) => t.difficulty === 'hard')).toBe(false);
    await expect(page.getByTitle('难度：难')).toHaveCount(0);
  });

  await test.step('AI 生成本场拍摄提示 → confirm (回放录好的示例) → the recorded tips', async () => {
    await group.getByRole('button', { name: 'AI 生成本场拍摄提示' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 生成本场拍摄提示' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/演示模式：回放录好的示例（第 1 场，本场 12 个镜头），不外发，也不计入用量。/)).toBeVisible();
    await expect(dialog.getByText('提示只作参考，不会改动镜头。')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('tips-confirm.png') });
    await dialog.getByRole('button', { name: '开始生成' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(group.locator('ol > li')).toHaveCount(3, { timeout: 30_000 });
    const tip = await tipOf(a.id);
    expect(tip).toMatchObject({ source: 'ai', stale: false, prompt_version: 'tips-v1' });
    await expect(group.locator('ol > li')).toHaveText(tip.tips);
    await expect(group.getByText(`常见失误：${tip.mistake}`)).toBeVisible();
    await expect(group.getByText(/^AI · \d{2}:\d{2}$/)).toBeVisible();
    await expect(group.getByText('按镜头字段估计', { exact: true })).toHaveCount(0);
    await expect(group.getByText(`难度：${{ easy: '易', medium: '中', hard: '难' }[tip.difficulty]}`, { exact: true })).toBeVisible();
    // the job line goes away once the tips are in
    await expect(group.getByRole('status').filter({ hasText: '拍摄提示' })).toHaveCount(0);
    // every shot of scene 1 has the recorded tips; scene 2 keeps its first guesses
    const view = await tipsView();
    const live = await shots();
    const sceneOf = new Map(live.map((s) => [s.id, s.scene_id] as const));
    const ai = view.tips.filter((t) => t.source === 'ai');
    expect(ai).toHaveLength(12);
    expect(ai.every((t) => sceneOf.get(t.shot_id) === scene1!.id && t.tips.length >= 2 && t.tips.length <= 3 && t.mistake)).toBe(true);
    expect(view.tips.filter((t) => sceneOf.get(t.shot_id) === scene2!.id).every((t) => t.source === 'rule')).toBe(true);
    await page.screenshot({ path: test.info().outputPath('tips-ai.png') });
  });

  await test.step('a new 运动 → 「镜头改过，提示可能过时」 with 重新生成本场', async () => {
    await setMovement('摇');
    await expect.poll(async () => (await shots()).find((s) => s.id === a.id)?.fields.movement).toBe('pan');
    const notice = group.getByRole('note').filter({ hasText: '镜头改过，提示可能过时' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: '重新生成本场' })).toBeEnabled();
    // one action at a time: the generate button gives way to the notice
    await expect(group.getByRole('button', { name: 'AI 生成本场拍摄提示' })).toHaveCount(0);
    // the old tips stay readable
    await expect(group.locator('ol > li')).toHaveCount(3);
    expect(await tipOf(a.id)).toMatchObject({ source: 'ai', stale: true });
    await page.screenshot({ path: test.info().outputPath('tips-stale.png') });

    await notice.getByRole('button', { name: '重新生成本场' }).click();
    const again = page.getByRole('dialog', { name: '重新生成本场拍摄提示' });
    await expect(again).toBeVisible();
    await expect(again.getByText(/回放录好的示例/)).toBeVisible();
    await expect(again.getByText('新提示会替换本场现有的 AI 提示；提示只作参考，不会改动镜头。')).toBeVisible();
    await again.getByRole('button', { name: '取消', exact: true }).click();
    await expect(again).toHaveCount(0);
    await expect(notice).toBeVisible();
  });

  await test.step('2-001 set to 环绕 is guessed 难: the shot list marks it', async () => {
    await openShot(b);
    await expect(group.getByText('按镜头字段估计', { exact: true })).toBeVisible();
    await expect(group.getByText('难度：难', { exact: true })).toHaveCount(0);
    await setMovement('环绕');
    await expect(group.getByText('难度：难', { exact: true })).toBeVisible();
    await expect(group.getByText('稳定器', { exact: true })).toBeVisible();
    expect(await tipOf(b.id)).toMatchObject({ source: 'rule', difficulty: 'hard' });
    const row = page.locator(`li[id="shot-${b.id}"]`);
    await expect(row.getByTitle('难度：难')).toBeVisible();
    await expect(row.getByTitle('难度：难')).toHaveText(/^难/);
    // only that shot: easy and medium say nothing
    await expect(page.getByTitle('难度：难')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('shot-list-hard.png') });
  });

  await test.step('拍摄单 print preview: 附拍摄提示 → the appendix in shooting order', async () => {
    await page.goto(`${app.base}/#/plan`);
    await page.getByRole('heading', { name: '计划', level: 1 }).waitFor();
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await page.getByRole('button', { name: /^打印拍摄单/ }).click();
    const withTips = page.getByRole('checkbox', { name: '附拍摄提示' });
    await expect(withTips).toBeVisible();
    await expect(withTips).not.toBeChecked();
    await expect(page.getByRole('heading', { name: '附：拍摄提示' })).toHaveCount(0);

    await withTips.check();
    const appendix = page.getByRole('region', { name: '附：拍摄提示' });
    await expect(appendix.getByRole('heading', { name: '附：拍摄提示' })).toBeVisible();
    for (const col of ['镜号', '难度', '器材', '提示', '常见失误']) {
      await expect(appendix.getByRole('columnheader', { name: col, exact: true })).toBeVisible();
    }

    // expected: the plan's shots in the order the call sheet shoots them, those with the model's tips
    const [plan] = await api<Plan[]>(page, 'GET', '/api/v1/plans');
    const live = new Map((await shots()).filter((s) => !s.archived).map((s) => [s.id, s] as const));
    const tips = new Map((await tipsView()).tips.map((t) => [t.shot_id, t] as const));
    const order = shotsInShootingOrder(plan!).filter((id) => live.has(id));
    const tipped = order.filter((id) => tips.get(id)?.source === 'ai');
    const ref = (id: string) => `${sceneNo.get(live.get(id)!.scene_id)}-${live.get(id)!.code}`;
    expect(tipped.length).toBeGreaterThan(1);
    expect(tipped).toContain(a.id);

    const rows = appendix.locator('tbody > tr');
    await expect(rows).toHaveCount(tipped.length);
    expect(await rows.locator('td:first-child > span:first-child').allTextContents()).toEqual(tipped.map(ref));
    // the changed shot is printed, marked as possibly out of date; the others are not
    const stale = rows.filter({ hasText: ref(a.id) });
    await expect(stale).toContainText('可能过时');
    await expect(rows.filter({ hasText: '可能过时' })).toHaveCount(1);
    const first = tips.get(tipped[0]!)!;
    await expect(rows.first().locator('ol > li')).toHaveText(first.tips);
    await expect(rows.first()).toContainText(first.mistake!);
    const without = order.length - tipped.length;
    if (without > 0) await expect(appendix.getByText(`另有 ${without} 个镜头还没有 AI 拍摄提示，未列出。`)).toBeVisible();
    await appendix.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('callsheet-tips.png') });

    // on paper: the toolbar (with the checkbox) is not printed, the appendix is
    await page.emulateMedia({ media: 'print' });
    await expect(withTips).toBeHidden();
    await expect(appendix).toBeVisible();
    await expect(rows).toHaveCount(tipped.length);
    await page.emulateMedia({ media: null });

    // off again: the appendix goes away
    await withTips.uncheck();
    await expect(appendix).toHaveCount(0);
  });

  await test.step('重新生成本场 clears the stale notice', async () => {
    await page.goto(`${app.base}/#/script`);
    await expect(page.locator(`li[id="shot-${a.id}"]`)).toBeVisible();
    await openShot(a);
    const notice = group.getByRole('note').filter({ hasText: '镜头改过，提示可能过时' });
    await notice.getByRole('button', { name: '重新生成本场' }).click();
    const again = page.getByRole('dialog', { name: '重新生成本场拍摄提示' });
    await again.getByRole('button', { name: '开始生成' }).click();
    await expect(again).toHaveCount(0);
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    await expect(group.getByRole('button', { name: 'AI 生成本场拍摄提示' })).toBeVisible();
    await expect.poll(async () => (await tipOf(a.id)).stale).toBe(false);
    await expect(group.locator('ol > li')).toHaveCount(3);
  });

  await test.step('a scene the demo has no recording for: the job fails with its reason, a retry stays possible', async () => {
    // a renumbered shot changes the replay key of scene 2
    const c = byCode(scene2!.id, '005');
    await openShot(c);
    await page.getByRole('textbox', { name: '镜号' }).fill('009');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await shots()).find((s) => s.id === c.id)?.code).toBe('009');
    await group.getByRole('button', { name: 'AI 生成本场拍摄提示' }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 生成本场拍摄提示' });
    await expect(dialog.getByText(/第 2 场，本场 5 个镜头/)).toBeVisible();
    await dialog.getByRole('button', { name: '开始生成' }).click();
    const line = group.getByRole('status').filter({ hasText: '拍摄提示 失败' });
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line).toContainText('演示模式没有这段输入的录制输出');
    await page.screenshot({ path: test.info().outputPath('tips-failed.png') });
    // nothing was written; the first guess stays and the button works again
    await expect(group.getByText('按镜头字段估计', { exact: true })).toBeVisible();
    await expect(group.getByRole('button', { name: 'AI 生成本场拍摄提示' })).toBeEnabled();
    await line.getByRole('button', { name: '关闭任务状态' }).click();
    await expect(line).toHaveCount(0);
    expect((await tipsView()).tips.filter((t) => t.source === 'ai')).toHaveLength(12);
  });

  await test.step('phone: the shot editor drawer with tips does not scroll sideways', async () => {
    await page.setViewportSize(PHONE);
    await page.getByRole('tab', { name: '镜头表' }).click();
    await page.locator(`li[id="shot-${a.id}"] [data-shot-summary]`).click();
    const drawer = page.getByRole('dialog');
    const phoneTips = drawer.getByRole('region', { name: '拍摄提示', exact: true });
    await phoneTips.scrollIntoViewIfNeeded();
    await expect(phoneTips.locator('ol > li')).toHaveCount(3);
    await expect(phoneTips.getByRole('button', { name: 'AI 生成本场拍摄提示' })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('tips-390.png') });
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
    expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const box = await phoneTips.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
    await page.setViewportSize(DESKTOP);
  });

  expect(pageErrors).toEqual([]);
});

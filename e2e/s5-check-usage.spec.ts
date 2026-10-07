import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ScriptCheckView } from '@storyscript/contracts';
import { api, BOOKSHOP, createProject, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S5 (demo replay, nothing leaves the machine): the script page's 体检 shows
 * the length estimate at once; 找出拍摄难点 → the confirmation → the recorded
 * check → four difficulties by scene; a tick sticks across a reload; a quote
 * jumps to the script. Settings → 用量 opens and says the demo is not billed.
 * At phone width the check is a tab and nothing scrolls sideways.
 */

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ demo: true });
});
test.afterAll(async () => {
  await app?.stop();
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test('S5: 体检 — estimate, recorded difficulties, ticks; 用量 page', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setViewportSize(DESKTOP);

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-s5'), 'E2E 体检');
  await page.goto(`${app.base}/#/script`);
  await page.getByRole('button', { name: /识别场次/ }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(BOOKSHOP);
  await page.getByRole('region', { name: '逐行预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '导入为新版本' }).click();
  await page.getByRole('region', { name: /镜头表/ }).waitFor();

  const panel = page.getByRole('region', { name: '剧本体检' });

  await test.step('the estimate shows before any model call', async () => {
    await page.getByRole('button', { name: /体检/ }).first().click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText('2:25', { exact: true })).toBeVisible();
    await expect(panel.getByText(/目标 10 分钟，比目标短约 76%/)).toBeVisible();
    await expect(panel.getByText('1:48')).toBeVisible();
  });

  await test.step('找出拍摄难点 → confirm → four difficulties by scene', async () => {
    await panel.getByRole('button', { name: '找出拍摄难点' }).click();
    const dialog = page.getByRole('dialog', { name: '剧本体检' });
    await expect(dialog.getByText('演示模式回放录好的样例结果，不外发。')).toBeVisible();
    await dialog.getByRole('button', { name: '开始体检' }).click();
    await expect(panel.getByText('4 条 · 未处理 4')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('heading', { name: /第 1 场/ })).toBeVisible();
    await expect(panel.getByRole('heading', { name: /第 2 场/ })).toBeVisible();
    await expect(panel.getByText('需审批场地')).toBeVisible();
    await expect(panel.getByText(/替代拍法：开拍前用喷壶/)).toBeVisible();
  });

  await test.step('a tick sticks across a reload; the header counts what is open', async () => {
    await panel.getByRole('checkbox').first().check();
    await expect(panel.getByText('4 条 · 未处理 3')).toBeVisible();
    const view = await api<ScriptCheckView>(page, 'GET', '/api/v1/scripts/check');
    expect(view.risks.filter((r) => r.handled)).toHaveLength(1);
    await page.reload();
    await page.getByRole('button', { name: /体检/ }).first().click();
    await expect(panel.getByText('4 条 · 未处理 3')).toBeVisible();
    await expect(panel.getByRole('checkbox').first()).toBeChecked();
    await panel.getByRole('button', { name: '隐藏已处理' }).click();
    await expect(panel.getByRole('checkbox')).toHaveCount(3);
  });

  await test.step('a quote jumps to the script', async () => {
    await panel.getByRole('button', { name: '「墙上挂着一张褪色的合影」' }).click();
    await expect(page.locator('mark', { hasText: '墙上挂着一张褪色的合影' })).toBeVisible();
  });

  await test.step('phone: the check is a tab, nothing scrolls sideways', async () => {
    await page.setViewportSize(PHONE);
    await page.getByRole('tab', { name: '体检' }).click();
    await expect(panel.getByText('4 条 · 未处理 3')).toBeVisible();
    expect(Number(await page.evaluate('document.documentElement.scrollWidth'))).toBeLessThanOrEqual(PHONE.width);
    await page.setViewportSize(DESKTOP);
  });

  await test.step('Settings → 用量', async () => {
    await page.goto(`${app.base}/#/settings`);
    await page.getByRole('tab', { name: '用量' }).click();
    await expect(page.getByText('演示模式不计费')).toBeVisible();
    await expect(page.getByText('还没有调用记录。')).toBeVisible();
    await page.getByText('单价（用来估算花费）').click();
    await page.getByLabel(/输入（¥ \/ 百万 tokens）/).fill('2');
    await page.getByRole('button', { name: '保存单价' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
  });

  expect(pageErrors).toEqual([]);
});

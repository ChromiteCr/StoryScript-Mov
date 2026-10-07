import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Constraint, Resource, Take, Todo } from '@storyscript/contracts';
import { api, signInAnywhere, startApp, ROOT, type RunningApp } from './support.ts';

/**
 * S5a (demo replay, nothing leaves the machine): on the demo project, the
 * page bar opens 粘贴整理 → 填入示例 → 整理 → confirm → the recorded answer
 * sorted by kind, merge / new labels, 需确认 tags, the lines nobody quoted →
 * 应用所选 → the plan page shows the new performers, the constraints and the
 * todos; takes the demo already has are flagged and left unticked. At phone width nothing scrolls sideways.
 * LOOK=1 saves screenshots to .look/.
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
const look = async (page: Page, name: string) => {
  if (process.env.LOOK) await page.screenshot({ path: join(ROOT, '.look', `s5a-${name}.png`) });
};

test('S5a: paste a chat → review → apply → plan, set and todos', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.setViewportSize(DESKTOP);
  await signInAnywhere(page, app);
  await page.goto(`${app.base}/#/plan`);
  await page.getByRole('heading', { name: '计划', level: 1 }).waitFor();
  const before = await api<Resource[]>(page, 'GET', '/api/v1/resources');

  const dialog = page.getByRole('dialog', { name: '粘贴整理' });
  await test.step('open from the page bar, fill in the sample, confirm, wait for the answer', async () => {
    await page.getByRole('button', { name: '粘贴整理', exact: true }).first().click();
    await dialog.getByRole('button', { name: '填入示例' }).click();
    await expect(dialog.getByLabel('这些消息的日期')).toHaveValue('2026-10-09');
    await look(page, 'form');
    await dialog.getByRole('button', { name: '整理', exact: true }).click();
    await expect(dialog.getByText('将分 1 段发送到 演示回放（不外发）')).toBeVisible();
    await dialog.getByRole('button', { name: '确认发送' }).click();
    await expect(dialog.getByRole('heading', { name: /演员档期/ })).toBeVisible({ timeout: 30_000 });
  });

  await test.step('the review: kinds, what applying does, what needs checking, lines nobody quoted', async () => {
    for (const h of ['演员档期', '场地', '器材', '拍摄安排', '道具和服装', '待办和分工', '场记']) await expect(dialog.getByRole('heading', { name: new RegExp(h) })).toBeVisible();
    await expect(dialog.getByText('新建演员').first()).toBeVisible();
    await expect(dialog.getByText('需确认').first()).toBeVisible();
    await expect(dialog.getByText(/剧本里已有道具/)).toHaveCount(0);
    await expect(dialog.getByText(/没有单独成条的消息/)).toBeVisible();
    await expect(dialog.getByText('已经记过这个镜头的第 1 条')).toBeVisible();
    await expect(dialog.getByRole('listitem').filter({ hasText: '已经记过这个镜头的第 1 条' }).getByRole('checkbox')).not.toBeChecked();
    await look(page, 'review');
  });

  await test.step('edit one, apply the ticked ones', async () => {
    const room = dialog.getByRole('listitem').filter({ hasText: '图书馆三楼阅览室' });
    await room.getByRole('button', { name: '编辑' }).click();
    await room.getByLabel('名称').fill('图书馆三楼');
    await expect(room.getByText('已修改')).toBeVisible();
    const apply = dialog.getByRole('button', { name: /应用所选/ });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(dialog.getByRole('status').filter({ hasText: /已写入：新建/ })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('button', { name: '应用所选（0 条）' })).toBeDisabled();
    await look(page, 'applied');
  });

  await test.step('the project has it: performers, a location, constraints, takes, todos', async () => {
    const after = await api<Resource[]>(page, 'GET', '/api/v1/resources');
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((r) => r.name === '图书馆三楼' && r.type === 'location')).toBe(true);
    expect(after.find((r) => r.name === '小雨')).toMatchObject({ type: 'performer', confirmed: false });
    const constraints = await api<Constraint[]>(page, 'GET', '/api/v1/constraints');
    expect(constraints.length).toBeGreaterThan(0);
    // the demo already logged takes 1 and 2 of that shot: both were left unticked
    const takes = await api<Take[]>(page, 'GET', '/api/v1/takes');
    expect(takes.some((t) => t.clip_hint === 'C0012')).toBe(false);
    const todos = await api<Todo[]>(page, 'GET', '/api/v1/todos');
    expect(todos.map((t) => t.text)).toContain('把日记本做旧');
  });

  await test.step('the plan page lists the todos; one is ticked done', async () => {
    await dialog.getByRole('button', { name: '关闭' }).click();
    const panel = page.getByRole('region', { name: /^待办/ });
    await expect(panel.getByText('把日记本做旧')).toBeVisible();
    await expect(panel.getByText(/阿丽/).first()).toBeVisible();
    await panel.getByRole('checkbox', { name: '把日记本做旧' }).check();
    // stays in view, struck through, until the page is reloaded; then it folds under 显示已完成
    await expect(panel.getByRole('checkbox', { name: '把日记本做旧' })).toBeChecked();
    await page.reload();
    await expect(panel.getByText('打印一张褪色的老合影')).toBeVisible();
    await expect(panel.getByText('把日记本做旧')).toHaveCount(0);
    await panel.getByRole('button', { name: /显示已完成/ }).click();
    await expect(panel.getByRole('checkbox', { name: '把日记本做旧' })).toBeChecked();
    await look(page, 'todos');
  });

  await test.step('phone: the dialog is one column, nothing scrolls sideways', async () => {
    await page.setViewportSize(PHONE);
    await page.getByRole('button', { name: '粘贴整理', exact: true }).first().click();
    await expect(dialog.getByRole('combobox', { name: '选择一次整理' })).toBeVisible();
    await dialog.getByRole('combobox', { name: '选择一次整理' }).selectOption({ index: 1 });
    await expect(dialog.getByRole('heading', { name: /演员档期/ })).toBeVisible();
    expect(Number(await page.evaluate('document.documentElement.scrollWidth'))).toBeLessThanOrEqual(PHONE.width);
    await look(page, 'phone');
  });

  expect(pageErrors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { HOSTED_INVITE, startHostedApp, type HostedApp } from './support.ts';

/**
 * Hosted server accounts (S2a), through the screens: register with the invite
 * code and an emailed code, start a group, hand the join link to a teammate
 * who registers from it and lands in the same project; sign out and back in
 * with the password. Codes are read from the server's outbox folder.
 */

let app: HostedApp;

test.beforeAll(async () => {
  app = await startHostedApp();
});
test.afterAll(async () => {
  await app?.stop();
});

async function registerThroughScreens(page: Page, email: string, name: string): Promise<void> {
  await page.getByRole('tab', { name: '注册' }).click();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('邀请码').fill(HOSTED_INVITE.toUpperCase());
  await page.getByRole('button', { name: '发送验证码' }).click();
  await expect(page.getByRole('status').filter({ hasText: `验证码已发到 ${email}` })).toBeVisible();
  await page.getByLabel('邮件里的 6 位验证码').fill(await app.codeFor(email));
  await page.getByLabel('昵称').fill(name);
  await page.getByLabel('密码').fill('password-1');
  await page.getByRole('button', { name: '注册并登录' }).click();
}

test('register, start a group, a teammate joins from the link; both work in one project', async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(app.base);
  await expect(page.getByRole('heading', { name: '测试短片节' })).toBeVisible();

  // a wrong invite code is refused before any mail goes out
  await page.getByRole('tab', { name: '注册' }).click();
  await page.getByLabel('邮箱').fill('lin@school.test');
  await page.getByLabel('邀请码').fill('wrong-code');
  await page.getByRole('button', { name: '发送验证码' }).click();
  await expect(page.getByText('邀请码不对，请向活动负责人确认。')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('register.png') });

  await page.reload();
  await registerThroughScreens(page, 'lin@school.test', '小林');
  await expect(page.getByRole('heading', { name: '小林，你好' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('group-screen.png') });
  await page.getByLabel('组名').fill('雨夜组');
  await page.getByRole('button', { name: '创建小组' }).click();
  await expect(page.getByRole('banner').getByText('雨夜组：小林')).toBeVisible();
  await expect(page.getByRole('banner').getByText('雨夜组', { exact: true })).toBeVisible(); // the group's project

  // the group panel hands out the join link
  await page.getByRole('banner').getByText('雨夜组：小林').click();
  const panel = page.getByRole('dialog', { name: '雨夜组' });
  const link = (await panel.locator('code').first().textContent())!.trim();
  expect(link).toMatch(new RegExp(`^${app.base.replace(/[.]/g, '\\.')}/#join=[A-Z2-9]{4}-[A-Z2-9]{4}$`));
  await page.screenshot({ path: test.info().outputPath('group-panel.png') });
  await panel.getByRole('button', { name: '关闭' }).click();

  // teammate: opens the link, registers, joins with the code already filled in
  const other = await browser.newContext();
  const p2 = await other.newPage();
  p2.on('pageerror', (e) => pageErrors.push(e.message));
  await p2.goto(link);
  await expect(p2.getByText('你打开的是小组加入链接')).toBeVisible();
  await expect(p2).toHaveURL(`${app.base}/`); // the code left the address bar
  await registerThroughScreens(p2, 'zhou@school.test', '小周');
  await expect(p2.getByLabel('组码或加入链接')).toHaveValue(link.split('#join=')[1]!);
  await p2.getByRole('button', { name: '加入', exact: true }).click();
  await expect(p2.getByRole('banner').getByText('雨夜组：小周')).toBeVisible();

  // same project: a character made by one shows up for the other
  const made = await page.request.post(`${app.base}/api/v1/entities`, { data: { type: 'character', name: '店主', aliases: [] }, headers: { origin: app.base } });
  expect(made.status()).toBe(201);
  const seen = (await (await p2.request.get(`${app.base}/api/v1/entities`)).json()) as { data: { name: string }[] };
  expect(seen.data.map((e) => e.name)).toContain('店主');

  // sign out, then back in with the password
  await p2.getByRole('button', { name: '账号' }).click();
  await p2.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(p2.getByRole('tab', { name: '登录' })).toBeVisible();
  await p2.getByLabel('邮箱').fill('zhou@school.test');
  await p2.getByLabel('密码').fill('password-1');
  await p2.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p2.getByRole('banner').getByText('雨夜组：小周')).toBeVisible();
  await other.close();

  expect(pageErrors).toEqual([]);
});

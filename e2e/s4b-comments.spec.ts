import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ScriptImportResult, Shot, ShotFields } from '@storyscript/contracts';
import { api, BOOKSHOP, signUpHosted, startHostedApp, type HostedApp } from './support.ts';

/**
 * S4b shot comments, two accounts in one group (through the screens):
 *  - A is the leader and holds 导演, B is a member and holds 摄影
 *  - B opens a shot and writes 「这里改成仰拍？ @导演」: the @ list offers the
 *    role and the people, the box says whom it will remind
 *  - A sees the bell count and the dot on the shot row, opens the thread from
 *    the bell (the shot opens, the comment is in view), replies 「可以」 and
 *    marks it resolved; opening it marked it read, so the bell and the dot clear
 *  - B sees the thread resolved (no reload if the change feed already brought
 *    it), expands it, edits their comment
 *  - B mentions A by name; A opens it from the bell at 390px
 *  - the board page: the 批注 section says which version, 本版 / 全部 filters
 * Desktop pictures, and the same screens at 390px.
 *
 * Needs <MentionsBell/> in the title bar and <OpenShotBridge/> in the script
 * workspace (the narrow layout has no inspector until a shot is open).
 */

let app: HostedApp;

test.beforeAll(async () => {
  app = await startHostedApp();
});
test.afterAll(async () => {
  await app?.stop();
});

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

function shotFields(source: ShotFields['source']): ShotFields {
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
    action: '店主抬头看向门口',
    dialogue_quote: null,
    assumptions: [],
    questions: [],
    source,
  };
}

interface Account {
  group: { slug: string; join_code: string; members: { id: string; you: boolean; name: string }[] };
}

/** The script page with the shot table showing. */
async function openScript(p: Page, base: string) {
  await p.goto(`${base}/#/script`);
  await p.reload();
  const table = p.getByRole('region', { name: /镜头表/ });
  await expect(table).toBeVisible();
  return table;
}

test('S4b: a comment with @导演, the bell, resolving it, and the board page', async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ---- A starts the group, B joins; each takes a crew role
  await signUpHosted(page, app, 'lin@school.test', '小林', '雨夜组');
  await page.goto(app.base);
  const accountA = await api<Account>(page, 'GET', '/api/v1/account');
  const other = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark', viewport: DESKTOP });
  const p2 = await other.newPage();
  p2.on('pageerror', (e) => pageErrors.push(e.message));
  await signUpHosted(p2, app, 'zhou@school.test', '小周');
  await p2.goto(app.base);
  const joined = await p2.request.post(`${app.base}/api/v1/groups/join`, { data: { code: accountA.group.join_code }, headers: { origin: app.base } });
  expect(joined.ok()).toBe(true);
  const accountB = await api<Account>(p2, 'GET', '/api/v1/account');
  const slug = accountA.group.slug;
  await api(page, 'PUT', `/api/v1/groups/${slug}/members/${accountA.group.members.find((m) => m.you)!.id}/crew-roles`, { crew_roles: ['导演'] });
  await api(p2, 'PUT', `/api/v1/groups/${slug}/members/${accountB.group.members.find((m) => m.you)!.id}/crew-roles`, { crew_roles: ['摄影'] });

  // ---- a script and one shot
  const imported = await api<ScriptImportResult>(page, 'POST', '/api/v1/scripts', {
    text: readFileSync(BOOKSHOP, 'utf8'),
    source_name: '01-bookshop.txt',
    format: 'txt',
    heading_overrides: [],
  });
  const scene = imported.scenes[0]!;
  const made = await api<Shot>(page, 'POST', '/api/v1/shots', {
    scene_id: scene.id,
    fields: shotFields({ paragraph_id: scene.paragraph_ids[1]!, quote: '' }),
    manual_note: 'S4b 批注测试',
  });

  // ---- B opens the shot and writes 「这里改成仰拍？ @导演」
  const tableB = await openScript(p2, app.base);
  await expect(tableB.getByRole('button', { name: /的批注/ })).toHaveCount(0); // nothing yet
  await tableB.locator('li[id^="shot-"]').first().locator('[data-shot-summary]').click();
  const commentsB = p2.getByRole('region', { name: '批注', exact: true });
  await expect(commentsB.getByText('还没有批注。')).toBeVisible();
  const boxB = commentsB.getByLabel('写批注', { exact: true });
  await boxB.fill('这里改成仰拍？ @导');
  const picker = commentsB.getByRole('listbox', { name: '提到组员或职务' });
  await expect(picker.getByRole('option', { name: /@导演/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /@小林/ })).toBeVisible(); // the person who holds it
  await expect(picker.getByRole('option', { name: /@小周/ })).toHaveCount(0); // not oneself
  await p2.screenshot({ path: testInfo.outputPath('mention-picker-desktop.png') });
  await picker.getByRole('option', { name: /@导演/ }).click();
  await expect(boxB).toHaveValue('这里改成仰拍？ @导演 ');
  await expect(picker).toHaveCount(0);
  await expect(commentsB.getByText('会提醒：小林')).toBeVisible();
  await commentsB.getByRole('button', { name: '发表', exact: true }).click();
  const rootB = commentsB.getByRole('article', { name: '小周 的批注' });
  await expect(rootB).toContainText('这里改成仰拍？ @导演');
  await expect(rootB.getByText('@导演', { exact: true })).toBeVisible(); // the mention as a tag
  await expect(boxB).toHaveValue('');
  await expect(tableB.getByRole('button', { name: /批注：1 条讨论还没解决/ })).toBeVisible();

  // ---- A: the bell counts it, the shot row has a dot
  const table = await openScript(page, app.base);
  const bell = page.getByRole('button', { name: '提到我的：1 条未读' });
  await expect(bell).toBeVisible();
  const rowBadge = table.getByRole('button', { name: /的批注：.*未读/ });
  await expect(rowBadge).toBeVisible();
  await bell.click();
  const popover = page.getByRole('region', { name: '提到我的', exact: true });
  const entry = popover.getByRole('button', { name: /^小周（摄影）在 第 .+ 场 .+ 提到了你：这里改成仰拍？/ });
  await expect(entry).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('bell-desktop.png') });

  // opening it from the bell: the shot opens and its comment is in view
  await entry.click();
  const commentsA = page.getByRole('region', { name: '批注', exact: true });
  const rootA = commentsA.getByRole('article', { name: '小周 的批注' });
  await expect(rootA).toBeVisible();
  await expect(rootA).toBeInViewport();
  // read by showing it: the bell count and the row's dot go, while the comment stays marked new in the open panel
  await expect(page.getByRole('button', { name: '提到我的', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '提到我的：1 条未读' })).toHaveCount(0);
  await expect(table.getByRole('button', { name: /的批注：.*未读/ })).toHaveCount(0);
  await expect(rootA).toContainText('未读');
  await page.screenshot({ path: testInfo.outputPath('thread-leader-desktop.png') });

  // ---- A replies 「可以」 and marks the thread resolved (the leader may delete it, but cannot edit B's words)
  await rootA.getByRole('button', { name: '批注操作（小周）' }).click();
  await expect(page.getByRole('menuitem', { name: '编辑' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible();
  await page.getByRole('menuitem', { name: '回复' }).click();
  await commentsA.getByLabel('回复 小周').fill('可以');
  await commentsA.getByRole('button', { name: '发表回复' }).click();
  await expect(commentsA.getByRole('article', { name: '小林 的批注' })).toContainText('可以');
  await rootA.getByRole('button', { name: '批注操作（小周）' }).click();
  await page.getByRole('menuitem', { name: '标为已解决' }).click();
  const foldedA = commentsA.getByRole('button', { name: /^已解决 · 小林 · \d{2}:\d{2}（展开）$/ });
  await expect(foldedA).toBeVisible();
  await expect(table.getByRole('button', { name: /批注：.*都已解决/ })).toBeVisible();

  // ---- B sees it resolved (without a reload when the change feed brought it)
  const foldedB = commentsB.getByRole('button', { name: /^已解决 · 小林 · \d{2}:\d{2}（展开）$/ });
  let reloaded = false;
  try {
    await expect(foldedB).toBeVisible({ timeout: 12_000 });
  } catch {
    reloaded = true;
    await openScript(p2, app.base);
    await tableB.locator('li[id^="shot-"]').first().locator('[data-shot-summary]').click();
    await expect(foldedB).toBeVisible();
  }
  testInfo.annotations.push({ type: 'note', description: reloaded ? 'B needed a reload to see the resolved thread' : 'B saw the resolved thread live' });
  await expect(tableB.getByRole('button', { name: /都已解决/ })).toBeVisible();
  await foldedB.click();
  await expect(commentsB.getByRole('article', { name: '小林 的批注' })).toContainText('可以');
  await p2.screenshot({ path: testInfo.outputPath('thread-member-desktop.png') });

  // B edits their own comment (the leader's menu had no 编辑 for it)
  const ownRoot = commentsB.getByRole('article', { name: '小周 的批注' });
  await ownRoot.getByRole('button', { name: '批注操作（小周）' }).click();
  await p2.getByRole('menuitem', { name: '编辑' }).click();
  const editBox = commentsB.getByLabel('修改批注');
  await expect(editBox).toHaveValue('这里改成仰拍？ @导演');
  await editBox.fill('这里改成仰拍？ @导演 顺便加个特写');
  await commentsB.getByRole('button', { name: '保存', exact: true }).click();
  await expect(ownRoot).toContainText('顺便加个特写');
  await expect(ownRoot).toContainText('已编辑');

  // ---- B mentions A by name; A opens it from the bell at 390px
  await boxB.fill('@小');
  await expect(picker.getByRole('option', { name: /@小林/ })).toBeVisible();
  await picker.getByRole('option', { name: /@小林/ }).click();
  await boxB.press('End');
  await boxB.pressSequentially('这个镜头要不要加一句台词？');
  await commentsB.getByRole('button', { name: '发表', exact: true }).click();
  await expect(commentsB.getByRole('article', { name: '小周 的批注' }).filter({ hasText: '要不要加一句台词' })).toBeVisible();

  await page.setViewportSize(PHONE);
  await openScript(page, app.base);
  const phoneBell = page.getByRole('button', { name: '提到我的：1 条未读' });
  await expect(phoneBell).toBeVisible();
  await phoneBell.click();
  const phonePopover = page.getByRole('region', { name: '提到我的', exact: true });
  const phoneEntry = phonePopover.getByRole('button', { name: /小周（摄影）在 .+ 提到了你：@小林 这个镜头要不要加一句台词？/ });
  await expect(phoneEntry).toBeVisible();
  const box = await phonePopover.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  await page.screenshot({ path: testInfo.outputPath('bell-390.png') });
  await phoneEntry.click();
  const drawer = page.getByRole('dialog');
  const phoneComments = drawer.getByRole('region', { name: '批注', exact: true });
  await expect(phoneComments.getByRole('article', { name: '小周 的批注' }).filter({ hasText: '要不要加一句台词' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('comments-390.png') });
  expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
  expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // the composer at 390px, with the @ button
  await phoneComments.getByLabel('写批注', { exact: true }).scrollIntoViewIfNeeded();
  await phoneComments.getByRole('button', { name: '提到组员或职务' }).click();
  await expect(phoneComments.getByRole('listbox', { name: '提到组员或职务' })).toBeVisible();
  await phoneComments.getByLabel('写批注', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mention-picker-390.png') });
  expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
  await page.keyboard.press('Escape'); // closes the @ list
  await page.setViewportSize(DESKTOP);

  // ---- the board page: comments are about a version, 本版 / 全部 filters
  await p2.goto(`${app.base}/#/boards`);
  await p2.reload();
  const commentsBoard = p2.getByRole('region', { name: '批注', exact: true });
  await expect(commentsBoard).toBeVisible();
  await expect(commentsBoard.getByText('新批注针对 v1')).toBeVisible();
  await expect(commentsBoard.getByRole('radio', { name: '本版 0' })).toHaveAttribute('aria-checked', 'true');
  await expect(commentsBoard.getByRole('radio', { name: '全部 2' })).toBeVisible();
  await expect(commentsBoard.getByText('这一版还没有批注。')).toBeVisible();
  await commentsBoard.getByLabel('写批注', { exact: true }).fill('v1 的构图偏左');
  await commentsBoard.getByRole('button', { name: '发表', exact: true }).click();
  await expect(commentsBoard.getByRole('article', { name: '小周 的批注' })).toContainText('v1 的构图偏左');
  await expect(commentsBoard.getByText('针对 v1', { exact: true })).toBeVisible();
  await expect(commentsBoard.getByRole('radio', { name: '本版 1' })).toBeVisible();
  await expect(commentsBoard.getByRole('radio', { name: '全部 3' })).toBeVisible();
  await expect(commentsBoard.getByText('要不要加一句台词')).toHaveCount(0); // not about this version
  await commentsBoard.getByRole('radio', { name: '全部 3' }).click();
  await expect(commentsBoard.getByText('要不要加一句台词')).toBeVisible();
  await commentsBoard.scrollIntoViewIfNeeded();
  await p2.screenshot({ path: testInfo.outputPath('board-comments-desktop.png') });

  await p2.setViewportSize(PHONE);
  await p2.getByRole('tab', { name: '属性' }).click();
  await p2.getByRole('region', { name: '批注', exact: true }).scrollIntoViewIfNeeded();
  await p2.screenshot({ path: testInfo.outputPath('board-comments-390.png') });
  expect(await scrollWidth(p2)).toBeLessThanOrEqual(PHONE.width);
  await p2.setViewportSize(DESKTOP);

  // ---- nobody's email reaches a teammate in a comment
  const raw = await api(page, 'GET', `/api/v1/shots/${made.id}/comments`);
  expect(JSON.stringify(raw)).not.toMatch(/school\.test|@school/);

  await other.close();
  expect(pageErrors).toEqual([]);
});

/** Width of the page's content: more than the window means it scrolls sideways. */
async function scrollWidth(p: Page): Promise<number> {
  return Number(await p.evaluate('document.documentElement.scrollWidth'));
}

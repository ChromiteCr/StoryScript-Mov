import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ScriptImportResult, Shot, ShotFields } from '@storyscript/contracts';
import { api, BOOKSHOP, signUpHosted, startHostedApp, type HostedApp } from './support.ts';

/**
 * S4 hosted server, two accounts in one group (through the screens):
 *  - crew roles: a member sets their own (presets and one of their own, with
 *    the checks), the leader sees them, a member cannot edit someone else's
 *  - models: a member sees the group's model read-only with the reason, their
 *    own model editable, and switches to it — the warning says it is not filled
 *    in and the AI gate says whose model is missing; the leader edits the
 *    group's model
 *  - who changed what: the shot's 修订历史 names each editor with their roles,
 *    the script header says who imported it, and no email reaches a teammate.
 * Desktop pictures, and the same screens at 390px.
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

test('S4: crew roles, the group’s model versus one’s own, and who changed what', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ---- A starts the group and takes the director's role
  await signUpHosted(page, app, 'lin@school.test', '小林', '雨夜组');
  await page.goto(app.base);
  await expect(page.getByRole('banner').getByText('雨夜组：小林')).toBeVisible();
  await page.getByRole('banner').getByText('雨夜组：小林').click();
  const panelA = page.getByRole('dialog', { name: '雨夜组' });
  const link = (await panelA.locator('code').first().textContent())!.trim();
  const code = link.split('#join=')[1]!;

  await panelA.getByRole('button', { name: '编辑职务：小林' }).click();
  const editorA = panelA.getByRole('group', { name: '编辑 小林 的职务' });
  await editorA.getByRole('button', { name: '导演', exact: true }).click();
  await expect(editorA.getByRole('button', { name: '导演', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editorA.getByRole('button', { name: '保存职务' }).click();
  await expect(editorA).toHaveCount(0);
  const rowA = panelA.locator('li').filter({ hasText: '小林（你）' });
  await expect(rowA.getByText('导演', { exact: true })).toBeVisible();
  await expect(rowA.getByText('组长', { exact: true })).toBeVisible();
  await panelA.getByRole('button', { name: '关闭' }).click();

  // ---- B joins and sets roles: two presets' worth of checks, then one of their own
  const other = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark', viewport: DESKTOP });
  const p2 = await other.newPage();
  p2.on('pageerror', (e) => pageErrors.push(e.message));
  await signUpHosted(p2, app, 'zhou@school.test', '小周');
  const joined = await p2.request.post(`${app.base}/api/v1/groups/join`, { data: { code }, headers: { origin: app.base } });
  expect(joined.ok()).toBe(true);
  await p2.goto(app.base);
  await expect(p2.getByRole('banner').getByText('雨夜组：小周')).toBeVisible();
  await p2.getByRole('banner').getByText('雨夜组：小周').click();
  const panelB = p2.getByRole('dialog', { name: '雨夜组' });

  // a member edits only their own roles and cannot remove anyone
  await expect(panelB.getByRole('button', { name: '编辑职务：小周' })).toBeVisible();
  await expect(panelB.getByRole('button', { name: '编辑职务：小林' })).toHaveCount(0);
  await expect(panelB.getByRole('button', { name: '移出' })).toHaveCount(0);
  await expect(panelB.locator('li').filter({ hasText: '小林' }).getByText('导演', { exact: true })).toBeVisible();

  await panelB.getByRole('button', { name: '编辑职务：小周' }).click();
  const editorB = panelB.getByRole('group', { name: '编辑 小周 的职务' });
  await editorB.getByRole('button', { name: '摄影', exact: true }).click();
  await expect(editorB.getByRole('button', { name: '摄影', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const custom = editorB.getByLabel('自己写一个职务');
  await custom.fill('副 导演');
  await editorB.getByRole('button', { name: '添加' }).click();
  await expect(editorB.getByText('职务里不能有空格、@ 或逗号')).toBeVisible();
  await expect(custom).toHaveAttribute('aria-invalid', 'true');
  await custom.fill('副导演');
  await custom.press('Enter'); // Enter adds the role, it does not save
  await expect(editorB.getByRole('button', { name: '副导演', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editorB).toBeVisible();
  await p2.screenshot({ path: test.info().outputPath('crew-roles-desktop.png') });

  await p2.setViewportSize(PHONE);
  await editorB.scrollIntoViewIfNeeded();
  await p2.screenshot({ path: test.info().outputPath('crew-roles-390.png') });
  expect(await scrollWidth(p2)).toBeLessThanOrEqual(PHONE.width);
  await p2.setViewportSize(DESKTOP);

  await editorB.getByRole('button', { name: '保存职务' }).click();
  await expect(editorB).toHaveCount(0);
  const rowB = panelB.locator('li').filter({ hasText: '小周（你）' });
  await expect(rowB.getByText('摄影', { exact: true })).toBeVisible();
  await expect(rowB.getByText('副导演', { exact: true })).toBeVisible();
  await panelB.getByRole('button', { name: '关闭' }).click();

  // ---- A sees B's roles, and may edit them too
  await page.reload();
  await expect(page.getByRole('banner').getByText('雨夜组：小林')).toBeVisible();
  await page.getByRole('banner').getByText('雨夜组：小林').click();
  const reopened = page.getByRole('dialog', { name: '雨夜组' });
  const seenB = reopened.locator('li').filter({ hasText: '小周' });
  await expect(seenB.getByText('摄影', { exact: true })).toBeVisible();
  await expect(seenB.getByText('副导演', { exact: true })).toBeVisible();
  await expect(reopened.getByRole('button', { name: '编辑职务：小周' })).toBeVisible();
  await expect(reopened.getByRole('button', { name: '移出' })).toBeVisible();
  await reopened.getByRole('button', { name: '关闭' }).click();

  // the 项目 page lists who is in each group, with their roles
  await page.goto(`${app.base}/#/projects`);
  await expect(page.getByText('小林（导演）、小周（摄影、副导演）')).toBeVisible();
  await page.waitForTimeout(500); // let the page fade in before the picture
  await page.screenshot({ path: test.info().outputPath('projects-roster.png') });

  // ---- B imports the script and adds a shot; A (the director) then edits it
  await p2.goto(`${app.base}/#/script`);
  const imported = await api<ScriptImportResult>(p2, 'POST', '/api/v1/scripts', {
    text: readFileSync(BOOKSHOP, 'utf8'),
    source_name: '01-bookshop.txt',
    format: 'txt',
    heading_overrides: [],
  });
  const scene = imported.scenes[0]!;
  const made = await api<Shot>(p2, 'POST', '/api/v1/shots', {
    scene_id: scene.id,
    fields: shotFields({ paragraph_id: scene.paragraph_ids[1]!, quote: '' }),
    manual_note: 'S4 协作测试',
  });
  await api(page, 'PATCH', `/api/v1/shots/${made.id}`, {
    expected_revision: made.revision,
    fields: { ...made.fields, action: '店主抬头，看向门口的来客' },
    reason: '按勘景结果改',
  });
  // B's shot got its first board when it was made; A lays it out again; B logs a take
  await api(page, 'POST', `/api/v1/shots/${made.id}/boards`);
  await api(p2, 'POST', '/api/v1/takes', { setup_id: null, camera_label: 'A', rating: 'good', clip_hint: null, notes: '', shot_ids: [made.id], unresolved_labels: [] });

  // ---- the AI gate says whose model is missing (nothing is configured anywhere)
  await p2.goto(`${app.base}/#/script`);
  await p2.reload();
  await expect(p2.getByRole('region', { name: /镜头表/ })).toBeVisible();
  await expect(p2.getByText('组长还没配置本组的模型').first()).toBeVisible();

  // ---- B's settings: the group's model is read-only, their own is editable
  await p2.goto(`${app.base}/#/settings`);
  await p2.getByRole('tab', { name: '模型' }).click();
  const groupSection = p2.getByRole('region', { name: '本组的模型', exact: true });
  await expect(groupSection.getByText('只有组长能改本组的模型。')).toBeVisible();
  await expect(groupSection).toContainText('你可以在下面填自己的模型，并选择在本组用哪一个。');
  await expect(groupSection.getByLabel('地址（base_url）').first()).not.toBeEditable();
  await expect(groupSection.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(groupSection.getByRole('button', { name: /付费试生成/ })).toHaveCount(0);
  await expect(groupSection.getByText('由组长保管').first()).toBeVisible();

  const mine = p2.getByRole('region', { name: '我的模型', exact: true });
  await expect(mine).toContainText('只有你自己看得到');
  const mineText = mine.locator('form').first();
  await expect(mineText.getByLabel('地址（base_url）')).toBeEditable();
  await mineText.getByLabel('地址（base_url）').fill('https://api.example.test/v1');
  await expect(mineText.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(mine.getByRole('button', { name: /付费试生成/ })).toBeVisible();

  // the choice: the group's model until B switches to their own
  const use = p2.getByRole('region', { name: '在本组使用', exact: true });
  const textChoice = use.getByRole('group', { name: '文本模型' });
  await expect(textChoice.getByRole('button', { name: '组的模型' })).toHaveAttribute('aria-pressed', 'true');
  await expect(use.getByText('还没填好你自己的文本模型')).toHaveCount(0);
  await textChoice.getByRole('button', { name: '我的模型' }).click();
  await expect(textChoice.getByRole('button', { name: '我的模型' })).toHaveAttribute('aria-pressed', 'true');
  await expect(use.getByRole('status').filter({ hasText: '你选了用自己的文本模型，但还没填好' })).toBeVisible();
  await expect(use.getByRole('status').filter({ hasText: '不会自动改用组的模型' })).toBeVisible();
  await p2.screenshot({ path: test.info().outputPath('models-member-desktop.png') });

  // health follows the choice, and so does the AI gate on the script page
  const health = await api<{ text_model_source: string; text_provider_configured: boolean; image_model_source: string }>(p2, 'GET', '/api/v1/health');
  expect(health).toMatchObject({ text_model_source: 'own', text_provider_configured: false, image_model_source: 'group' });
  await p2.goto(`${app.base}/#/script`);
  await expect(p2.getByText('你选了自己的文本模型，但还没填好').first()).toBeVisible();

  // the same screens at 390px
  await p2.setViewportSize(PHONE);
  await p2.goto(`${app.base}/#/settings`);
  await p2.getByRole('tab', { name: '模型' }).click();
  await expect(p2.getByRole('region', { name: '在本组使用', exact: true })).toBeVisible();
  await p2.getByRole('region', { name: '在本组使用', exact: true }).scrollIntoViewIfNeeded();
  await p2.screenshot({ path: test.info().outputPath('models-member-390.png') });
  expect(await scrollWidth(p2)).toBeLessThanOrEqual(PHONE.width);
  await p2.getByRole('region', { name: '本组的模型', exact: true }).scrollIntoViewIfNeeded();
  await p2.screenshot({ path: test.info().outputPath('models-group-390.png') });
  await p2.setViewportSize(DESKTOP);

  // ---- the leader edits the group's model: no notice, the form is live
  await page.goto(`${app.base}/#/settings`);
  await page.getByRole('tab', { name: '模型' }).click();
  const leaderGroup = page.getByRole('region', { name: '本组的模型', exact: true });
  await expect(leaderGroup.getByLabel('地址（base_url）').first()).toBeEditable();
  await expect(leaderGroup.getByText('只有组长能改本组的模型。')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '在本组使用', exact: true }).getByRole('group', { name: '文本模型' }).getByRole('button', { name: '组的模型' })).toHaveAttribute('aria-pressed', 'true');

  // ---- who changed what: the shot's history names both, with their roles
  await page.goto(`${app.base}/#/script`);
  await page.reload();
  const table = page.getByRole('region', { name: /镜头表/ });
  await expect(table).toBeVisible();
  await expect(page.getByText('导入：小周（摄影、副导演）')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('script-header.png') });
  await table.getByRole('button', { name: `${made.code} 的操作` }).click();
  await page.getByRole('menuitem', { name: '修订历史' }).click();
  const history = page.getByRole('dialog', { name: `修订历史 · ${made.code}` });
  const revisions = history.locator('ol > li');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.nth(0)).toContainText('小林（导演）');
  await expect(revisions.nth(0)).toContainText('说明：按勘景结果改');
  await expect(revisions.nth(1)).toContainText('小周（摄影、副导演）');
  await history.screenshot({ path: test.info().outputPath('revisions-desktop.png') });
  await page.setViewportSize(PHONE);
  await page.screenshot({ path: test.info().outputPath('revisions-390.png') });
  expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE.width);
  await page.setViewportSize(DESKTOP);
  await history.getByRole('button', { name: '关闭' }).click();

  // ---- the board's version list and the take list name their authors too
  await page.goto(`${app.base}/#/boards`);
  const versions = page.getByLabel('版本历史');
  await expect(versions).toBeVisible();
  await expect(versions.locator('option').first()).toContainText('最新 · v2 · 自动生成 · 小林');
  await expect(versions.locator('option').nth(1)).toContainText('v1 · 自动生成 · 小周');
  await page.goto(`${app.base}/#/set`);
  await expect(page.getByText('记录：小周（摄影、副导演）')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('set-takes.png') });

  // ---- nobody's email reaches a teammate
  const revisionRows = await api(page, 'GET', `/api/v1/shots/${made.id}/revisions`);
  const account = await api<{ group: { members: unknown[] } }>(page, 'GET', '/api/v1/account');
  const scriptVersions = await api(page, 'GET', '/api/v1/scripts/versions');
  for (const seen of [revisionRows, account.group.members, scriptVersions]) {
    expect(JSON.stringify(seen)).not.toMatch(/school\.test|@/);
  }
  await expectNoEmail(page, 'zhou@school.test');
  await expectNoEmail(p2, 'lin@school.test');

  await other.close();
  expect(pageErrors).toEqual([]);
});

/** The page never shows a teammate's address, in the text or in the markup. */
async function expectNoEmail(p: Page, email: string): Promise<void> {
  expect(await p.content()).not.toContain(email);
}

/** Width of the page's content: more than the window means it scrolls sideways. */
async function scrollWidth(p: Page): Promise<number> {
  return Number(await p.evaluate('document.documentElement.scrollWidth'));
}

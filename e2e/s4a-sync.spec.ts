import { expect, test, type Page } from '@playwright/test';
import type { Setup, Shot, ShotFields } from '@storyscript/contracts';
import { api, BOOKSHOP, SCENE_1, signUpHosted, startHostedApp, type HostedApp } from './support.ts';

/**
 * S4a hosted server, two accounts in one group, two browser contexts:
 *  - who is online: B's title bar shows A, the popover says which page and
 *    the group's last events
 *  - A imports a script through the screen; B's page (open on the import
 *    screen) shows the scenes without a reload
 *  - A makes a shot and edits its action; B's shot row follows, B sees the
 *    activity line 「小林刚改了 …」 and, with the same shot open, 「小林也在看这个镜头」
 *  - a setup being renamed by B while A renames it too: B's typed name stays,
 *    the conflict notice shows; 用他的 loads A's name, 保留我的 saves B's
 *  - A archives the shot B is editing: the editor stays with B's text, saving
 *    is off, 复制文字 puts the text on the clipboard, 放弃 lets go
 * Desktop pictures, and the title bar and the setup conflict at 390px (below
 * 1024px the inspector is a drawer that a resize closes, so the archived shot
 * is pictured on the desktop only).
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
/** a poll every ~4 s plus the refetch it triggers: the plan promises "within 5 s"; the check allows for a slow machine */
const SYNC = { timeout: 12_000 } as const;

function shotFields(source: ShotFields['source'], action: string): ShotFields {
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
    action,
    dialogue_quote: null,
    assumptions: [],
    questions: [],
    source,
  };
}

interface Account {
  group: { slug: string; join_code: string; members: { id: string; you: boolean }[] };
}

test('S4a: a teammate’s changes arrive without a reload, and typing survives their save', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ---- A (小林, director) starts the group
  await signUpHosted(page, app, 'lin@school.test', '小林', '雨夜组');
  await page.goto(app.base);
  await expect(page.getByRole('banner').getByText('雨夜组：小林')).toBeVisible();
  const account = await api<Account>(page, 'GET', '/api/v1/account');
  const me = account.group.members.find((m) => m.you)!;
  await api(page, 'PUT', `/api/v1/groups/${account.group.slug}/members/${me.id}/crew-roles`, { crew_roles: ['导演'] });

  // ---- B (小周) joins and opens the script page: nothing imported yet
  const other = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark', viewport: DESKTOP });
  await other.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
  const p2 = await other.newPage();
  p2.on('pageerror', (e) => pageErrors.push(e.message));
  await signUpHosted(p2, app, 'zhou@school.test', '小周');
  const joined = await p2.request.post(`${app.base}/api/v1/groups/join`, { data: { code: account.group.join_code }, headers: { origin: app.base } });
  expect(joined.ok()).toBe(true);
  await p2.goto(`${app.base}/#/script`);
  await expect(p2.getByRole('button', { name: /识别场次/ })).toBeVisible();
  // a marker that a reload would wipe: nothing below reloads B's page
  await p2.evaluate('window.__noReload = true');

  // ---- A opens the script page too, and shows up in B's title bar
  await page.goto(`${app.base}/#/script`);
  await expect(page.getByRole('button', { name: /识别场次/ })).toBeVisible();
  const strip = p2.getByRole('banner').getByRole('button', { name: /谁在线：.*小林/ });
  await expect(strip).toBeVisible(SYNC);
  await expect(strip.getByTitle('小林（导演）· 剧本页')).toBeVisible();

  // ---- A imports the script through the screen; B's page fills in by itself
  await page.locator('input[type="file"]').setInputFiles(BOOKSHOP);
  await page.getByRole('region', { name: '逐行预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '导入为新版本' }).click();
  await expect(page.getByRole('region', { name: /镜头表/ })).toBeVisible();
  await expect(p2.getByRole('region', { name: /镜头表/ })).toBeVisible(SYNC);
  await expect(p2.getByText(SCENE_1).first()).toBeVisible();
  await expect(p2.getByRole('banner').getByText('小林刚导入了剧本')).toBeVisible(SYNC);

  // ---- A makes a shot (B's table gets a row), then edits its action
  const scenes = await api<{ scenes: { id: string; paragraph_ids: string[] }[] }>(page, 'GET', '/api/v1/scripts/current');
  const scene = scenes.scenes[0]!;
  const source = { paragraph_id: scene.paragraph_ids[1]!, quote: '' };
  const made = await api<Shot>(page, 'POST', '/api/v1/shots', { scene_id: scene.id, fields: shotFields(source, '店主抬头看向门口'), manual_note: 'S4a 同步测试' });
  const rowB = p2.locator(`li[id="shot-${made.id}"]`);
  await expect(rowB).toBeVisible(SYNC);
  await expect(rowB).toContainText('店主抬头看向门口');

  const EDITED = '店主抬头，看向门口的来客';
  await api(page, 'PATCH', `/api/v1/shots/${made.id}`, { expected_revision: made.revision, fields: shotFields(source, EDITED), reason: '按勘景结果改' });
  await expect(rowB).toContainText(EDITED, SYNC);
  const activity = p2.getByRole('banner').getByText(`小林刚改了 第 1 场 ${made.code}`);
  await expect(activity).toBeVisible();
  await p2.screenshot({ path: test.info().outputPath('sync-activity-desktop.png') });
  await activity.waitFor({ state: 'hidden', timeout: 12_000 }); // the line stays about eight seconds

  // ---- the popover: who is on which page, and the last events
  await strip.click();
  const online = p2.getByRole('dialog', { name: '谁在线' });
  await expect(online.getByText('小林（导演）', { exact: true })).toBeVisible();
  await expect(online.getByText('剧本页').first()).toBeVisible();
  await expect(online.getByText('小周').first()).toBeVisible();
  await expect(online.locator('li').filter({ hasText: /小林（导演）导入了剧本/ })).toBeVisible();
  await expect(online.locator('li').filter({ hasText: new RegExp(`小林（导演）新建了 第 1 场 ${made.code}`) })).toBeVisible();
  await expect(online.locator('li').filter({ hasText: new RegExp(`小林（导演）改了 第 1 场 ${made.code} · \\d{2}:\\d{2}`) })).toBeVisible();
  await online.screenshot({ path: test.info().outputPath('presence-popover-desktop.png') });
  await online.getByRole('button', { name: '关闭' }).click();

  // ---- both open the same shot: B is told A is looking too (A reloads: its own API write did not refresh its table)
  await page.reload();
  await expect(page.getByRole('region', { name: /镜头表/ })).toBeVisible();
  await page.locator(`li[id="shot-${made.id}"]`).locator('[data-shot-summary]').click();
  await rowB.locator('[data-shot-summary]').click();
  const seeing = p2.getByText('小林也在看这个镜头');
  await expect(seeing).toBeVisible(SYNC);
  await p2.screenshot({ path: test.info().outputPath('sync-also-viewing-desktop.png') });

  // ---- a setup: B types a new name while A renames it
  const second = await api<Shot>(page, 'POST', '/api/v1/shots', { scene_id: scene.id, fields: shotFields(source, '门口的风铃响了'), manual_note: 'S4a 同步测试' });
  const setup = await api<Setup>(page, 'POST', '/api/v1/setups', {
    location_resource_id: null,
    label: '书店主厅',
    shot_ids: [second.id],
    resource_ids: [],
    durations: { setup_min: 30, per_shot_min: 15, reset_min: 10 },
    estimate_confirmed: false,
  });
  // (a setup that was just created answers without its revision; the list has it)
  const listed = (await api<Setup[]>(page, 'GET', '/api/v1/setups')).find((s) => s.id === setup.id)!;
  await p2.goto(`${app.base}/#/plan`);
  const list = p2.getByRole('list', { name: 'setup 列表' });
  await list.getByRole('button', { name: /书店主厅/ }).click();
  const name = p2.getByLabel('setup 名称');
  await expect(name).toHaveValue('书店主厅');

  await name.fill('二楼书架'); // typing, not saved: no blur yet
  let rev = listed.revision ?? 0;
  const renamed = await api<Setup>(page, 'PATCH', `/api/v1/setups/${setup.id}`, { expected_revision: rev, label: '书店大厅' });
  rev = renamed.revision ?? rev + 1;
  const conflict = p2.getByRole('status').filter({ hasText: '小林刚改了这一项' });
  await expect(conflict).toBeVisible(SYNC);
  await expect(name).toHaveValue('二楼书架'); // what B typed is still there
  await p2.screenshot({ path: test.info().outputPath('setup-conflict-desktop.png') });

  // the same place at 390px
  await p2.setViewportSize(PHONE);
  await conflict.scrollIntoViewIfNeeded();
  await p2.screenshot({ path: test.info().outputPath('setup-conflict-390.png') });
  expect.soft(await scrollWidth(p2)).toBeLessThanOrEqual(PHONE.width);
  // the title bar with the presence strip, the bell and the account menu fits (the project name gives way)
  const [barScroll, barWidth] = await p2.getByRole('banner').evaluate((el) => [el.scrollWidth, el.clientWidth] as [number, number]);
  expect(barScroll).toBeLessThanOrEqual(barWidth);
  await p2.screenshot({ path: test.info().outputPath('titlebar-390.png'), clip: { x: 0, y: 0, width: PHONE.width, height: 96 } });
  await p2.setViewportSize(DESKTOP);

  // 用他的: A's name replaces B's typing
  await conflict.getByRole('button', { name: '用他的' }).click();
  await expect(name).toHaveValue('书店大厅');
  await expect(conflict).toHaveCount(0);

  // 保留我的: B types again, A renames again, B keeps theirs and it is saved over A's
  await name.fill('走廊');
  const again = await api<Setup>(page, 'PATCH', `/api/v1/setups/${setup.id}`, { expected_revision: rev, label: '书店后门' });
  expect(again.revision).toBeGreaterThan(rev);
  await expect(p2.getByRole('status').filter({ hasText: '小林刚改了这一项' })).toBeVisible(SYNC);
  await expect(name).toHaveValue('走廊');
  await p2.getByRole('button', { name: '保留我的' }).click();
  await expect(p2.getByRole('status').filter({ hasText: '刚改了这一项' })).toHaveCount(0);
  await expect.poll(async () => (await api<Setup[]>(page, 'GET', '/api/v1/setups')).find((s) => s.id === setup.id)?.label).toBe('走廊');
  await expect(name).toHaveValue('走廊');

  // ---- A archives the shot B is editing: B's editor stays with B's text
  await p2.goto(`${app.base}/#/script`);
  await expect(p2.getByRole('region', { name: /镜头表/ })).toBeVisible();
  await p2.locator(`li[id="shot-${made.id}"]`).locator('[data-shot-summary]').click();
  const action = p2.getByLabel('动作', { exact: true });
  await expect(action).toHaveValue(EDITED);
  const TYPED = `${EDITED}，慢慢走了过来`;
  await action.fill(TYPED);
  await expect(p2.getByText('有未保存的修改')).toBeVisible();
  const latest = (await api<Shot[]>(page, 'GET', '/api/v1/shots')).find((s) => s.id === made.id)!;
  await api(page, 'POST', `/api/v1/shots/${made.id}/archive`, { expected_revision: latest.revision, reason: 'S4a 归档测试' });

  const gone = p2.getByRole('alert').filter({ hasText: '这个镜头刚被组员归档了；你的修改还没保存' });
  await expect(gone).toBeVisible(SYNC);
  await expect(p2.locator(`li[id="shot-${made.id}"]`)).toHaveCount(0); // it left the table…
  await expect(action).toHaveValue(TYPED); // …but not the editor
  await expect(p2.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await p2.screenshot({ path: test.info().outputPath('archived-while-editing-desktop.png') });

  await gone.getByRole('button', { name: '复制文字' }).click();
  await expect(gone.getByRole('button', { name: '已复制' })).toBeVisible();
  const clip = await p2.evaluate('navigator.clipboard.readText()');
  expect(clip).toContain(`动作：${TYPED}`);

  await gone.getByRole('button', { name: '放弃' }).click();
  await expect(gone).toHaveCount(0);

  // ---- nothing above reloaded B's page, and nothing broke
  expect(await p2.evaluate('window.__noReload')).toBe(true);
  await other.close();
  expect(pageErrors).toEqual([]);
});

/** Width of the page's content: more than the window means it scrolls sideways. */
async function scrollWidth(p: Page): Promise<number> {
  return Number(await p.evaluate('document.documentElement.scrollWidth'));
}

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ProjectExport, type BoardView, type HealthInfo } from '@storyscript/contracts';
import { generateMedia } from '../scripts/gen-media.ts';
import { api, BOOKSHOP, createProject, SCENE_1, signIn, startApp, type RunningApp } from './support.ts';

/**
 * The v0.1 gate (SPEC §7): the whole chain without any model key, all through
 * the UI of the production server.
 *
 *   new project → import 01-bookshop.txt → characters, a location and four
 *   shots by hand → boards laid out, one edited and saved as v2 → resources,
 *   automatic setups, estimates confirmed, plan computed and approved → two
 *   takes on set (one covering two shots) → lavfi footage (scripts/gen-media)
 *   added as a source folder, scanned, candidates built, one confirmed, two
 *   rejected, one usable decision → coverage and the missing list tell the
 *   four shots apart → the deliver page exports the project JSON and CSVs,
 *   checked for content.
 */

let app: RunningApp;
let footage: string;
let footageFiles: string[];

test.beforeAll(async () => {
  app = await startApp({ noKey: true });
  footage = join(app.tmp, 'CARD_A');
  await mkdir(footage, { recursive: true });
  const gen = await generateMedia(footage, { small: true, log: () => undefined });
  footageFiles = gen.files.filter((f) => f.encoder !== null).map((f) => f.file);
});

test.afterAll(async () => {
  await app?.stop();
});

const nav = (page: Page) => page.getByRole('navigation', { name: '工作流程' });

async function goStage(page: Page, name: string): Promise<void> {
  await nav(page).getByRole('link', { name: new RegExp(name) }).click();
  await page.getByRole('heading', { name, level: 1 }).waitFor();
}

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function download(page: Page, scope: Locator, button: string): Promise<{ name: string; text: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), scope.getByRole('button', { name: button }).click()]);
  return { name: dl.suggestedFilename(), text: await readFile(await dl.path(), 'utf8') };
}

/** RFC 4180 reader for the checks (quoted cells, CRLF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function records(text: string): Record<string, string>[] {
  const [head, ...body] = parseCsv(text);
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

interface ManualShot {
  size: string;
  angle: string;
  person: string;
  action: string;
  note: string;
}

const SHOTS: ManualShot[] = [
  { size: 'WS', angle: 'eye', person: 'c1', action: '午后的书店，光柱里灰尘浮动，老周在柜台后清理书脊', note: '交代空间' },
  { size: 'MS', angle: 'eye', person: 'c2', action: '林晓推门进来，肩上带着雨点', note: '人物登场' },
  { size: 'CU', angle: 'eye', person: 'c1', action: '老周拆开报纸，手停住', note: '情绪转折' },
  { size: 'MCU', angle: 'high', person: 'c2', action: '林晓看着柜台上的日记本', note: '补一个俯拍反应' },
];

test('no-key full chain: script → boards → plan → set → media → coverage → deliver', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  const health = await api<HealthInfo>(page, 'GET', '/api/v1/health');
  expect(health.text_provider_configured).toBe(false);
  expect(health.demo).toBe(false);
  await createProject(page, join(app.projectsDir, 'full-chain'), '全链路');

  // ------------------------------------------------------------ script
  await test.step('import the script, add characters, a location and four shots by hand', async () => {
    await page.goto(`${app.base}/#/script`);
    await page.getByRole('button', { name: /识别场次/ }).waitFor();
    await page.locator('input[type="file"]').setInputFiles(BOOKSHOP);
    await page.getByRole('region', { name: '逐行预览', exact: true }).waitFor();
    await page.getByRole('button', { name: '导入为新版本' }).click();
    await page.getByRole('region', { name: /镜头表/ }).waitFor();

    // no key: the AI entry points are greyed out, manual ones work
    await expect(page.getByRole('button', { name: 'AI 抽取角色、地点和道具' })).toBeDisabled();

    await page.getByRole('button', { name: '新增角色、地点或道具' }).click();
    for (const [type, name, aliases] of [
      ['character', '周明远', '老周'],
      ['character', '林晓', ''],
      ['location', '旧书店', ''],
    ] as const) {
      await page.getByLabel('类型', { exact: true }).selectOption(type);
      await page.getByLabel('名称', { exact: true }).fill(name);
      await page.getByLabel('别名', { exact: true }).fill(aliases);
      await page.getByRole('button', { name: '新增', exact: true }).click();
      await expect(page.getByLabel('名称', { exact: true })).toHaveValue('');
    }
    await page.getByRole('button', { name: '完成', exact: true }).click();

    // scene 1 takes place in the bookshop (setups group by location)
    const scene1 = page.getByRole('region', { name: SCENE_1, exact: true });
    await scene1.getByRole('button', { name: '第 1 场设置' }).click();
    const where = page.getByRole('region', { name: '站位与地点' }).getByLabel('地点', { exact: true });
    await where.selectOption({ label: 'l1 旧书店' });
    await expect(where).toBeEnabled();
    await expect(where).toHaveValue(/.+/);

    for (const [i, s] of SHOTS.entries()) {
      await scene1.getByRole('button', { name: '在第 1 场新建手工镜头' }).click();
      const form = page.locator('form').filter({ has: page.getByRole('button', { name: '新建镜头' }) });
      await form.getByRole('combobox', { name: '景别', exact: true }).selectOption(s.size);
      await form.getByRole('combobox', { name: '角度', exact: true }).selectOption(s.angle);
      await form.getByRole('button', { name: '添加人物' }).click();
      await form.getByRole('combobox', { name: '人物 1', exact: true }).selectOption(s.person);
      await form.getByRole('textbox', { name: '动作', exact: true }).fill(s.action);
      await form.getByLabel('为什么加这个镜头（必填）').fill(s.note);
      await form.getByRole('button', { name: '新建镜头' }).click();
      await expect(scene1.locator('li[id^="shot-"]')).toHaveCount(i + 1);
    }
    const shots = await api<{ code: string; origin: string }[]>(page, 'GET', '/api/v1/shots');
    expect(shots.map((s) => [s.code, s.origin])).toEqual([
      ['001', 'manual'],
      ['002', 'manual'],
      ['003', 'manual'],
      ['004', 'manual'],
    ]);
  });

  // ------------------------------------------------------------ boards
  await test.step('boards: laid out for the manual shots; move a person and save v2', async () => {
    await goStage(page, '分镜');
    const cards = page.locator('button[data-shot]');
    await expect(cards).toHaveCount(4);
    await expect(cards.first().locator('img')).toBeVisible();
    await cards.nth(1).click();
    const sheet = page.getByRole('region', { name: '镜 002 分镜稿' });
    await expect(sheet).toBeVisible();
    const person = sheet.locator('[data-handle="foot"]').first();
    await expect(person).toBeVisible();
    const c = await center(person);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(c.x + (80 * i) / 6, c.y);
    await page.mouse.up();
    await expect(page.getByText('有未保存的修改')).toBeVisible();
    await page.getByRole('button', { name: '保存为新版本' }).click();
    await expect(page.getByText('v2 · 手动调整').first()).toBeVisible();
    const boards = await api<BoardView[]>(page, 'GET', '/api/v1/boards');
    expect(boards.map((b) => [b.shot_code, b.version, b.user_edited])).toEqual([
      ['001', 1, false],
      ['002', 2, true],
      ['003', 1, false],
      ['004', 1, false],
    ]);
  });

  // ------------------------------------------------------------ plan
  await test.step('plan: resources, automatic setups, confirm estimates, compute and approve', async () => {
    await goStage(page, '计划');
    const resources = [
      { type: '演员', name: '演员甲', cast: '周明远' },
      { type: '演员', name: '演员乙', cast: '林晓' },
      { type: '场地', name: '旧书店实景', cast: '旧书店' },
    ];
    for (const r of resources) {
      await page.getByRole('button', { name: '新增资源' }).first().click();
      const dialog = page.getByRole('dialog', { name: '新增资源' });
      await dialog.getByText(r.type, { exact: true }).click();
      await dialog.getByLabel('名称', { exact: true }).fill(r.name);
      await dialog.getByRole('checkbox', { name: new RegExp(r.cast) }).check();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    await expect(page.getByText('个角色还没有演员')).toHaveCount(0);

    await page.getByRole('button', { name: '自动分组' }).first().click();
    const derive = page.getByRole('dialog', { name: '自动分组' });
    await derive.getByRole('button', { name: '开始分组' }).click();
    await derive.waitFor({ state: 'detached' });
    const setups = page.getByRole('list', { name: 'setup 列表' }).locator('li');
    await expect(setups).toHaveCount(2); // eye-level and high angle in the bookshop
    for (let i = 0; i < 2; i++) {
      await setups.nth(i).getByRole('button').first().click();
      const confirm = page.getByRole('region', { name: 'Setup', exact: true }).getByRole('checkbox', { name: '已确认', exact: true });
      // controlled by the saved setup: it ticks once the PATCH lands
      await confirm.click();
      await expect(confirm).toBeChecked();
      await expect(setups.nth(i)).not.toContainText('估算');
    }

    await page.getByRole('button', { name: '新建计划' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新建拍摄日计划' });
    await dialog.getByRole('button', { name: '计算计划' }).click();
    await dialog.waitFor({ state: 'detached' });
    const status = page.getByRole('region', { name: '计划状态' });
    await expect(status).toContainText('草案');
    await status.getByRole('button', { name: '批准计划' }).click();
    await expect(status).toContainText('已批准');
    await expect(status.getByRole('button', { name: '批准计划' })).toHaveCount(0);
  });

  // ------------------------------------------------------------ set
  await test.step('set: two takes, the first covers 1-001 and 1-002', async () => {
    await goStage(page, '现场');
    await expect(page.getByText(/按已批准计划/).first()).toBeVisible();
    const order = page.locator('button[data-shot]');
    await expect(order).toHaveCount(4);

    await order.filter({ hasText: '1-001' }).click();
    await page.getByRole('checkbox', { name: '1-002 并入本条' }).check();
    const form = page.getByRole('form', { name: '新增条次' });
    await expect(form).toContainText('一条覆盖 2 个镜头');
    await form.locator('[data-rating="good"]').click();
    await form.getByLabel('机内文件名').fill('A001C003');
    await form.getByRole('button', { name: /保存条次/ }).click();
    await expect(form.getByRole('status')).toHaveText('已记录 T01');

    await order.filter({ hasText: '1-003' }).click();
    await form.getByLabel('条次号').fill('2');
    await form.getByLabel('机内文件名').fill('');
    await form.getByLabel('备注').fill('第二条焦点更准');
    await form.getByRole('button', { name: /保存条次/ }).click();
    await expect(form.getByRole('status')).toHaveText('已记录 T02');

    const takes = await api<{ take_no: number; shot_ids: string[]; clip_hint: string | null; rating: string }[]>(page, 'GET', '/api/v1/takes');
    expect(takes.map((t) => [t.take_no, t.shot_ids.length, t.clip_hint, t.rating])).toEqual([
      [1, 2, 'A001C003', 'good'],
      [2, 1, null, 'unrated'],
    ]);
  });

  // ------------------------------------------------------------ media
  await test.step('media: add the footage folder, scan, build candidates, confirm, reject, decide usable', async () => {
    await goStage(page, '素材');
    const addForm = page.getByRole('form', { name: '添加外部素材目录' });
    if (!(await addForm.isVisible())) await page.getByRole('button', { name: '添加外部素材目录' }).click();
    await addForm.getByLabel('素材文件夹').fill(footage);
    await addForm.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.getByText('CARD_A', { exact: true })).toBeVisible();
    // the project folder is a root of its own (empty here): scan the card just added
    await page.getByRole('listitem').filter({ hasText: 'CARD_A' }).getByRole('button', { name: '扫描', exact: true }).click();
    await expect(page.locator('button[data-asset]')).toHaveCount(footageFiles.length, { timeout: 60_000 });
    await expect(page.locator('button[data-asset] img').first()).toBeVisible({ timeout: 30_000 });

    // candidates by R1 (slate code in the name) and R2 (clip name of the take)
    await page.getByRole('button', { name: /^候选审核/ }).click();
    const drawer = page.getByRole('dialog', { name: /候选审核/ });
    await drawer.getByRole('form', { name: '生成候选' }).getByRole('button', { name: '生成候选' }).click();
    await expect(drawer.getByRole('status')).toContainText('新增');
    const g1 = drawer.getByRole('region', { name: '1-001', exact: true });
    const g2 = drawer.getByRole('region', { name: '1-002', exact: true });
    const g3 = drawer.getByRole('region', { name: '1-003', exact: true });
    await expect(g1.locator('li')).toHaveCount(2); // S01-001-T01 (R1) + A001C003 (R2)
    await expect(g2.locator('li')).toHaveCount(2); // S01-002-T01 (R1) + A001C003 (R2)
    await expect(g3.locator('li')).toHaveCount(1); // S01-003-T02 (R1)
    await expect(drawer.getByRole('region', { name: '1-004', exact: true })).toHaveCount(0);

    await g1.locator('li').filter({ hasText: 'S01-001-T01.mp4' }).getByRole('button', { name: '确认' }).click();
    await expect(g1.locator('li')).toHaveCount(1);
    for (let n = 2; n > 0; n--) {
      await g2.locator('li').first().getByRole('button', { name: '拒绝' }).click();
      await expect(g2.locator('li')).toHaveCount(n - 1);
    }
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });

    const coverage = page.getByRole('table', { name: '按场的覆盖状态' });
    await coverage.getByRole('button', { name: '1-001 覆盖决定' }).click();
    const decide = page.getByRole('form', { name: '1-001 覆盖决定' });
    await decide.getByRole('checkbox', { name: /S01-001-T01\.mp4/ }).check();
    await decide.getByLabel('原因（必填）').fill('焦点准，表演完整');
    await decide.getByRole('button', { name: '记录决定' }).click();
    await decide.waitFor({ state: 'detached' });
  });

  // ------------------------------------------------------------ coverage
  await test.step('coverage and the missing list tell the four shots apart', async () => {
    const coverage = page.getByRole('table', { name: '按场的覆盖状态' });
    const row = (label: string) => coverage.locator('tr').filter({ has: page.getByRole('button', { name: `${label} 覆盖决定` }) });
    await expect(row('1-001')).toContainText('可用');
    await expect(row('1-002')).toContainText('已拍待定');
    await expect(row('1-003')).toContainText('已拍待定');
    await expect(row('1-004')).toContainText('未拍');
    await expect(page.getByText('覆盖与漏拍 · 漏拍 3')).toBeVisible();
    await expect(page.getByRole('region', { name: '无场记' })).toContainText('1-004');
    await expect(page.getByRole('region', { name: '无关联素材' })).toContainText('1-002');
    await expect(page.getByRole('region', { name: '无已确认的可用片段' })).toContainText('1-003');
    await expect(page.getByRole('region', { name: '原片离线' })).toHaveCount(0);
  });

  // ------------------------------------------------------------ deliver
  await test.step('deliver: project JSON and CSVs, checked for content', async () => {
    await goStage(page, '交付');
    const list = page.getByRole('region', { name: '交付清单' });
    await expect(page.locator('[data-deliver-item]')).toHaveCount(10);
    await expect(page.locator('[data-deliver-item="callsheet"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('[data-deliver-item="boards"]')).toHaveAttribute('data-state', 'draft'); // shots not locked

    const json = await download(page, list, '下载项目 JSON');
    expect(json.name).toMatch(/^全链路-项目-\d{4}-\d{2}-\d{2}\.json$/);
    const data = ProjectExport.parse(JSON.parse(json.text));
    expect(data.project.name).toBe('全链路');
    expect(data.entities).toHaveLength(3);
    expect(data.shots).toHaveLength(4);
    expect((data.boards as { version: number }[]).some((b) => b.version === 2)).toBe(true);
    expect(data.resources).toHaveLength(3);
    expect(data.setups).toHaveLength(2);
    expect((data.plans as { status: string }[]).map((p) => p.status)).toEqual(['approved']);
    expect((data.takes as { shot_ids: string[] }[]).map((t) => t.shot_ids.length).sort()).toEqual([1, 2]);
    // the project folder's own root (named after the folder), then the card
    expect(data.source_roots.map((r) => r.label)).toEqual(['full-chain', 'CARD_A']);
    expect(data.media_assets).toHaveLength(footageFiles.length);
    expect((data.shot_media_links as { status: string }[]).map((l) => l.status).sort()).toEqual(['candidate', 'candidate', 'confirmed', 'rejected', 'rejected']);
    expect((data.coverage_decisions as { decision: string }[]).map((d) => d.decision)).toEqual(['usable']);
    expect(json.text).toContain('老周拆开报纸，手停住'); // Chinese intact
    expect(json.text).not.toContain(footage); // no absolute source path
    expect(json.text).not.toContain(app.tmp);

    const cov = records((await download(page, list, '下载覆盖状态 CSV')).text);
    expect(cov.map((r) => [r['镜'], r['覆盖状态'], r['漏拍原因']])).toEqual([
      ['001', '可用', ''],
      ['002', '已拍待定', '无关联素材'],
      ['003', '已拍待定', '无已确认的可用片段'],
      ['004', '未拍', '无场记'],
    ]);

    const tm = records((await download(page, list, '下载场记与素材 CSV')).text);
    const usable = tm.find((r) => r['文件'] === 'S01-001-T01.mp4' && r['关联状态'] === '已确认');
    expect(usable).toBeDefined();
    expect(usable!['条次']).toBe('1');
    expect(usable!['机内文件名']).toBe('A001C003');
    for (const k of ['stream_index', 'in_pts', 'out_pts', 'time_base_num', 'time_base_den']) expect(usable![k]).toMatch(/^\d+$/);
    expect(Number(usable!['out_pts'])).toBeGreaterThan(Number(usable!['in_pts']));
    expect(tm.some((r) => r['文件'] === 'S01-002-T01.mov')).toBe(false); // rejected links are not exported

    const shotsCsv = records((await download(page, list, '下载镜头表 CSV')).text);
    expect(shotsCsv.map((r) => [r['镜'], r['来源']])).toEqual([
      ['001', '手工'],
      ['002', '手工'],
      ['003', '手工'],
      ['004', '手工'],
    ]);

    const call = records((await download(page, list, '下载拍摄单 CSV')).text);
    expect(call.filter((r) => r['镜头'] !== '').length).toBeGreaterThanOrEqual(2);
  });

  // reload: everything was persisted
  await page.reload();
  await page.getByRole('heading', { name: '交付', level: 1 }).waitFor();
  await expect(page.locator('[data-deliver-item="callsheet"]')).toHaveAttribute('data-state', 'ready');
  expect(pageErrors).toEqual([]);
});

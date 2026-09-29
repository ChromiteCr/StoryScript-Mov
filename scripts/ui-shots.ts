/**
 * UI review screenshots (S0a). Builds the web app, starts the production
 * server under a throwaway STORYSCRIPT_HOME, walks the workbench in the
 * installed Chrome (no browser download) and writes PNGs to .look/ui/.
 *
 *   npx tsx scripts/ui-shots.ts [--no-build] [--demo] [--out .look/ui]
 *
 * Pages: home (empty, new-project drawer, with a recent project), each of the
 * six workflow stages, settings (three categories), the jobs popover and a
 * print-media render of the boards page — at 1440x900 and at 390x844.
 * With --demo (the server replays fixtures/replay, nothing leaves the
 * machine) the script page is also walked end to end: import
 * fixtures/scripts/01-bookshop.txt → extract entities → AI breakdown of
 * scene 1 → draft diff → apply → lock a shot → edit a shot (desktop), and on
 * the phone the tabs, the shot drawer and a breakdown of scene 2.
 * The server and the temp directory are removed on exit, also on failure.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');

const STAGES = ['script', 'boards', 'plan', 'set', 'media', 'deliver'] as const;

interface Size {
  name: string;
  width: number;
  height: number;
}

const DESKTOP: Size = { name: '1440', width: 1440, height: 900 };
const PHONE: Size = { name: '390', width: 390, height: 844 };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => ok(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** runtime.json appears once the server listens; its port must be ours (not a stale file). */
async function waitForRuntime(home: string, port: number, server: ChildProcess): Promise<string> {
  const file = join(home, 'runtime.json');
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null) throw new Error(`server exited early with code ${server.exitCode}`);
    try {
      const rt = JSON.parse(await readFile(file, 'utf8')) as { port?: number; token?: string };
      if (rt.port === port && typeof rt.token === 'string' && rt.token.length > 0) return rt.token;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error('server did not write runtime.json within 30s');
}

/** Signal the whole process group: npx → tsx → node all go down together. */
function signalGroup(server: ChildProcess, signal: NodeJS.Signals): void {
  if (server.pid === undefined) return;
  try {
    process.kill(-server.pid, signal);
  } catch {
    server.kill(signal);
  }
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((r) => server.once('exit', () => r()));
  signalGroup(server, 'SIGINT');
  const timeout = sleep(5000).then(() => 'timeout' as const);
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    signalGroup(server, 'SIGKILL');
    await exited;
  }
}

/** Let the 120ms page fade and any font/layout settle before the capture. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(250);
}

async function shot(page: Page, out: string, size: Size, name: string, list: string[]): Promise<void> {
  await settle(page);
  const path = join(out, `${size.name}-${name}.png`);
  await page.screenshot({ path });
  list.push(path);
  // Overflow check: the page itself must never scroll sideways.
  const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  if (overflow > 0) console.warn(`  ! ${size.name}-${name}: page scrolls sideways by ${overflow}px`);
  console.log(`  ${path}`);
}

async function go(page: Page, base: string, hash: string): Promise<void> {
  await page.goto(`${base}/${hash}`);
}

async function createProject(page: Page, dir: string, name: string): Promise<void> {
  await page.getByRole('button', { name: /新建项目/ }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建项目' });
  await dialog.getByLabel('项目文件夹').fill(dir);
  // Focusing the name field pre-fills the folder name; let that land before typing over it.
  const nameField = dialog.getByLabel('项目名');
  await nameField.focus();
  await page.waitForTimeout(50);
  await nameField.fill(name);
  await dialog.getByLabel('目标时长（秒）').fill('600');
  await dialog.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /剧本/ }).waitFor();
}

const BOOKSHOP = join(ROOT, 'fixtures', 'scripts', '01-bookshop.txt');
const SCENE_1 = '内景 旧书店 日';
const SCENE_2 = '内景 旧书店后屋 日';

/** Wait for a tracked AI job to end in its draft dialog. */
async function waitForDraftDialog(page: Page, name: RegExp) {
  const dialog = page.getByRole('dialog', { name });
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByRole('button', { name: /应用所选/ }).waitFor();
  return dialog;
}

/** Desktop: the whole script workflow against the demo replay. */
async function scriptFlowDesktop(page: Page, base: string, out: string, size: Size, list: string[]): Promise<void> {
  await go(page, base, '#/script');
  await page.getByRole('button', { name: /识别场次/ }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(BOOKSHOP);
  await page.getByRole('region', { name: /^场次 2/ }).waitFor();
  await page.getByRole('region', { name: '逐行预览', exact: true }).waitFor();
  await shot(page, out, size, '60-script-import-preview', list);

  await page.getByRole('button', { name: '导入为新版本' }).click();
  await page.getByRole('region', { name: /镜头表/ }).waitFor();
  await shot(page, out, size, '61-script-workspace', list);

  // Entities: AI extraction (replayed) → entity draft → apply.
  await page.getByRole('button', { name: 'AI 抽取角色、地点和道具' }).click();
  const entities = page.getByRole('dialog', { name: '实体草案' });
  await entities.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });
  await shot(page, out, size, '62-entity-draft', list);
  await entities.getByRole('button', { name: /应用所选/ }).click();
  await entities.waitFor({ state: 'detached' });

  // Scene 1: AI breakdown from the inspector → draft diff → apply.
  const scene1 = page.getByRole('region', { name: SCENE_1, exact: true });
  await scene1.getByRole('button', { name: 'AI 拆镜' }).click();
  await page.getByRole('button', { name: '开始拆镜' }).waitFor();
  await shot(page, out, size, '63-scene-inspector', list);
  await page.getByRole('button', { name: '开始拆镜' }).click();
  const draft = await waitForDraftDialog(page, /AI 拆镜草案 · 第 1 场/);
  await shot(page, out, size, '64-draft-diff', list);
  await draft.getByRole('button', { name: /应用所选/ }).click();
  await draft.waitFor({ state: 'detached' });
  await scene1.locator('li[id^="shot-"]').first().waitFor();
  await shot(page, out, size, '65-shot-table', list);

  // Lock the first shot, then edit the second one in the inspector.
  const rows = scene1.locator('li[id^="shot-"]');
  await rows.first().getByRole('button', { name: /^锁定 / }).click();
  await rows.first().getByRole('button', { name: /^解锁 / }).waitFor();
  await rows.nth(1).locator('[data-shot-summary]').click();
  const inspector = page.getByRole('region', { name: /^镜头 / });
  await inspector.getByLabel('景别').waitFor();
  await shot(page, out, size, '66-shot-editor', list);
  await inspector.getByLabel('景别').selectOption('CU');
  await inspector.getByLabel('说明（可选）').fill('按勘景改为近景');
  await inspector.getByRole('button', { name: '保存', exact: true }).click();
  await inspector.getByText(/已保存/).waitFor();
  await shot(page, out, size, '67-shot-saved', list);

  // Locked shot selected: read-only inspector.
  await rows.first().locator('[data-shot-summary]').click();
  await page.getByRole('region', { name: /^镜头 / }).getByText('镜头已锁定').waitFor();
  await shot(page, out, size, '68-shot-locked', list);
}

/** Phone: tabs, the shot drawer and a breakdown of scene 2 (the project already holds the script). */
async function scriptFlowPhone(page: Page, base: string, out: string, size: Size, list: string[]): Promise<void> {
  await go(page, base, '#/script');
  await page.getByRole('tab', { name: '镜头表' }).waitFor();
  await shot(page, out, size, '60-script-shots', list);
  await page.getByRole('tab', { name: '剧本原文' }).click();
  await shot(page, out, size, '61-script-text', list);
  await page.getByRole('tab', { name: '角色、地点与道具' }).click();
  await shot(page, out, size, '62-script-roster', list);

  await page.getByRole('tab', { name: '镜头表' }).click();
  await page.locator('li[id^="shot-"]').nth(1).locator('[data-shot-summary]').click();
  const drawer = page.getByRole('dialog', { name: /^镜头 / });
  await drawer.getByLabel('景别').waitFor();
  await shot(page, out, size, '63-shot-drawer', list);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });

  const scene2 = page.getByRole('region', { name: SCENE_2, exact: true });
  await scene2.getByRole('button', { name: 'AI 拆镜' }).click();
  await page.getByRole('button', { name: '开始拆镜' }).waitFor();
  await shot(page, out, size, '64-scene-drawer', list);
  await page.getByRole('button', { name: '开始拆镜' }).click();
  const draft = await waitForDraftDialog(page, /AI 拆镜草案 · 第 2 场/);
  await shot(page, out, size, '65-draft-diff', list);
  await draft.getByRole('button', { name: /应用所选/ }).click();
  await draft.waitFor({ state: 'detached' });
  await shot(page, out, size, '66-shot-table', list);
}

async function capture(
  browser: Browser,
  opts: { base: string; token: string; out: string; size: Size; projectsDir: string; first: boolean; demo: boolean },
) {
  const { base, token, out, size, projectsDir, first, demo } = opts;
  const shots: string[] = [];
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size === PHONE ? 2 : 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  page.on('console', (msg) => {
    // API errors (409 no project open, 404 jobs route not built yet) are handled by the UI.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.warn(`  ! console: ${msg.text()}`);
  });

  // Session bootstrap: the token hash is exchanged for a cookie, then removed from the URL.
  await page.goto(`${base}/#t=${token}`);
  await page.getByRole('heading', { name: '项目', level: 1 }).waitFor();

  if (first) {
    await shot(page, out, size, '01-home-empty', shots);
    await page.getByRole('button', { name: /新建项目/ }).first().click();
    await page.getByRole('dialog', { name: '新建项目' }).waitFor();
    await shot(page, out, size, '02-home-new-project', shots);
    await page.keyboard.press('Escape');
    await createProject(page, join(projectsDir, '周末短片'), '周末短片');
  } else {
    await shot(page, out, size, '01-home', shots);
    await page.getByRole('button', { name: /新建项目/ }).first().click();
    await page.getByRole('dialog', { name: '新建项目' }).waitFor();
    await shot(page, out, size, '02-home-new-project', shots);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /周末短片/ }).click();
    await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /剧本/ }).waitFor();
  }

  for (const [i, stage] of STAGES.entries()) {
    await go(page, base, `#/${stage}`);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await shot(page, out, size, `${String(i + 10)}-${stage}`, shots);
  }

  if (demo) {
    if (size === DESKTOP) await scriptFlowDesktop(page, base, out, size, shots);
    else await scriptFlowPhone(page, base, out, size, shots);
  }

  // Keyboard: focus the current stage and move right once; the focus ring must show.
  await go(page, base, '#/boards');
  await page.locator('a[data-stage="boards"]').focus();
  await page.keyboard.press('ArrowRight');
  await shot(page, out, size, '20-pagebar-focus', shots);

  await page.getByRole('button', { name: /后台任务/ }).click();
  await shot(page, out, size, '21-jobs-open', shots);
  await page.keyboard.press('Escape');
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  await page.mouse.move(1, 1); // no hover left on the jobs button

  await go(page, base, '#/settings');
  await page.getByRole('tab', { name: /常规/ }).waitFor();
  await shot(page, out, size, '30-settings-general', shots);
  await page.getByRole('tab', { name: /环境检查/ }).click();
  await shot(page, out, size, '31-settings-environment', shots);
  await page.getByRole('tab', { name: /模型/ }).click();
  await shot(page, out, size, '32-settings-models', shots);

  if (size === DESKTOP) {
    await go(page, base, '#/boards');
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const path = join(out, `${size.name}-40-boards-print.png`);
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    console.log(`  ${path}`);
    await page.emulateMedia({ media: 'screen' });
  }

  // Back to the project manager with one recent project.
  await go(page, base, '#/script');
  await page.getByRole('button', { name: /切换项目/ }).click();
  await page.getByRole('heading', { name: '项目', level: 1 }).waitFor();
  await shot(page, out, size, '50-home-recent', shots);

  await context.close();
  return shots;
}

// ---------------------------------------------------------------------------
// M5 plan page flow (--flow plan → .look/ui-plan/): seeds a script, shots and
// resources through the API from inside the page (same-origin fetch, so the
// session cookie and Origin check apply), then walks resources → derive →
// new plan → inspector → stale → approve → invalidated → exports.
// ---------------------------------------------------------------------------

const PLAN_TZ = 'Asia/Shanghai';
const PLAN_DAY = '2026-10-05';

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p, {
        method: m,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: b === null ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${m} ${p} → ${res.status} ${text}`);
      return (text ? (JSON.parse(text) as { data: unknown }).data : undefined) as never;
    },
    [method, path, body ?? null] as const,
  );
}

function shotFields(paragraphId: string, o: { size: string; angle: string; action: string; subjects?: [string, string | null][] }) {
  return {
    template: null,
    shot_size: o.size,
    angle: o.angle,
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: (o.subjects ?? []).map(([alias, facing]) => ({ alias, screen: null, depth: null, facing, pose: null })),
    props: [],
    env: 'interior',
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 5,
    narrative_purpose: '界面截图样例',
    action: o.action,
    dialogue_quote: null,
    source: { paragraph_id: paragraphId, quote: '' },
    assumptions: [],
    questions: [],
  };
}

interface Seeded {
  performerA: string;
}

async function seedPlanProject(page: Page): Promise<Seeded> {
  const { localWindowToUtc } = await import('@storyscript/core');
  const W = (a: string, b: string) => localWindowToUtc(PLAN_DAY, a, b, PLAN_TZ);
  const text = await readFile(join(ROOT, 'fixtures', 'scripts', '01-bookshop.txt'), 'utf8');
  const imported = await api<{ scenes: { id: string; paragraph_ids: string[] }[] }>(page, 'POST', '/api/v1/scripts', {
    text,
    source_name: '01-bookshop.txt',
    format: 'txt',
    heading_overrides: [],
  });
  const [s1, s2] = imported.scenes as [{ id: string; paragraph_ids: string[] }, { id: string; paragraph_ids: string[] }];
  const c1 = await api<{ id: string; alias: string }>(page, 'POST', '/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] });
  const c2 = await api<{ id: string; alias: string }>(page, 'POST', '/api/v1/entities', { type: 'character', name: '林晓', aliases: [] });
  const shop = await api<{ id: string }>(page, 'POST', '/api/v1/entities', { type: 'location', name: '旧书店', aliases: [] });
  const back = await api<{ id: string }>(page, 'POST', '/api/v1/entities', { type: 'location', name: '旧书店后屋', aliases: [] });
  await api(page, 'PATCH', `/api/v1/scenes/${s1.id}`, { location_entity_id: shop.id });
  await api(page, 'PATCH', `/api/v1/scenes/${s2.id}`, { location_entity_id: back.id });
  const shots: [typeof s1, Parameters<typeof shotFields>[1]][] = [
    [s1, { size: 'WS', angle: 'eye', action: '午后光柱斜照进书架之间，灰尘浮动' }],
    [s1, { size: 'MS', angle: 'eye', action: '老周坐在柜台后清理书脊', subjects: [[c1.alias, 'camera']] }],
    [s1, { size: 'MCU', angle: 'eye', action: '林晓推门进来，肩上还有雨点', subjects: [[c2.alias, 'screen_left']] }],
    [s1, { size: 'CU', angle: 'eye', action: '老周的手停在日记本封面上', subjects: [[c1.alias, 'screen_right']] }],
    [s1, { size: 'MS', angle: 'high', action: '越过老周肩头看林晓', subjects: [[c2.alias, '3q_left'], [c1.alias, 'away']] }],
    [s2, { size: 'MS', angle: 'low', action: '两人在后屋翻看旧照片', subjects: [[c1.alias, 'camera'], [c2.alias, 'screen_right']] }],
    [s2, { size: 'INSERT', angle: 'overhead', action: '日记本扉页上的签名' }],
  ];
  for (const [scene, o] of shots) {
    await api(page, 'POST', '/api/v1/shots', { scene_id: scene.id, fields: shotFields(scene.paragraph_ids[0]!, o), manual_note: '界面截图样例' });
  }
  const performerA = await api<{ id: string }>(page, 'POST', '/api/v1/resources', {
    type: 'performer',
    name: '陈远山',
    windows: [W('08:00', '14:00')],
    cast_character_ids: [c1.id],
    confirmed: true,
  });
  await api(page, 'POST', '/api/v1/resources', { type: 'performer', name: '许一禾', windows: [W('11:00', '19:00')], cast_character_ids: [c2.id], confirmed: true });
  await api(page, 'POST', '/api/v1/resources', { type: 'location', name: '书店实景', windows: [W('07:00', '21:00')], cast_character_ids: [shop.id], confirmed: true });
  await api(page, 'POST', '/api/v1/resources', { type: 'location', name: '后屋实景', windows: [W('07:00', '21:00')], cast_character_ids: [back.id], confirmed: true });
  await api(page, 'POST', '/api/v1/resources', { type: 'equipment', name: '小摇臂', windows: [W('10:00', '16:00')], cast_character_ids: [], confirmed: false });
  return { performerA: performerA.id };
}

/**
 * Local stand-in for an OpenAI-compatible text model (plan flow only): it
 * answers chat completions with the setup keys of the prompt in reverse and a
 * fixed rationale. Nothing leaves the machine; the key is a dummy.
 */
async function startFakeTextModel(): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
  const { createServer: createHttpServer } = await import('node:http');
  const srv = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"not found"}}');
        return;
      }
      const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const keys = [...user.matchAll(/^- (u\d+)｜/gm)].map((m) => m[1]!);
      const content = JSON.stringify({
        setup_order: [...keys].reverse(),
        rationale: '先拍后屋的两个 setup，趁两位演员都在场时完成双人镜头；书店内的机位随后按角度相邻安排，减少重新布光和转场。',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake',
          object: 'chat.completion',
          created: 0,
          model: 'fake-order',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    env: {
      STORYSCRIPT_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      STORYSCRIPT_LLM_API_KEY: 'sk-ui-shots-dummy-key',
      STORYSCRIPT_LLM_MODEL: 'fake-order',
    },
    close: () => new Promise<void>((ok) => srv.close(() => ok())),
  };
}

async function planDetail(page: Page): Promise<{ id: string; revision: number }> {
  const plans = await api<{ id: string; revision: number }[]>(page, 'GET', '/api/v1/plans');
  return plans[0]!;
}

async function capturePlan(browser: Browser, opts: { base: string; token: string; out: string; size: Size; projectsDir: string; first: boolean; demo?: boolean }) {
  const { base, token, out, size, projectsDir, first } = opts;
  const shots: string[] = [];
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size === PHONE ? 2 : 1,
    locale: 'zh-CN',
    timezoneId: PLAN_TZ,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.warn(`  ! console: ${msg.text()}`);
  });
  await page.goto(`${base}/#t=${token}`);
  // the desktop walk leaves the project open, so the phone walk lands in the workbench
  if (first) await page.getByRole('heading', { name: '项目', level: 1 }).waitFor();
  else await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /剧本/ }).waitFor();
  const planHeading = () => page.getByRole('heading', { name: '计划', level: 1 }).waitFor();

  if (first) {
    await createProject(page, join(projectsDir, '旧书'), '旧书');
    const { localWindowToUtc } = await import('@storyscript/core');
    const seeded = await seedPlanProject(page);
    // resources exist, no setups or plans yet
    await go(page, base, '#/plan');
    await planHeading();
    await shot(page, out, size, '60-plan-no-setups', shots);

    await page.getByRole('button', { name: '陈远山' }).click();
    await page.getByRole('dialog', { name: /编辑资源/ }).waitFor();
    await shot(page, out, size, '61-resource-dialog', shots);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '自动分组' }).first().click();
    await page.getByRole('dialog', { name: '自动分组' }).waitFor();
    await shot(page, out, size, '62-derive-dialog', shots);
    await page.getByRole('button', { name: '开始分组' }).click();
    await page.getByRole('dialog', { name: '自动分组' }).waitFor({ state: 'detached' });

    await page.getByRole('button', { name: '新建计划' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新建拍摄日计划' });
    await dialog.getByLabel('拍摄日期').fill(PLAN_DAY);
    await shot(page, out, size, '63-new-plan-dialog', shots);
    await dialog.getByRole('button', { name: '计算计划' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('region', { name: '拍摄单' }).waitFor();
    await shot(page, out, size, '64-plan-estimates', shots);

    // select the first setup → inspector
    await page.getByRole('list', { name: 'setup 列表' }).getByRole('button').first().click();
    await shot(page, out, size, '65-setup-inspector', shots);

    // confirm every estimate (API) → stale banner
    const setups = await api<{ id: string }[]>(page, 'GET', '/api/v1/setups');
    for (const s of setups) await api(page, 'PATCH', `/api/v1/setups/${s.id}`, { estimate_confirmed: true });
    await page.reload();
    await page.getByRole('region', { name: '拍摄单' }).waitFor();
    await shot(page, out, size, '66-plan-stale', shots);

    await page.getByRole('button', { name: '重新计算' }).first().click();
    await page.getByText('校验通过').or(page.getByRole('heading', { name: /批准前需要解决/ })).first().waitFor();
    await shot(page, out, size, '67-plan-recomputed', shots);

    // manual order: one move in the UI, then the grouped order (location by location) via the API
    const rows = page.getByRole('list', { name: 'setup 列表' });
    await rows.getByRole('button', { name: /^上移/ }).last().click();
    await page.getByText(/修订 r2/).waitFor();
    const current = await planDetail(page);
    await api(page, 'POST', `/api/v1/plans/${current.id}/reorder`, { expected_revision: current.revision, order: setups.map((s) => s.id) });
    await page.reload();
    await page.getByRole('region', { name: '拍摄单' }).waitFor();
    await shot(page, out, size, '67b-plan-reordered', shots);

    const approve = page.getByRole('button', { name: '批准计划' });
    if (await approve.isEnabled()) {
      await approve.click();
      await page.getByText('已批准', { exact: true }).first().waitFor();
      await shot(page, out, size, '68-plan-approved', shots);
    } else {
      console.warn('  ! plan not approvable after recompute; skipping approval shot');
    }

    // the performer's window changes → approval no longer holds
    await api(page, 'PATCH', `/api/v1/resources/${seeded.performerA}`, { windows: [localWindowToUtc(PLAN_DAY, '09:00', '13:00', PLAN_TZ)] });
    await page.reload();
    await page.getByRole('region', { name: '拍摄单' }).waitFor();
    await shot(page, out, size, '69-plan-invalidated', shots);

    // explicit contradiction: a confirmed precedence cycle → proven_infeasible with evidence
    const [a, b] = setups as [{ id: string }, { id: string }];
    const x = await api<{ id: string }>(page, 'POST', '/api/v1/constraints', { type: 'before', a_setup_id: a.id, b_setup_id: b.id, confirmed: true });
    const y = await api<{ id: string }>(page, 'POST', '/api/v1/constraints', { type: 'before', a_setup_id: b.id, b_setup_id: a.id, confirmed: true });
    let p = await planDetail(page);
    await api(page, 'POST', `/api/v1/plans/${p.id}/recompute`, { expected_revision: p.revision });
    await page.reload();
    await page.getByRole('region', { name: '不可行的依据' }).waitFor();
    await shot(page, out, size, '70-plan-infeasible', shots);
    await api(page, 'DELETE', `/api/v1/constraints/${x.id}`);
    await api(page, 'DELETE', `/api/v1/constraints/${y.id}`);
    // back to a valid day: original window, recompute (hand-set order kept), approve
    await api(page, 'PATCH', `/api/v1/resources/${seeded.performerA}`, { windows: [localWindowToUtc(PLAN_DAY, '08:00', '14:00', PLAN_TZ)] });
    p = await planDetail(page);
    await api(page, 'POST', `/api/v1/plans/${p.id}/recompute`, { expected_revision: p.revision });
    await page.reload();
    await page.getByRole('region', { name: '拍摄单' }).waitFor();

    // AI order suggestion against the local fake model: confirm → job → card → adopt
    await page.getByRole('button', { name: 'AI 排序建议' }).click();
    const send = page.getByRole('dialog', { name: '发送排序请求' });
    await send.waitFor();
    await shot(page, out, size, '76-ai-confirm', shots);
    await send.getByRole('button', { name: '发送' }).click();
    await page.getByRole('region', { name: 'AI 排序建议' }).waitFor();
    await shot(page, out, size, '77-ai-suggestion', shots);
    await page.getByRole('region', { name: 'AI 排序建议' }).getByRole('button', { name: '采纳' }).click();
    await page.getByText('已采纳，结果见上方').waitFor();
    await shot(page, out, size, '78-ai-adopted', shots);

    // back to the grouped order and approve, for the exports
    p = await planDetail(page);
    await api(page, 'POST', `/api/v1/plans/${p.id}/reorder`, { expected_revision: p.revision, order: setups.map((s) => s.id) });
    await page.reload();
    await page.getByRole('region', { name: '拍摄单' }).waitFor();
    if (await approve.isEnabled()) {
      await approve.click();
      await page.getByText('已批准', { exact: true }).first().waitFor();
    }
  } else {
    await go(page, base, '#/plan');
    await planHeading();
    await page.getByRole('region', { name: '拍摄单' }).waitFor();
    await shot(page, out, size, '64-plan', shots);
    await page.getByRole('list', { name: 'setup 列表' }).getByRole('button').first().click();
    await page.getByRole('heading', { name: 'Setup', level: 3 }).scrollIntoViewIfNeeded();
    await shot(page, out, size, '65-setup-inspector', shots);
    await page.getByRole('region', { name: '拍摄单' }).scrollIntoViewIfNeeded();
    await shot(page, out, size, '66-call-sheet-paper', shots);
    await page.getByRole('button', { name: '陈远山' }).click();
    await page.getByRole('dialog', { name: /编辑资源/ }).waitFor();
    await shot(page, out, size, '61-resource-dialog', shots);
    await page.keyboard.press('Escape');
  }

  await page.getByRole('button', { name: '导出' }).click();
  await shot(page, out, size, '71-export-menu', shots);
  await page.getByRole('button', { name: /打印拍摄单/ }).click();
  await page.getByRole('region', { name: /拍摄单（打印预览）/ }).waitFor();
  await shot(page, out, size, '72-callsheet-preview', shots);
  if (size === DESKTOP) {
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const path = join(out, `${size.name}-73-callsheet-print.png`);
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    console.log(`  ${path}`);
    await page.emulateMedia({ media: 'screen' });
  }
  await page.getByRole('button', { name: '返回计划' }).click();
  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: /打印打板卡/ }).click();
  await page.getByRole('region', { name: /打板卡（打印预览）/ }).waitFor();
  await shot(page, out, size, '74-slates-preview', shots);
  if (size === DESKTOP) {
    await page.emulateMedia({ media: 'print' });
    await settle(page);
    const path = join(out, `${size.name}-75-slates-print.png`);
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    console.log(`  ${path}`);
    await page.emulateMedia({ media: 'screen' });
  }

  await context.close();
  return shots;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'no-build': { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      out: { type: 'string' },
      /** all (default): the S0a walk; plan: the M5 plan page walk */
      flow: { type: 'string', default: 'all' },
    },
  });
  const planFlow = values.flow === 'plan';
  const out = resolve(ROOT, values.out ?? (planFlow ? '.look/ui-plan' : '.look/ui'));
  await mkdir(out, { recursive: true });

  if (!values['no-build']) {
    console.log('building @storyscript/web …');
    const r = spawnSync('npm', ['run', 'build', '-w', '@storyscript/web'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`web build failed (exit ${r.status})`);
  }

  const tmp = await mkdtemp(join(tmpdir(), 'storyscript-ui-shots-'));
  const home = join(tmp, 'home');
  const projectsDir = join(tmp, 'projects');
  await mkdir(home, { recursive: true });
  await mkdir(projectsDir, { recursive: true });

  const port = await freePort();
  const args = ['tsx', 'apps/server/src/cli.ts', 'start', '--port', String(port), '--no-open'];
  if (values.demo) args.push('--demo');
  // plan flow: a local fake text model so the AI order suggestion can be walked without a key
  const fakeModel = planFlow && !values.demo ? await startFakeTextModel() : null;
  const server = spawn('npx', args, {
    cwd: ROOT,
    env: { ...process.env, STORYSCRIPT_HOME: home, ...(fakeModel?.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let serverLog = '';
  server.stdout?.on('data', (d: Buffer) => (serverLog += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (serverLog += d.toString()));

  let browser: Browser | null = null;
  try {
    const token = await waitForRuntime(home, port, server);
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ channel: 'chrome' });
    const all: string[] = [];
    console.log(`desktop ${DESKTOP.width}x${DESKTOP.height}`);
    const opts = (size: Size, first: boolean) => ({ base, token, out, size, projectsDir, first, demo: values.demo });
    all.push(...(await (planFlow ? capturePlan(browser, opts(DESKTOP, true)) : capture(browser, opts(DESKTOP, true)))));
    console.log(`phone ${PHONE.width}x${PHONE.height}`);
    all.push(...(await (planFlow ? capturePlan(browser, opts(PHONE, false)) : capture(browser, opts(PHONE, false)))));
    console.log(`${all.length} screenshots in ${out}`);
  } catch (err) {
    if (serverLog) console.error(`--- server output ---\n${serverLog}`);
    throw err;
  } finally {
    await browser?.close();
    await stopServer(server);
    await fakeModel?.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

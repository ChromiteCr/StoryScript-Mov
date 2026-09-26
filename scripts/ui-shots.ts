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
  await dialog.getByLabel('项目目录').fill(dir);
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
  await page.getByRole('button', { name: /识别场景/ }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(BOOKSHOP);
  await page.getByRole('region', { name: /识别出的场景 2/ }).waitFor();
  await page.getByRole('region', { name: '场景预览' }).waitFor();
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
  await page.getByRole('tab', { name: '场景与角色' }).click();
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'no-build': { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      out: { type: 'string', default: '.look/ui' },
    },
  });
  const out = resolve(ROOT, values.out);
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
  const server = spawn('npx', args, {
    cwd: ROOT,
    env: { ...process.env, STORYSCRIPT_HOME: home },
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
    all.push(...(await capture(browser, { base, token, out, size: DESKTOP, projectsDir, first: true, demo: values.demo })));
    console.log(`phone ${PHONE.width}x${PHONE.height}`);
    all.push(...(await capture(browser, { base, token, out, size: PHONE, projectsDir, first: false, demo: values.demo })));
    console.log(`${all.length} screenshots in ${out}`);
  } catch (err) {
    if (serverLog) console.error(`--- server output ---\n${serverLog}`);
    throw err;
  } finally {
    await browser?.close();
    await stopServer(server);
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

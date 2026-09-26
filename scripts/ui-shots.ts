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
 * The server and the temp directory are removed on exit, also on failure.
 *
 * M6 (set + media): a seeded shooting day with generated footage, written to
 * .look/ui-media/. `--m6-only` skips the S0a pages; `--no-ffmpeg` starts the
 * server as if ffmpeg were missing (use with `--m6-out .look/ui-media-noffmpeg`).
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

async function capture(browser: Browser, opts: { base: string; token: string; out: string; size: Size; projectsDir: string; first: boolean }) {
  const { base, token, out, size, projectsDir, first } = opts;
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

// ------------------------------------------------------------ M6: set + media

interface ApiEnvelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

/** JSON API call from inside the browser context (session cookie + same-origin Origin). */
async function m6Api<T>(page: Page, base: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.request.fetch(`${base}${path}`, {
    method,
    headers: { origin: base, 'content-type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`);
  return json.data as T;
}

const M6_FIELDS = {
  template: null,
  shot_size: 'MS',
  angle: 'eye',
  lens: 'normal',
  focal_mm: null,
  movement: 'static',
  subjects: [],
  props: [],
  env: null,
  subject_motion: 'none',
  set_piece: false,
  pov_owner: null,
  frame_format: null,
  technique_id: null,
  est_seconds: 4,
  narrative_purpose: '',
  action: '',
  dialogue_quote: null,
  source: { paragraph_id: 'p-001', quote: '' },
  assumptions: [],
  questions: [],
};

/** A small shooting day: two scenes of the sample script, nine shots, a few takes, one card of lavfi footage. */
async function seedM6(page: Page, base: string, projectsDir: string, tmp: string, noFfmpeg: boolean): Promise<{ ffmpeg: boolean }> {
  await m6Api(page, base, 'POST', '/api/v1/projects', {
    dir: join(projectsDir, '雨夜旧书'),
    name: '雨夜旧书',
    timezone: 'Asia/Shanghai',
    default_aspect: '2.39',
    target_duration_s: 600,
  });
  const text = await readFile(join(ROOT, 'fixtures', 'scripts', '01-bookshop.txt'), 'utf8');
  const imported = await m6Api<{ scenes: { id: string }[] }>(page, base, 'POST', '/api/v1/scripts', {
    text,
    source_name: '01-bookshop.txt',
    format: 'txt',
    heading_overrides: [],
  });
  const shotsSpec: [number, string, string, string][] = [
    [0, '001', 'WS', '午后光柱里的书店全景'],
    [0, '002', 'MS', '店主在柜台后清理书脊'],
    [0, '003', 'MCU', '年轻人推门进来，肩上有雨点'],
    [0, '004', 'CU', '报纸包着的日记本放上柜台'],
    [0, '005', 'ECU', '店主的手停住'],
    [0, '006', 'MS', '两人隔着柜台对视'],
    [1, '001', 'FS', '后屋：旧书堆到天花板'],
    [1, '002', 'MCU', '店主翻开第一页'],
    [1, '003', 'INSERT', '日记本扉页上的字'],
  ];
  const shots: { id: string; revision: number }[] = [];
  for (const [scene, code, size, action] of shotsSpec) {
    shots.push(
      await m6Api(page, base, 'POST', '/api/v1/shots', {
        scene_id: imported.scenes[scene]!.id,
        fields: { ...M6_FIELDS, shot_size: size, action, narrative_purpose: action },
        manual_note: '界面截图用样例镜头',
        code,
      }),
    );
  }
  const optional = shots[5]!;
  await m6Api(page, base, 'POST', `/api/v1/shots/${optional.id}/requirement`, { expected_revision: optional.revision, required_status: 'optional', reason: '时间够再拍' });
  const waived = shots[8]!;
  await m6Api(page, base, 'POST', `/api/v1/shots/${waived.id}/requirement`, { expected_revision: waived.revision, required_status: 'waived', reason: '改用道具特写' });

  const take = (shotIds: string[], rating: string, clip: string | null, notes = '') =>
    m6Api(page, base, 'POST', '/api/v1/takes', { setup_id: null, camera_label: 'A', rating, clip_hint: clip, notes, shot_ids: shotIds, unresolved_labels: [] });
  await take([shots[0]!.id], 'reject', null, '跑焦');
  await take([shots[0]!.id], 'good', null);
  await take([shots[1]!.id], 'good', null);
  await take([shots[2]!.id, shots[3]!.id], 'good', 'A001C003', '一条过两个镜头');
  await take([shots[6]!.id], 'alternate', null, '光不够');
  // a clip name written against the wrong shot: S01-002-T01 is also 1-002's slate → a conflict to review
  await take([shots[5]!.id], 'unrated', 'S01-002-T01', '机内文件名可能记错了');

  const { locateTool } = await import('../apps/server/src/adapters/media/ffmpeg.ts');
  const ffmpeg = noFfmpeg ? null : locateTool('ffmpeg');
  if (!ffmpeg || !locateTool('ffprobe')) {
    // no footage: register an empty card so the page shows the disabled scan and the install hint
    const empty = join(tmp, 'CARD_A');
    await mkdir(empty, { recursive: true });
    await m6Api(page, base, 'POST', '/api/v1/media/roots', { abs_path: empty, label: 'A 机 第一天' });
    return { ffmpeg: false };
  }
  const { generateMedia } = await import('./gen-media.ts');
  const card = join(tmp, 'CARD_A');
  await generateMedia(card, { ffmpeg, small: false });
  const root = await m6Api<{ id: string }>(page, base, 'POST', '/api/v1/media/roots', { abs_path: card, label: 'A 机 第一天' });
  const job = await m6Api<{ job_id: string }>(page, base, 'POST', `/api/v1/media/roots/${root.id}/scan`);
  for (let i = 0; i < 300; i++) {
    const j = await m6Api<{ status: string }>(page, base, 'GET', `/api/v1/jobs/${job.job_id}`);
    if (!['queued', 'running'].includes(j.status)) break;
    await sleep(100);
  }
  await m6Api(page, base, 'POST', '/api/v1/media/candidates', { user_regex: null });
  // confirm the clip of 1-001 and make it usable; confirm 1-002's; leave the rest for review
  const links = await m6Api<{ id: string; shot_id: string; revision: number }[]>(page, base, 'GET', '/api/v1/links');
  const first = links.find((l) => l.shot_id === shots[0]!.id);
  if (first) {
    await m6Api(page, base, 'PATCH', `/api/v1/links/${first.id}`, { expected_revision: first.revision, action: 'confirm' });
    await m6Api(page, base, 'POST', `/api/v1/shots/${shots[0]!.id}/coverage-decisions`, { decision: 'usable', selected_link_ids: [first.id], reason: '焦点准，表演可用' });
  }
  const second = links.find((l) => l.shot_id === shots[1]!.id);
  if (second) await m6Api(page, base, 'PATCH', `/api/v1/links/${second.id}`, { expected_revision: second.revision, action: 'confirm' });
  await m6Api(page, base, 'POST', `/api/v1/shots/${shots[4]!.id}/coverage-decisions`, { decision: 'needs_pickup', selected_link_ids: [], reason: '手部穿帮，需要补拍' });
  return { ffmpeg: true };
}

/**
 * shot() plus a shell check: the title bar and page bar are fixed, so the
 * document itself must never scroll vertically (only panels and <main> do).
 */
async function m6Shot(page: Page, out: string, size: Size, name: string, list: string[]): Promise<void> {
  await shot(page, out, size, name, list);
  const doc = (await page.evaluate(
    '({ top: document.scrollingElement.scrollTop, extra: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight })',
  )) as { top: number; extra: number };
  if (doc.top > 0 || doc.extra > 0) {
    console.warn(`  ! ${size.name}-${name}: the document scrolls vertically (top ${doc.top}px, extra ${doc.extra}px)`);
    // usually an absolutely positioned element (sr-only, badge) whose containing block escapes its scroll panel
    const culprits = (await page.evaluate(`[...document.querySelectorAll('body *')]
      .filter((el) => getComputedStyle(el).position === 'absolute' && el.getBoundingClientRect().bottom > innerHeight + scrollY)
      .slice(0, 5)
      .map((el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 3).join('.') + ' "' + (el.textContent || '').trim().slice(0, 20) + '"')`)) as string[];
    for (const c of culprits) console.warn(`      ${c}`);
  }
}

async function captureSetAndMedia(
  browser: Browser,
  opts: { base: string; token: string; out: string; projectsDir: string; tmp: string; noFfmpeg: boolean },
): Promise<string[]> {
  const { base, token, out, projectsDir, tmp, noFfmpeg } = opts;
  const list: string[] = [];
  let ffmpeg = true;
  for (const size of [DESKTOP, PHONE]) {
    console.log(`set/media ${size.width}x${size.height}`);
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
      if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.warn(`  ! console: ${msg.text()}`);
    });
    await page.goto(`${base}/#t=${token}`);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    if (size === DESKTOP) ({ ffmpeg } = await seedM6(page, base, projectsDir, tmp, noFfmpeg));

    // 现场 (reload: the project was opened through the API, a hash change alone keeps the old state)
    await go(page, base, '#/set');
    await page.reload();
    await page.getByRole('heading', { name: '现场', level: 1 }).waitFor();
    await page.getByRole('form', { name: '新增条次' }).waitFor();
    await m6Shot(page, out, size, '60-set', list);
    if (size === DESKTOP) {
      // one take by keyboard: clip name, digit rating outside text fields, Enter
      await page.locator('button[data-shot]').nth(1).click();
      await page.getByLabel('机内文件名').fill('A001C007');
      await page.getByLabel('备注').fill('表演很好，声音里有车');
      await page.locator('button[data-shot]').nth(1).focus();
      await page.keyboard.press('1');
      await page.getByLabel('备注').focus();
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: '已记录' }).waitFor();
      await m6Shot(page, out, size, '61-set-logged', list);
      await page.getByRole('button', { name: /^更正 T/ }).first().click();
      await m6Shot(page, out, size, '62-set-correct', list);
    }

    // 素材
    await go(page, base, '#/media');
    await page.getByRole('heading', { name: '素材', level: 1 }).waitFor();
    await page.waitForTimeout(400);
    await m6Shot(page, out, size, '70-media', list);
    if (ffmpeg) {
      await page.locator('button[data-asset]').first().click();
      await page.waitForTimeout(300);
      await m6Shot(page, out, size, '71-media-inspector', list);
      await page.getByRole('button', { name: /^候选审核/ }).click();
      await page.getByRole('dialog').waitFor();
      await m6Shot(page, out, size, '72-media-candidates', list);
      await page.keyboard.press('Escape');
      await page.getByRole('searchbox', { name: '搜索素材' }).fill('S01');
      await page.waitForTimeout(600);
      await m6Shot(page, out, size, '73-media-search', list);
      await page.getByRole('searchbox', { name: '搜索素材' }).fill('');
    }
    await page.getByRole('button', { name: /覆盖决定$/ }).nth(1).click();
    await page.waitForTimeout(200);
    await m6Shot(page, out, size, '74-media-decision', list);
    if (size === DESKTOP) {
      await page.emulateMedia({ media: 'print' });
      await settle(page);
      const path = join(out, `${size.name}-75-missing-report-print.png`);
      await page.screenshot({ path, fullPage: true });
      list.push(path);
      console.log(`  ${path}`);
      await page.emulateMedia({ media: 'screen' });
    }
    await context.close();
  }
  return list;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'no-build': { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      out: { type: 'string', default: '.look/ui' },
      // M6: set + media pages → .look/ui-media/ (with --m6-only the S0a pages are skipped)
      'm6-only': { type: 'boolean', default: false },
      'm6-out': { type: 'string', default: '.look/ui-media' },
      // M6: start the server as if ffmpeg/ffprobe were not installed (install hint, scan disabled)
      'no-ffmpeg': { type: 'boolean', default: false },
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
    env: {
      ...process.env,
      STORYSCRIPT_HOME: home,
      ...(values['no-ffmpeg'] ? { STORYSCRIPT_FFMPEG: join(tmp, 'no-ffmpeg'), STORYSCRIPT_FFPROBE: join(tmp, 'no-ffprobe') } : {}),
    },
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
    if (!values['m6-only']) {
      console.log(`desktop ${DESKTOP.width}x${DESKTOP.height}`);
      all.push(...(await capture(browser, { base, token, out, size: DESKTOP, projectsDir, first: true })));
      console.log(`phone ${PHONE.width}x${PHONE.height}`);
      all.push(...(await capture(browser, { base, token, out, size: PHONE, projectsDir, first: false })));
      console.log(`${all.length} screenshots in ${out}`);
    }
    const m6Out = resolve(ROOT, values['m6-out']);
    await mkdir(m6Out, { recursive: true });
    const m6 = await captureSetAndMedia(browser, { base, token, out: m6Out, projectsDir, tmp, noFfmpeg: values['no-ffmpeg'] });
    console.log(`${m6.length} set/media screenshots in ${m6Out}`);
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

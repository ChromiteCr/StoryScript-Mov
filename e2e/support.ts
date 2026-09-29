/**
 * Shared E2E plumbing (Playwright specs and the board screenshot script):
 * start the production server under a throwaway STORYSCRIPT_HOME (optionally
 * --demo, so AI steps replay fixtures/replay and nothing leaves the machine),
 * read the launch token from runtime.json, and walk the common UI steps.
 * The server runs in its own process group so npx → tsx → node stop together.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '..');
export const BOOKSHOP = join(ROOT, 'fixtures', 'scripts', '01-bookshop.txt');
export const SCENE_1 = '内景 旧书店 日';

export function buildWeb(): void {
  const r = spawnSync('npm', ['run', 'build', '-w', '@storyscript/web'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`web build failed (exit ${r.status})`);
}

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

function signalGroup(server: ChildProcess, signal: NodeJS.Signals): void {
  if (server.pid === undefined) return;
  try {
    process.kill(-server.pid, signal);
  } catch {
    server.kill(signal);
  }
}

export interface RunningApp {
  base: string;
  token: string;
  /** temp root: home/ (STORYSCRIPT_HOME) and projects/ */
  tmp: string;
  projectsDir: string;
  log(): string;
  stop(): Promise<void>;
}

/** The server environment without any model credentials (the no-key flows). */
function withoutKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^STORYSCRIPT_(LLM|IMAGE)_/.test(k)));
}

export async function startApp(opts: { demo?: boolean; noKey?: boolean } = {}): Promise<RunningApp> {
  const tmp = await mkdtemp(join(tmpdir(), 'storyscript-e2e-'));
  const home = join(tmp, 'home');
  const projectsDir = join(tmp, 'projects');
  await mkdir(home, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  const port = await freePort();
  const args = ['tsx', 'apps/server/src/cli.ts', 'start', '--port', String(port), '--no-open'];
  if (opts.demo) args.push('--demo');
  const server = spawn('npx', args, {
    cwd: ROOT,
    env: { ...(opts.noKey ? withoutKeys(process.env) : process.env), STORYSCRIPT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  server.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  const stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((r) => server.once('exit', () => r()));
      signalGroup(server, 'SIGINT');
      if ((await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)])) === 'timeout') {
        signalGroup(server, 'SIGKILL');
        await exited;
      }
    }
    await rm(tmp, { recursive: true, force: true });
  };
  try {
    const token = await waitForRuntime(home, port, server);
    return { base: `http://127.0.0.1:${port}`, token, tmp, projectsDir, log: () => log, stop };
  } catch (err) {
    await stop();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- server output ---\n${log}`);
  }
}

/** Same-origin API call from inside the page (session cookie + Origin apply). */
export async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
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

/** Token → cookie; resolves once a page title (h1) shows. Returns that title. */
export async function signInAnywhere(page: Page, app: RunningApp): Promise<string> {
  await page.goto(`${app.base}/#t=${app.token}`);
  const h1 = page.getByRole('heading', { level: 1 }).first();
  await h1.waitFor();
  return (await h1.textContent())?.trim() ?? '';
}

/**
 * Token → cookie, then the project manager. A --demo server opens its demo
 * project on start; that project is closed first ("切换项目").
 */
export async function signIn(page: Page, app: RunningApp): Promise<void> {
  const title = await signInAnywhere(page, app);
  if (title !== '项目') await page.getByRole('button', { name: /切换项目/ }).click();
  await page.getByRole('heading', { name: '项目', level: 1 }).waitFor();
}

export async function createProject(page: Page, dir: string, name: string): Promise<void> {
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

/**
 * Script page, all through the UI against the demo replay: import
 * 01-bookshop.txt → AI entity extraction → apply → AI breakdown of scene 1 →
 * draft diff → apply (12 shots).
 */
export async function importAndBreakdownBookshop(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/#/script`);
  await page.getByRole('button', { name: /识别场次/ }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(BOOKSHOP);
  await page.getByRole('region', { name: '逐行预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '导入为新版本' }).click();
  await page.getByRole('region', { name: /镜头表/ }).waitFor();

  await page.getByRole('button', { name: 'AI 抽取角色、地点和道具' }).click();
  const entities = page.getByRole('dialog', { name: '实体草案' });
  await entities.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });
  await entities.getByRole('button', { name: /应用所选/ }).click();
  await entities.waitFor({ state: 'detached' });

  const scene1 = page.getByRole('region', { name: SCENE_1, exact: true });
  await scene1.getByRole('button', { name: 'AI 拆镜' }).click();
  await page.getByRole('button', { name: '开始拆镜' }).click();
  const draft = page.getByRole('dialog', { name: /AI 拆镜草案 · 第 1 场/ });
  await draft.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });
  await draft.getByRole('button', { name: /应用所选/ }).click();
  await draft.waitFor({ state: 'detached' });
  await scene1.locator('li[id^="shot-"]').first().waitFor();
}

// ---------------------------------------------------------------------------
// hosted server (S2a): a throwaway data dir; verification emails land in an
// outbox folder, so tests read the codes from there
// ---------------------------------------------------------------------------

export const HOSTED_INVITE = 'e2e-Invite';

export interface HostedApp {
  base: string;
  tmp: string;
  log(): string;
  stop(): Promise<void>;
  /** the newest 6-digit code mailed to this address (waits for it) */
  codeFor(email: string): Promise<string>;
}

function cli(args: string[]): string {
  const r = spawnSync('npx', ['tsx', 'apps/server/src/cli.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`storyscript-mov ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

async function newestCode(outbox: string, email: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const files = (await readdir(outbox).catch(() => [] as string[])).sort().reverse();
    for (const f of files) {
      const m = JSON.parse(await readFile(join(outbox, f), 'utf8')) as { to: string; text: string };
      const code = m.to === email ? /验证码：(\d{6})/.exec(m.text)?.[1] : undefined;
      if (code) return code;
    }
    await sleep(100);
  }
  throw new Error(`no code mailed to ${email}`);
}

export async function startHostedApp(): Promise<HostedApp> {
  const tmp = await mkdtemp(join(tmpdir(), 'storyscript-hosted-'));
  const data = join(tmp, 'data');
  const outbox = join(tmp, 'outbox');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  cli(['server', 'init', '--data', data, '--origin', base, '--port', String(port), '--name', '测试短片节', '--invite', HOSTED_INVITE, '--mail-from', 'noreply@e2e.test']);
  const server = spawn('npx', ['tsx', 'apps/server/src/cli.ts', 'server', 'start', '--data', data], {
    cwd: ROOT,
    env: { ...withoutKeys(process.env), STORYSCRIPT_MAIL_OUTBOX: outbox },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  server.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  const stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((r) => server.once('exit', () => r()));
      signalGroup(server, 'SIGINT');
      if ((await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)])) === 'timeout') {
        signalGroup(server, 'SIGKILL');
        await exited;
      }
    }
    await rm(tmp, { recursive: true, force: true });
  };
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null) break;
    const ok = await fetch(`${base}/api/v1/site`).then((r) => r.ok).catch(() => false);
    if (ok) return { base, tmp, log: () => log, stop, codeFor: (email) => newestCode(outbox, email) };
    await sleep(100);
  }
  await stop();
  throw new Error(`hosted server did not start:\n${log}`);
}

/** Register through the API in the page's browser context (so it carries the cookie) and optionally start a group. */
export async function signUpHosted(page: Page, app: HostedApp, email: string, name: string, group?: string): Promise<void> {
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(`${app.base}${path}`, { data, headers: { origin: app.base } });
    if (!r.ok()) throw new Error(`${path}: HTTP ${r.status()} ${await r.text()}`);
  };
  await post('/api/v1/account/register/code', { email, invite: HOSTED_INVITE });
  await post('/api/v1/account/register', { email, code: await app.codeFor(email), name, password: 'password-1' });
  if (group) await post('/api/v1/group', { name: group });
}

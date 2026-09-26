import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ApiError, HealthInfo, Project, ProjectManifest, RecentProject } from '@storyscript/contracts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/port.ts';
import { isAppError } from '../src/http/errors.ts';
import { LOCK_FILE, readLock } from '../src/project/lock.ts';
import { createProject, openProject, type OpenedProject } from '../src/project/project.ts';
import { ProjectSession } from '../src/project/session.ts';

const PORT = 43101;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const TOKEN = 'at01-token-0123456789abcdefghijklmnopqrstuvwxyz_AB';

let root: string;
let stateDir: string;
const toClose: Array<{ close(): unknown }> = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ssm-at01-')));
  stateDir = join(root, 'home');
  process.env.STORYSCRIPT_HOME = stateDir;
});

afterEach(() => {
  while (toClose.length) toClose.pop()!.close();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const input = { name: '雨夜来信', timezone: 'Asia/Shanghai', default_aspect: '2.39' as const, target_duration_s: 480 };

async function expectAppError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e) => isAppError(e) && e.code === code);
}

/** A pid that existed a moment ago and has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid!;
}

/** `{ data }` of a success envelope. */
async function dataOf(res: Response): Promise<unknown> {
  return ((await res.json()) as { data: unknown }).data;
}

function writeLock(dir: string, pid: number, host = hostname()) {
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid, hostname: host, started_at: '2026-09-26T00:00:00.000Z' }));
}

describe('AT-01 project lifecycle (API)', () => {
  function makeApp() {
    const handle = createApp({
      mode: 'production',
      port: PORT,
      token: TOKEN,
      webDir: join(root, 'no-web'),
      stateDir,
      env: {},
      tools: async () => ({ ffmpeg: { path: null, version: null }, ffprobe: { path: null, version: null }, h264_encoders: [] }),
    });
    toClose.push({ close: () => handle.projectSession.closeNow() });
    return handle;
  }

  async function authed(app: ReturnType<typeof makeApp>['app']) {
    const res = await app.request('/api/v1/session', {
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    return (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { host: HOST, origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  }

  test('create → close → reopen keeps everything intact', async () => {
    const { app } = makeApp();
    const call = await authed(app);
    const dir = join(root, 'films', '雨夜来信'); // does not exist yet

    const created = await call('/api/v1/projects', { dir, ...input });
    expect(created.status).toBe(201);
    const project = Project.parse(await dataOf(created));
    expect(project).toMatchObject({ ...input, schema_version: 1, code_format: 'S{scene:02}-{shot:03}-T{take:02}' });

    // on-disk layout
    const manifest = ProjectManifest.parse(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')));
    expect(manifest).toMatchObject({ format: 'storyscript-mov-project', id: project.id, schema_version: 1 });
    for (const sub of ['scripts', 'boards', 'derivatives/posters', 'exports', 'recovery']) {
      expect(statSync(join(dir, sub)).isDirectory(), sub).toBe(true);
    }
    expect(existsSync(join(dir, 'project.sqlite'))).toBe(true);
    expect(readLock(join(dir, LOCK_FILE))).toMatchObject({ pid: process.pid, hostname: hostname() });

    // current project + health flag
    expect(Project.parse(await dataOf(await call('/api/v1/project')))).toEqual(project);
    expect(HealthInfo.parse(await dataOf(await call('/api/v1/health'))).project_open).toBe(true);

    const closed = await call('/api/v1/projects/close', {});
    expect(closed.status).toBe(204);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    const none = await call('/api/v1/project');
    expect(none.status).toBe(409);
    expect(ApiError.parse(await none.json()).error.code).toBe('NO_PROJECT_OPEN');

    const reopened = await call('/api/v1/projects/open', { dir });
    expect(reopened.status).toBe(200);
    expect(Project.parse(await dataOf(reopened))).toEqual(project);

    const recent = RecentProject.array().parse(await dataOf(await call('/api/v1/projects/recent')));
    expect(recent[0]).toMatchObject({ dir, name: input.name });
    expect(recent.filter((r) => r.dir === dir)).toHaveLength(1);
  });

  test('creating in a directory that already holds a project is refused', async () => {
    const { app } = makeApp();
    const call = await authed(app);
    const dir = join(root, 'dup');
    expect((await call('/api/v1/projects', { dir, ...input })).status).toBe(201);
    await call('/api/v1/projects/close', {});
    const again = await call('/api/v1/projects', { dir, ...input, name: '另一个' });
    expect(again.status).toBe(409);
    const err = ApiError.parse(await again.json()).error;
    expect(err.code).toBe('PROJECT_EXISTS');
  });

  test('input validation: relative dir, bad timezone, bad aspect → 400', async () => {
    const { app } = makeApp();
    const call = await authed(app);
    for (const body of [
      { dir: 'relative/path', ...input },
      { dir: join(root, 'tz'), ...input, timezone: 'Mars/Olympus' },
      { dir: join(root, 'aspect'), ...input, default_aspect: '4:3' },
    ]) {
      const res = await call('/api/v1/projects', body);
      expect(res.status).toBe(400);
      expect(ApiError.parse(await res.json()).error.code).toBe('VALIDATION_ERROR');
    }
    expect(existsSync(join(root, 'tz', 'project.json'))).toBe(false);
  });

  test('opening a missing project → 404', async () => {
    const { app } = makeApp();
    const call = await authed(app);
    const res = await call('/api/v1/projects/open', { dir: join(root, 'nowhere') });
    expect(res.status).toBe(404);
  });
});

describe('AT-01 project open/lock rules', () => {
  async function make(name: string): Promise<{ dir: string; opened: OpenedProject }> {
    const dir = join(root, name);
    const opened = await createProject(dir, input);
    return { dir, opened };
  }

  test('data written before close survives reopen', async () => {
    const { dir, opened } = await make('persist');
    opened.db.run("INSERT INTO kv (key, value_json, updated_at) VALUES ('note', '\"客厅夜戏\"', ?)", new Date().toISOString());
    opened.close();
    const again = await openProject(dir);
    toClose.push(again);
    expect(again.db.get<{ value_json: string }>("SELECT value_json FROM kv WHERE key = 'note'")?.value_json).toBe('"客厅夜戏"');
    expect(again.migration.applied).toEqual([]);
    expect(again.project().name).toBe(input.name);
  });

  test('schema_version newer than supported → SCHEMA_VERSION_UNSUPPORTED (manifest or database)', async () => {
    const { dir, opened } = await make('too-new');
    opened.close();
    const manifestFile = join(dir, 'project.json');
    const original = readFileSync(manifestFile, 'utf8');
    writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(original), schema_version: 99 }));
    await expectAppError(openProject(dir), 'SCHEMA_VERSION_UNSUPPORTED');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);

    writeFileSync(manifestFile, original);
    const db = openDb(join(dir, 'project.sqlite'));
    db.exec('PRAGMA user_version = 7');
    db.close();
    await expectAppError(openProject(dir), 'SCHEMA_VERSION_UNSUPPORTED');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  test('lock held by another live process on this host → PROJECT_LOCKED', async () => {
    const { dir, opened } = await make('locked');
    opened.close();
    writeLock(dir, process.ppid);
    await expectAppError(openProject(dir), 'PROJECT_LOCKED');
    // lock untouched
    expect(readLock(join(dir, LOCK_FILE))?.pid).toBe(process.ppid);
  });

  test('lock from another host is never taken over', async () => {
    const { dir, opened } = await make('other-host');
    opened.close();
    writeLock(dir, deadPid(), 'another-machine.local');
    await expectAppError(openProject(dir), 'PROJECT_LOCKED');
  });

  test('stale lock (pid gone) is taken over', async () => {
    const { dir, opened } = await make('stale');
    opened.close();
    const pid = deadPid();
    writeLock(dir, pid);
    const again = await openProject(dir);
    toClose.push(again);
    expect(readLock(join(dir, LOCK_FILE))).toMatchObject({ pid: process.pid });
    again.close();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  test('second open of the same project (two sessions, one process) → PROJECT_LOCKED', async () => {
    const { dir, opened } = await make('twice');
    opened.close();
    const a = new ProjectSession(stateDir);
    const b = new ProjectSession(stateDir);
    toClose.push({ close: () => a.closeNow() }, { close: () => b.closeNow() });
    await a.open(dir);
    await expectAppError(b.open(dir), 'PROJECT_LOCKED');
    // the same session re-opening is idempotent
    await expect(a.open(dir)).resolves.toMatchObject({ name: input.name });
    await a.close();
    await expect(b.open(dir)).resolves.toMatchObject({ name: input.name });
  });

  test('switching projects releases the previous lock', async () => {
    const first = await make('switch-a');
    first.opened.close();
    const second = await make('switch-b');
    second.opened.close();
    const s = new ProjectSession(stateDir);
    toClose.push({ close: () => s.closeNow() });
    await s.open(first.dir);
    await s.open(second.dir);
    expect(existsSync(join(first.dir, LOCK_FILE))).toBe(false);
    expect(existsSync(join(second.dir, LOCK_FILE))).toBe(true);
  });

  test('corrupt project.json → VALIDATION_ERROR; non-directory path → VALIDATION_ERROR', async () => {
    const dir = join(root, 'corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), '{oops');
    await expectAppError(openProject(dir), 'VALIDATION_ERROR');
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    await expectAppError(createProject(file, input), 'VALIDATION_ERROR');
  });
});

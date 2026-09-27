import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { generateTeamCode, hashTeamCode, readHostedConfig, writeHostedConfig, type HostedConfig } from '../src/hosted/config.ts';
import { runServerCli } from '../src/hosted/cli.ts';
import { startHostedServer, type HostedServer } from '../src/hosted/start.ts';

/**
 * Hosted server mode (S2): several teams share one site. A team code signs a
 * browser in; each team only ever reaches its own project; features that
 * would touch the server's disk or settings are refused; Host/Origin checks,
 * sign-in throttling and sessions survive a restart.
 */

const PUBLIC = 'https://story.example.test';
let data = '';
let server: HostedServer | null = null;
const codes: Record<string, string> = {};

function config(): HostedConfig {
  const team = (slug: string, name: string) => {
    codes[slug] = generateTeamCode();
    return { slug, name, code_sha256: hashTeamCode(codes[slug]!), created_at: '2026-09-27T00:00:00.000Z' };
  };
  return {
    format: 'storyscript-mov-server',
    version: 1,
    site_name: '学校短片节',
    public_origin: PUBLIC,
    listen_host: '127.0.0.1',
    port: 4700,
    timezone: 'Asia/Shanghai',
    teams: [team('team-a', '一组'), team('team-b', '二组')],
  };
}

const start = async () => {
  server = await startHostedServer({ dataDir: data, port: 0, webDir: join(data, 'no-web'), log: () => undefined });
  return server;
};

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

function call(method: string, path: string, opts: { cookie?: string; body?: unknown; host?: string; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Res> {
  const port = server!.port;
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET' && opts.origin !== null) headers.origin = opts.origin ?? `http://127.0.0.1:${port}`;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signIn(code: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await call('POST', '/api/v1/session', { body: { token: code }, headers: extra });
  expect(r.status, r.body).toBe(204);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  return set[0]!.split(';')[0]!;
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ssm-hosted-'));
  writeHostedConfig(data, config());
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(data, { recursive: true, force: true });
});

describe('hosted server: sign-in', () => {
  test('site info is public; everything else needs a team session', async () => {
    await start();
    const site = await call('GET', '/api/v1/site');
    expect(site.status).toBe(200);
    expect(site.json().data).toEqual({ hosted: true, name: '学校短片节' });
    expect((await call('GET', '/api/v1/health')).status).toBe(401);
    expect((await call('GET', '/api/v1/project')).status).toBe(401);
  });

  test('a team code (any case, spaces or dashes) signs in with a secure, HttpOnly, strict cookie', async () => {
    await start();
    const typed = codes['team-a']!.toLowerCase().replace(/-/g, ' ');
    const r = await call('POST', '/api/v1/session', { body: { token: typed } });
    expect(r.status).toBe(204);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    const wrong = await call('POST', '/api/v1/session', { body: { token: 'AAAA-BBBB-CCCC-DDDD' } });
    expect(wrong.status).toBe(401);
    expect(wrong.json().error.code).toBe('UNAUTHORIZED');
  });

  test('health says hosted, names the team and hides the server home directory', async () => {
    await start();
    const cookie = await signIn(codes['team-a']!);
    const h = (await call('GET', '/api/v1/health', { cookie })).json().data;
    expect(h).toMatchObject({ hosted: true, team_name: '一组', home_dir: '', project_open: true });
    expect((await call('GET', '/api/v1/project', { cookie })).json().data.name).toBe('一组');
  });

  test('sign out ends the session', async () => {
    await start();
    const cookie = await signIn(codes['team-b']!);
    expect((await call('DELETE', '/api/v1/session', { cookie })).status).toBe(204);
    expect((await call('GET', '/api/v1/health', { cookie })).status).toBe(401);
  });

  test('ten wrong codes from one address block it (429 + Retry-After), other addresses are not affected', async () => {
    await start();
    const from = (ip: string) => ({ 'x-forwarded-for': `10.0.0.1, ${ip}` });
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/api/v1/session', { body: { token: `WRONG-CODE-${i}-XXXXXX` }, headers: from('203.0.113.7') })).status).toBe(401);
    }
    const blocked = await call('POST', '/api/v1/session', { body: { token: codes['team-a']! }, headers: from('203.0.113.7') });
    expect(blocked.status).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await signIn(codes['team-a']!, from('203.0.113.8'));
  });

  test('sessions survive a restart', async () => {
    await start();
    const cookie = await signIn(codes['team-a']!);
    await server!.close();
    await start();
    expect((await call('GET', '/api/v1/health', { cookie })).status).toBe(200);
  });
});

describe('hosted server: isolation and limits', () => {
  test('each team only sees its own project', async () => {
    await start();
    const a = await signIn(codes['team-a']!);
    const b = await signIn(codes['team-b']!);
    const made = await call('POST', '/api/v1/entities', { cookie: a, body: { type: 'character', name: '店主', aliases: [] } });
    expect(made.status, made.body).toBe(201);
    const listA = (await call('GET', '/api/v1/entities', { cookie: a })).json().data as { name: string }[];
    const listB = (await call('GET', '/api/v1/entities', { cookie: b })).json().data as { name: string }[];
    expect(listA.map((e) => e.name)).toContain('店主');
    expect(listB.map((e) => e.name)).not.toContain('店主');
  });

  test.each([
    ['POST', '/api/v1/projects/open', { dir: '/etc' }],
    ['POST', '/api/v1/projects', { dir: '/tmp/x', name: 'x', timezone: 'Asia/Shanghai', default_aspect: '2.39', target_duration_s: null }],
    ['POST', '/api/v1/projects/close', undefined],
    ['POST', '/api/v1/platform/choose-folder', undefined],
    ['PUT', '/api/v1/settings/providers/text', { base_url: 'http://169.254.169.254', model: 'x', api_key: 'k' }],
    ['POST', '/api/v1/media/roots', { abs_path: '/etc' }],
  ])('%s %s is refused on a hosted server', async (method, path, body) => {
    await start();
    const cookie = await signIn(codes['team-a']!);
    const r = await call(method, path, { cookie, body });
    expect(r.status, r.body).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
  });

  test('the recent-projects list is empty (no server paths leak)', async () => {
    await start();
    const cookie = await signIn(codes['team-a']!);
    expect((await call('GET', '/api/v1/projects/recent', { cookie })).json().data).toEqual([]);
  });

  test('Host and Origin are checked against the public address', async () => {
    await start();
    expect((await call('GET', '/api/v1/site', { host: 'story.example.test' })).status).toBe(200);
    expect((await call('GET', '/api/v1/site', { host: 'evil.test' })).status).toBe(403);
    const cross = await call('POST', '/api/v1/session', { body: { token: codes['team-a']! }, origin: 'https://evil.test' });
    expect(cross.status).toBe(403);
    const noOrigin = await call('POST', '/api/v1/session', { body: { token: codes['team-a']! }, origin: null });
    expect(noOrigin.status).toBe(403);
    expect((await call('POST', '/api/v1/session', { body: { token: codes['team-a']! }, origin: PUBLIC, host: 'story.example.test' })).status).toBe(204);
  });
});

describe('hosted server: admin commands', () => {
  test('init, team add/list/reset/remove; a reset code signs out the old browsers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssm-hosted-cli-'));
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runServerCli(['init', '--data', dir, '--origin', 'https://Story.Example.test/', '--name', '短片节'])).toBe(0);
      expect(readHostedConfig(dir)!.public_origin).toBe('https://story.example.test');
      expect(await runServerCli(['init', '--data', dir, '--origin', 'https://x.test/sub'])).toBe(2);
      expect(await runServerCli(['team', 'add', 'Bad_Slug', '--name', 'x', '--data', dir])).toBe(2);
      expect(await runServerCli(['team', 'add', 'team-1', '--name', '一组', '--data', dir])).toBe(0);
      const code = out.find((l) => l.startsWith('口令：'))!.slice(3);
      expect(out.some((l) => l === `邀请链接：https://story.example.test/#t=${code}`)).toBe(true);
      expect(readHostedConfig(dir)!.teams[0]!.code_sha256).toBe(hashTeamCode(code));
      expect(JSON.stringify(readHostedConfig(dir))).not.toContain(code);

      data = dir;
      await start();
      const cookie = await signIn(code);
      expect(await runServerCli(['team', 'reset', 'team-1', '--data', dir])).toBe(1); // refused while running
      await server!.close();
      server = null;
      out.length = 0;
      expect(await runServerCli(['team', 'reset', 'team-1', '--data', dir])).toBe(0);
      const fresh = out.find((l) => l.startsWith('口令：'))!.slice(3);
      await start();
      expect((await call('GET', '/api/v1/health', { cookie })).status).toBe(401);
      expect((await call('POST', '/api/v1/session', { body: { token: code } })).status).toBe(401);
      await signIn(fresh);
      await server!.close();
      server = null;
      expect(await runServerCli(['team', 'remove', 'team-1', '--data', dir])).toBe(0);
      expect(readHostedConfig(dir)!.teams).toEqual([]);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

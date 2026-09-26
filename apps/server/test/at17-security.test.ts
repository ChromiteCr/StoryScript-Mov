import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ApiError, HealthInfo } from '@storyscript/contracts';
import { createApp } from '../src/app.ts';
import { readRuntime } from '../src/config/paths.ts';
import type { ToolsInfo } from '../src/diagnostics.ts';
import type { ServerMode } from '../src/security/guards.ts';
import { startServer, type RunningServer } from '../src/server.ts';

const PORT = 43117;
const TOKEN = 'at17-token-0123456789abcdefghijklmnopqrstuvwxyz_AB';
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const PROD_CSP =
  "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const fakeTools = async (): Promise<ToolsInfo> => ({
  ffmpeg: { path: '/opt/fake/ffmpeg', version: '8.0' },
  ffprobe: { path: '/opt/fake/ffprobe', version: '8.0' },
  h264_encoders: ['h264_videotoolbox'],
});

let root: string;
let stateDir: string;
let webDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ssm-at17-'));
  stateDir = join(root, 'home');
  webDir = join(root, 'web');
  process.env.STORYSCRIPT_HOME = stateDir;
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>t</title><div id="root"></div>');
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function make(mode: ServerMode = 'production', env: NodeJS.ProcessEnv = {}) {
  return createApp({
    mode,
    port: PORT,
    token: TOKEN,
    webDir,
    stateDir,
    env,
    tools: fakeTools,
    chooseFolder: async () => null,
  });
}

type App = ReturnType<typeof make>['app'];

function req(app: App, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return app.request(path, { ...init, headers: { host: HOST, ...init.headers } });
}

async function login(app: App, token = TOKEN) {
  return req(app, '/api/v1/session', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function cookieFor(app: App): Promise<string> {
  const res = await login(app);
  expect(res.status).toBe(204);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0]!;
}

async function errorOf(res: Response) {
  return ApiError.parse(await res.json()).error;
}

describe('AT-17 Host allow-list (DNS rebinding)', () => {
  test.each(['evil.example', `evil.example:${PORT}`, '127.0.0.1:1', `localhost.evil.example:${PORT}`, `0.0.0.0:${PORT}`])(
    'forged Host %s → 403 FORBIDDEN',
    async (host) => {
      const { app } = make();
      for (const path of ['/api/v1/health', '/', '/api/v1/session']) {
        const res = await app.request(path, { headers: { host } });
        expect(res.status).toBe(403);
        expect((await errorOf(res)).code).toBe('FORBIDDEN');
      }
    },
  );

  test('both 127.0.0.1:port and localhost:port are accepted', async () => {
    const { app } = make();
    for (const host of [HOST, `localhost:${PORT}`, `LOCALHOST:${PORT}`]) {
      const res = await app.request('/', { headers: { host } });
      expect(res.status).toBe(200);
    }
  });
});

describe('AT-17 Origin check (CSRF)', () => {
  test('cross-origin POST → 403 even with a valid session cookie', async () => {
    const { app } = make();
    const cookie = await cookieFor(app);
    const res = await req(app, '/api/v1/projects/close', { method: 'POST', headers: { cookie, origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
  });

  test('POST without Origin → 403', async () => {
    const { app } = make();
    const cookie = await cookieFor(app);
    const res = await req(app, '/api/v1/projects/close', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
  });

  test('token exchange itself also needs a same-origin Origin', async () => {
    const { app } = make();
    for (const origin of [undefined, 'http://evil.example', 'null', `https://${HOST}`, `http://localhost:${PORT}`]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (origin) headers.origin = origin;
      const res = await req(app, '/api/v1/session', { method: 'POST', headers, body: JSON.stringify({ token: TOKEN }) });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  test('same-origin POST passes (localhost variant too)', async () => {
    const { app } = make();
    const cookie = await cookieFor(app);
    const res = await req(app, '/api/v1/projects/close', { method: 'POST', headers: { cookie, origin: ORIGIN } });
    expect(res.status).toBe(204);
    const host = `localhost:${PORT}`;
    const res2 = await app.request('/api/v1/projects/close', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, cookie },
    });
    expect(res2.status).toBe(204);
  });
});

describe('AT-17 session cookie', () => {
  test('no cookie → 401 UNAUTHORIZED with a hint', async () => {
    const { app } = make();
    const res = await req(app, '/api/v1/health');
    expect(res.status).toBe(401);
    const err = await errorOf(res);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toContain('请使用终端打印的链接，或运行 storyscript-mov open');
  });

  test('wrong token → 401 and no cookie', async () => {
    const { app } = make();
    const res = await login(app, 'x'.repeat(TOKEN.length));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await errorOf(res)).code).toBe('UNAUTHORIZED');
  });

  test('malformed body → 400 VALIDATION_ERROR', async () => {
    const { app } = make();
    const res = await req(app, '/api/v1/session', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  test('forged or foreign session cookie → 401', async () => {
    const { app } = make();
    const other = make();
    const foreign = await cookieFor(other.app);
    for (const cookie of ['ssm_session=forged', foreign, 'ssm_session=']) {
      const res = await req(app, '/api/v1/health', { headers: { cookie } });
      expect(res.status, cookie).toBe(401);
    }
  });

  test('right token → 204 + HttpOnly SameSite=Strict cookie → health 200', async () => {
    const env = { STORYSCRIPT_LLM_BASE_URL: 'https://llm.example/v1', STORYSCRIPT_LLM_API_KEY: 'sk-secret-at17', STORYSCRIPT_LLM_MODEL: 'm' };
    const { app } = make('production', env);
    const res = await login(app);
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ssm_session=[A-Za-z0-9_-]{32,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');

    const health = await req(app, '/api/v1/health', { headers: { cookie: setCookie.split(';')[0]! } });
    expect(health.status).toBe(200);
    const text = await health.text();
    expect(text).not.toContain('sk-secret-at17');
    expect(text).not.toContain(TOKEN);
    const data = HealthInfo.parse(JSON.parse(text).data);
    expect(data.text_provider_configured).toBe(true);
    expect(data.image_provider_configured).toBe(false);
    expect(data.project_open).toBe(false);
    expect(data.node).toBe(process.versions.node);
    expect(data.sqlite).toMatch(/^3\.\d+\.\d+$/);
    expect(data.encoders).toEqual(['h264_videotoolbox']);
  });

  test('percent-encoded /api path cannot bypass the cookie check', async () => {
    const { app } = make();
    const res = await req(app, '/%61pi/v1/health');
    expect(res.status).not.toBe(200);
  });
});

describe('AT-17 response headers', () => {
  test('production: CSP, nosniff, no-referrer on API, errors and static', async () => {
    const { app } = make('production');
    const cookie = await cookieFor(app);
    const responses = [
      await req(app, '/api/v1/health', { headers: { cookie } }),
      await req(app, '/api/v1/health'),
      await app.request('/', { headers: { host: 'evil.example' } }),
      await req(app, '/'),
    ];
    for (const res of responses) {
      expect(res.headers.get('content-security-policy')).toBe(PROD_CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  test('development: CSP allows inline scripts and ws: for Vite HMR', async () => {
    const { app } = make('development');
    const res = await req(app, '/api/v1/health');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws:');
    expect(csp).toContain("object-src 'none'");
  });

  test('no CORS headers, even for preflight', async () => {
    const { app } = make();
    const pre = await req(app, '/api/v1/health', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const get = await req(app, '/api/v1/health', { headers: { origin: 'http://evil.example' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    expect(get.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('static frontend (production)', () => {
  test('serves index.html and assets without a cookie; SPA fallback; missing asset 404', async () => {
    const { app } = make('production');
    const index = await req(app, '/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('id="root"');
    const asset = await req(app, '/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const spa = await req(app, '/boards/some-shot');
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('id="root"');
    expect((await req(app, '/assets/missing.js')).status).toBe(404);
    // traversal never escapes webDir (at worst the SPA shell comes back)
    for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2f..%2fetc%2fpasswd']) {
      const res = await req(app, path);
      expect(await res.text()).not.toContain('root:');
    }
  });

  test('unknown API route → 404 envelope (after auth)', async () => {
    const { app } = make();
    const cookie = await cookieFor(app);
    const res = await req(app, '/api/v1/nope', { headers: { cookie } });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('NOT_FOUND');
  });
});

describe('misc routes behind the guards', () => {
  test('current project without one open → 409 NO_PROJECT_OPEN; choose-folder → {path:null}', async () => {
    const { app } = make();
    const cookie = await cookieFor(app);
    const cur = await req(app, '/api/v1/project', { headers: { cookie } });
    expect(cur.status).toBe(409);
    expect((await errorOf(cur)).code).toBe('NO_PROJECT_OPEN');
    const pick = await req(app, '/api/v1/platform/choose-folder', { method: 'POST', headers: { cookie, origin: ORIGIN } });
    expect(pick.status).toBe(200);
    expect(await pick.json()).toEqual({ data: { path: null } });
  });
});

// ---------------------------------------------------------------------------
// Real node:http server: Host is rejected before Hono/Vite see the request.
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<RawResponse>((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

describe('startServer (real socket)', () => {
  let server: RunningServer;
  let serverHome: string;

  beforeAll(async () => {
    serverHome = join(root, 'server-home');
    server = await startServer({ mode: 'production', port: 0, stateDir: serverHome, webDir, log: () => {} });
  });

  afterAll(async () => {
    await server?.close();
  });

  test('listens on 127.0.0.1, writes runtime.json 0600, prints token link', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/#t=${server.token}`);
    expect(Buffer.from(server.token, 'base64url')).toHaveLength(32);
    const rt = readRuntime(serverHome);
    expect(rt).toMatchObject({ port: server.port, token: server.token, pid: process.pid });
    expect(statSync(join(serverHome, 'runtime.json')).mode & 0o777).toBe(0o600);
  });

  test('forged Host → 403 on API and static; token exchange + health over the wire', async () => {
    const port = server.port;
    expect((await raw(port, '/api/v1/health', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await raw(port, '/', { headers: { host: `evil.example:${port}` } })).status).toBe(403);

    const host = `127.0.0.1:${port}`;
    const ex = await raw(port, '/api/v1/session', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: server.token }),
    });
    expect(ex.status).toBe(204);
    const cookie = String(ex.headers['set-cookie']).split(';')[0]!;
    const health = await raw(port, '/api/v1/health', { headers: { host, cookie } });
    expect(health.status).toBe(200);
    expect(health.headers['content-security-policy']).toBe(PROD_CSP);
    expect((await raw(port, '/api/v1/health', { headers: { host } })).status).toBe(401);
    expect((await raw(port, '/', { headers: { host } })).status).toBe(200);
  });

  test('close() removes runtime.json', async () => {
    const extraHome = join(root, 'server-home-2');
    const s = await startServer({ mode: 'production', port: 0, stateDir: extraHome, webDir, log: () => {} });
    expect(existsSync(join(extraHome, 'runtime.json'))).toBe(true);
    await s.close();
    expect(existsSync(join(extraHome, 'runtime.json'))).toBe(false);
  });
});

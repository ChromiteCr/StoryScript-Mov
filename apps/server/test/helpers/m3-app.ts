import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entity, Job, ScriptFormat, ScriptImportResult } from '@storyscript/contracts';
import { configureAi, type AiOverrides } from '../../src/ai/runtime.ts';
import { createApp, type AppHandle } from '../../src/app.ts';

/**
 * Test harness for M3 routes: a Hono app with a real temp project, a session
 * cookie and a tiny JSON client. No sockets are opened (app.request).
 */

export const PORT = 43203;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const TOKEN = 'm3-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF';

export const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'scripts');
export const REPLAY_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'replay');
export const TEST_KEY = 'sk-test-SECRET-9f8e7d6c5b4a3210';

export interface ApiResult<T = unknown> {
  status: number;
  body: { data?: T; error?: { code: string; message: string; details?: unknown; retryable: boolean }; notice?: string };
  data: T;
  text: string;
}

export interface M3App {
  handle: AppHandle;
  root: string;
  stateDir: string;
  projectDir: string;
  get<T = unknown>(path: string): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  /** any body and headers, with this app's Host, Origin and session cookie */
  raw(method: string, path: string, body?: RequestInit['body'], headers?: Record<string, string>): Promise<Response>;
  close(): void;
}

export function llmEnv(baseUrl: string, model = 'fake-model', key = TEST_KEY): NodeJS.ProcessEnv {
  return { STORYSCRIPT_LLM_BASE_URL: baseUrl, STORYSCRIPT_LLM_API_KEY: key, STORYSCRIPT_LLM_MODEL: model };
}

export async function makeM3App(opts: { env?: NodeJS.ProcessEnv; demo?: boolean; ai?: AiOverrides; openProject?: boolean } = {}): Promise<M3App> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ssm-m3-')));
  const stateDir = join(root, 'home');
  const handle = createApp({
    mode: 'production',
    port: PORT,
    token: TOKEN,
    webDir: join(root, 'no-web'),
    stateDir,
    env: opts.env ?? {},
    demo: opts.demo ?? false,
    tools: async () => ({ ffmpeg: { path: null, version: null }, ffprobe: { path: null, version: null }, h264_encoders: [] }),
  });
  configureAi(handle.deps, { backoffMs: 0, ...opts.ai });

  const session = await handle.app.request('/api/v1/session', {
    method: 'POST',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]!;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> => {
    const res = await handle.app.request(path, {
      method,
      headers: { host: HOST, origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as ApiResult<T>['body']) : {};
    return { status: res.status, body: parsed, data: parsed.data as T, text };
  };

  const projectDir = join(root, 'project');
  const app: M3App = {
    handle,
    root,
    stateDir,
    projectDir,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    raw: async (method, p, body, headers = {}) => handle.app.request(p, { method, body, headers: { host: HOST, origin: ORIGIN, cookie, ...headers } }),
    close: () => {
      handle.projectSession.closeNow();
      rmSync(root, { recursive: true, force: true });
    },
  };
  if (opts.openProject !== false) {
    const created = await app.post('/api/v1/projects', {
      dir: projectDir,
      name: '测试项目',
      timezone: 'Asia/Shanghai',
      default_aspect: '2.39',
      target_duration_s: null,
    });
    if (created.status !== 201) throw new Error(`project create failed: ${created.text}`);
  }
  return app;
}

export function fixtureText(file: string): string {
  return readFileSync(join(FIXTURES, file), 'utf8');
}

export async function importFixture(app: M3App, file: string, format: ScriptFormat, text = fixtureText(file)) {
  const res = await app.post<ScriptImportResult>('/api/v1/scripts', { text, source_name: file, format, heading_overrides: [] });
  if (res.status !== 201) throw new Error(`import failed: ${res.text}`);
  return res.data;
}

/** c1 周明远（老周）, c2 林晓 — the roster the 01-bookshop recordings use. */
export async function bookshopRoster(app: M3App): Promise<Entity[]> {
  const a = await app.post<Entity>('/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] });
  const b = await app.post<Entity>('/api/v1/entities', { type: 'character', name: '林晓', aliases: [] });
  return [a.data, b.data];
}

export function replayOutput(name: string): unknown {
  return (JSON.parse(readFileSync(join(REPLAY_DIR, name), 'utf8')) as { output_json: unknown }).output_json;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown']);

/** Poll GET /jobs/:id like the frontend does, until the job is terminal. */
export async function waitJob(app: M3App, id: string, timeoutMs = 15_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const res = await app.get<Job>(`/api/v1/jobs/${id}`);
    if (res.status !== 200) throw new Error(`job poll failed: ${res.text}`);
    if (TERMINAL.has(res.data.status)) return res.data;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${id} still ${res.data.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const BREAKDOWN_REQUEST = { technique_id: null, reference_note: null, max_shots: 16, target_seconds: null };

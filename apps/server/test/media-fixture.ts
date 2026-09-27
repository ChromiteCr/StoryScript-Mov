import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, ScriptImportResult, Shot, ShotFields } from '@storyscript/contracts';
import { createApp, type AppHandle } from '../src/app.ts';
import { locateTool } from '../src/adapters/media/ffmpeg.ts';
import type { ToolsInfo } from '../src/diagnostics.ts';

/**
 * Harness for the M6 media tests (AT-10…13, AT-17 media): real temp project,
 * session cookie, JSON client plus a raw client for the binary routes. An app
 * can be closed and a fresh one opened on the same project dir ("restart").
 */

export const PORT = 43206;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const TOKEN = 'm6-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF';

export const FFMPEG = locateTool('ffmpeg');
export const FFPROBE = locateTool('ffprobe');
export const HAS_FFMPEG = Boolean(FFMPEG && FFPROBE);

export const REAL_TOOLS: ToolsInfo = {
  ffmpeg: { path: FFMPEG, version: null },
  ffprobe: { path: FFPROBE, version: null },
  h264_encoders: [],
};
export const NO_TOOLS: ToolsInfo = { ffmpeg: { path: null, version: null }, ffprobe: { path: null, version: null }, h264_encoders: [] };

export interface ApiResult<T = unknown> {
  status: number;
  body: { data?: T; error?: { code: string; message: string; details?: unknown; retryable: boolean } };
  data: T;
  text: string;
}

export interface MediaApp {
  handle: AppHandle;
  get<T = unknown>(path: string): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  /** raw GET with the session cookie (binary routes) */
  raw(path: string, headers?: Record<string, string>): Promise<Response>;
  /** raw GET without any cookie */
  anonymous(path: string): Promise<Response>;
  /** close the project and drop the app (the directory stays) */
  shutdown(): void;
}

export interface Workspace {
  /** temp root holding home/, project/, sources */
  root: string;
  stateDir: string;
  /** the project folder */
  projectDir: string;
  /** its data folder (.storyscript-mov: database, derivatives, boards …) */
  dataDir: string;
  cleanup(): void;
}

export function makeWorkspace(prefix = 'ssm-m6-'): Workspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    stateDir: join(root, 'home'),
    projectDir: join(root, 'project'),
    dataDir: join(root, 'project', '.storyscript-mov'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Start an app on the workspace; creates the project (first run) or opens it (restart). */
export async function startApp(ws: Workspace, opts: { create: boolean; tools?: ToolsInfo }): Promise<MediaApp> {
  const handle = createApp({
    mode: 'production',
    port: PORT,
    token: TOKEN,
    webDir: join(ws.root, 'no-web'),
    stateDir: ws.stateDir,
    env: {},
    tools: async () => opts.tools ?? REAL_TOOLS,
  });
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

  const app: MediaApp = {
    handle,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    raw: (p, headers = {}) => Promise.resolve(handle.app.request(p, { method: 'GET', headers: { host: HOST, cookie, ...headers } })),
    anonymous: (p) => Promise.resolve(handle.app.request(p, { method: 'GET', headers: { host: HOST } })),
    shutdown: () => handle.projectSession.closeNow(),
  };

  const res = opts.create
    ? await app.post('/api/v1/projects', {
        dir: ws.projectDir,
        name: '素材测试',
        timezone: 'Asia/Shanghai',
        default_aspect: '2.39',
        target_duration_s: null,
      })
    : await app.post('/api/v1/projects/open', { dir: ws.projectDir });
  if (res.status !== 200 && res.status !== 201) throw new Error(`project ${opts.create ? 'create' : 'open'} failed: ${res.text}`);
  return app;
}

/** Two scenes; the paragraphs are only anchors for manual shots. */
export const SCRIPT_TEXT = ['1. 内景 书店 日', '', '店主整理书架。', '', '年轻人推门进来。', '', '2. 外景 街道 夜', '', '年轻人在雨里奔跑。', ''].join('\n');

export const BASE_FIELDS: ShotFields = {
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
  narrative_purpose: '测试镜头',
  action: '测试动作',
  dialogue_quote: null,
  source: { paragraph_id: 'p-001', quote: '' },
  assumptions: [],
  questions: [],
};

export interface Seeded {
  scenes: ScriptImportResult['scenes'];
  /** scene 1: codes 001, 002, 003; scene 2: 001 */
  s1: Shot[];
  s2: Shot[];
}

export async function seedShots(app: MediaApp): Promise<Seeded> {
  const imp = await app.post<ScriptImportResult>('/api/v1/scripts', {
    text: SCRIPT_TEXT,
    source_name: 'm6.txt',
    format: 'txt',
    heading_overrides: [],
  });
  if (imp.status !== 201) throw new Error(`script import failed: ${imp.text}`);
  const scenes = imp.data.scenes;
  const make = async (sceneIndex: number, code: string, action: string) => {
    const r = await app.post<Shot>('/api/v1/shots', {
      scene_id: scenes[sceneIndex]!.id,
      fields: { ...BASE_FIELDS, action },
      manual_note: '测试用手工镜头',
      code,
    });
    if (r.status !== 201) throw new Error(`shot create failed: ${r.text}`);
    return r.data;
  };
  const s1 = [await make(0, '001', '店主整理书架'), await make(0, '002', '年轻人推门'), await make(0, '003', '两人对视')];
  const s2 = [await make(1, '001', '雨中奔跑')];
  return { scenes, s1, s2 };
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown']);

export async function waitJob(app: MediaApp, id: string, timeoutMs = 60_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const res = await app.get<Job>(`/api/v1/jobs/${id}`);
    if (res.status !== 200) throw new Error(`job poll failed: ${res.text}`);
    if (TERMINAL.has(res.data.status)) return res.data;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${id} still ${res.data.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Add a root and run a scan to completion. */
export async function addAndScan(app: MediaApp, dir: string, label?: string): Promise<{ rootId: string; job: Job }> {
  const r = await app.post<{ id: string }>('/api/v1/media/roots', { abs_path: dir, ...(label ? { label } : {}) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`add root failed: ${r.text}`);
  const scan = await app.post<{ job_id: string }>(`/api/v1/media/roots/${r.data.id}/scan`);
  if (scan.status !== 202) throw new Error(`scan failed: ${scan.text}`);
  const job = await waitJob(app, scan.data.job_id);
  return { rootId: r.data.id, job };
}

/** name → size:mtime:sha256 of every entry (recursively), to prove a folder did not change. */
export async function snapshotDir(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    const key = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await snapshotDir(p, key));
    else if (e.isSymbolicLink()) out[key] = 'symlink';
    else {
      const s = await stat(p);
      out[key] = `${s.size}:${s.mtimeMs}:${createHash('sha256').update(await readFile(p)).digest('hex')}`;
    }
  }
  return out;
}

export async function sha256File(p: string): Promise<string> {
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

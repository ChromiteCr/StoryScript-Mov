import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CameraAngle,
  Entity,
  Facing,
  Job,
  RequiredStatus,
  Resource,
  ResourceType,
  Scene,
  Setup,
  SetupDurations,
  Shot,
  ShotFields,
  TimeWindow,
} from '@storyscript/contracts';
import { localToUtc, localWindowToUtc } from '@storyscript/core';
import { configureAi, type AiOverrides } from '../../src/ai/runtime.ts';
import { createApp, type AppHandle } from '../../src/app.ts';
import { fixtureText, type ApiResult } from './m3-app.ts';

/**
 * Test harness for M5 plan routes: a Hono app over a real temp project
 * (Asia/Shanghai), a session cookie and a JSON client with DELETE. Seeding
 * helpers build scenes from the 01-bookshop fixture, a two-character roster
 * and manual shots with chosen camera buckets.
 */

export const PORT = 43205;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const TOKEN = 'm5-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF';

export const TZ = 'Asia/Shanghai';
export const DAY = '2026-10-05';

/** Local HH:mm on the shooting day → UTC ISO. */
export const L = (hhmm: string, date = DAY) => localToUtc(date, hhmm, TZ);
/** Local window on the shooting day (end ≤ start → next day). */
export const W = (start: string, end: string, date = DAY): TimeWindow => localWindowToUtc(date, start, end, TZ);

export interface PlanApp {
  handle: AppHandle;
  get<T = unknown>(path: string): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  del<T = unknown>(path: string): Promise<ApiResult<T>>;
  close(): void;
}

export async function makePlanApp(opts: { env?: NodeJS.ProcessEnv; demo?: boolean; ai?: AiOverrides } = {}): Promise<PlanApp> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ssm-m5-')));
  const handle = createApp({
    mode: 'production',
    port: PORT,
    token: TOKEN,
    webDir: join(root, 'no-web'),
    stateDir: join(root, 'home'),
    env: opts.env ?? {},
    demo: opts.demo ?? false,
    tools: async () => ({ ffmpeg: { path: null, version: null }, ffprobe: { path: null, version: null }, h264_encoders: [] }),
  });
  configureAi(handle.deps, { backoffMs: 0, sleep: async () => undefined, ...opts.ai });

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

  const app: PlanApp = {
    handle,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    del: (p) => call('DELETE', p),
    close: () => {
      handle.projectSession.closeNow();
      rmSync(root, { recursive: true, force: true });
    },
  };
  const created = await app.post('/api/v1/projects', {
    dir: join(root, 'project'),
    name: '排期测试',
    timezone: TZ,
    default_aspect: '2.39',
    target_duration_s: null,
  });
  if (created.status !== 201) throw new Error(`project create failed: ${created.text}`);
  return app;
}

async function ok<T>(p: Promise<ApiResult<T>>, status = 200): Promise<T> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${r.text}`);
  return r.data;
}

export const expectOk = ok;

export interface World {
  scenes: Scene[];
  /** c1 周明远, c2 林晓 */
  c1: Entity;
  c2: Entity;
  shop: Entity;
  backroom: Entity;
}

/** Scenes 1 and 2 of 01-bookshop, two characters, two location entities mapped onto the scenes. */
export async function seedWorld(app: PlanApp): Promise<World> {
  const imported = await ok<{ scenes: Scene[] }>(
    app.post('/api/v1/scripts', { text: fixtureText('01-bookshop.txt'), source_name: '01-bookshop.txt', format: 'txt', heading_overrides: [] }),
    201,
  );
  const c1 = await ok<Entity>(app.post('/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] }), 201);
  const c2 = await ok<Entity>(app.post('/api/v1/entities', { type: 'character', name: '林晓', aliases: [] }), 201);
  const shop = await ok<Entity>(app.post('/api/v1/entities', { type: 'location', name: '旧书店', aliases: [] }), 201);
  const backroom = await ok<Entity>(app.post('/api/v1/entities', { type: 'location', name: '旧书店后屋', aliases: [] }), 201);
  await ok(app.patch(`/api/v1/scenes/${imported.scenes[0]!.id}`, { location_entity_id: shop.id }));
  await ok(app.patch(`/api/v1/scenes/${imported.scenes[1]!.id}`, { location_entity_id: backroom.id }));
  return { scenes: imported.scenes, c1, c2, shop, backroom };
}

export function fields(scene: Scene, o: { subjects?: { alias: string; facing: Facing | null }[]; angle?: CameraAngle; action?: string } = {}): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: o.angle ?? 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: (o.subjects ?? []).map((s) => ({ alias: s.alias, screen: null, depth: null, facing: s.facing, pose: null })),
    props: [],
    env: 'interior',
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 5,
    narrative_purpose: '测试用镜头',
    action: o.action ?? '人物在店里走动',
    dialogue_quote: null,
    source: { paragraph_id: scene.paragraph_ids[0]!, quote: '' },
    assumptions: [],
    questions: [],
  };
}

export async function makeShot(
  app: PlanApp,
  scene: Scene,
  o: Parameters<typeof fields>[1] & { required?: RequiredStatus } = {},
): Promise<Shot> {
  let shot = await ok<Shot>(app.post('/api/v1/shots', { scene_id: scene.id, fields: fields(scene, o), manual_note: '测试' }), 201);
  if (o.required && o.required !== 'required') {
    shot = await ok<Shot>(
      app.post(`/api/v1/shots/${shot.id}/requirement`, { expected_revision: shot.revision, required_status: o.required, reason: '测试' }),
    );
  }
  return shot;
}

export async function makeResource(
  app: PlanApp,
  type: ResourceType,
  name: string,
  windows: TimeWindow[],
  cast: string[] = [],
  confirmed = true,
): Promise<Resource> {
  return ok<Resource>(app.post('/api/v1/resources', { type, name, windows, cast_character_ids: cast, confirmed }), 201);
}

export const DUR: SetupDurations = { setup_min: 20, per_shot_min: 15, reset_min: 10 };

export async function makeSetup(
  app: PlanApp,
  label: string,
  shotIds: string[],
  o: { location?: string | null; durations?: SetupDurations; confirmed?: boolean; resources?: string[] } = {},
): Promise<Setup> {
  return ok<Setup>(
    app.post('/api/v1/setups', {
      location_resource_id: o.location ?? null,
      label,
      shot_ids: shotIds,
      resource_ids: o.resources ?? [],
      durations: o.durations ?? DUR,
      estimate_confirmed: o.confirmed ?? true,
    }),
    201,
  );
}

export const shotsNow = (app: PlanApp) => ok<Shot[]>(app.get('/api/v1/shots'));

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown']);

/** Poll GET /jobs/:id like the frontend does, until the job is terminal. */
export async function waitJob(app: PlanApp, id: string, timeoutMs = 15_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const job = await ok<Job>(app.get(`/api/v1/jobs/${id}`));
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${id} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

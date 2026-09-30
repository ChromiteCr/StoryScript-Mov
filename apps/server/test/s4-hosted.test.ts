import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ActorRef, BoardSpec, Job, Scene, Shot } from '@storyscript/contracts';
import { createApp } from '../src/app.ts';
import { EgressBlockedError } from '../src/security/egress.ts';
import { hashInvite, HostedLimits, teamDir, writeHostedConfig, type HostedConfig } from '../src/hosted/config.ts';
import type { MailMessage, Mailer } from '../src/hosted/mail/mailer.ts';
import { SiteDb } from '../src/hosted/site-db.ts';
import { startHostedServer, type HostedServer } from '../src/hosted/start.ts';
import { ProjectSession } from '../src/project/session.ts';
import { reply, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { fixtureText } from './helpers/m3-app.ts';
import { DUR, fields, W } from './helpers/plan-app.ts';

/**
 * S4 on the hosted server, through the real gateway: who is asking comes only
 * from the gateway (never from a header or body a browser sends); crew roles;
 * no teammate ever sees an email; history rows name their maker; the group's
 * model is the leader's to change; each member may use their own model in a
 * group; the daily cap protects only the group's key; site.db v2 → v3.
 *
 * Model services are reached through a fake transport: the hosted instances
 * only speak public https, so every instance created in this file gets a
 * `fetch` that rewrites the (invented, unresolvable) host to a local fake
 * OpenAI-compatible service and records which host each call was meant for.
 */

const routing = vi.hoisted(() => {
  const state = { origin: '', calls: [] as { host: string; path: string }[], failWith: null as ((host: string) => Error | null) | null };
  const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    state.calls.push({ host: u.host, path: u.pathname });
    const failure = state.failWith?.(u.host);
    if (failure) throw failure;
    const target = `${state.origin}${u.pathname}${u.search}`;
    return input instanceof Request ? globalThis.fetch(new Request(target, input), init) : globalThis.fetch(target, init);
  }) as typeof fetch;
  return { state, routedFetch };
});

vi.mock('../src/app.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/app.ts')>();
  return {
    ...real,
    createApp: (opts: Parameters<typeof real.createApp>[0]) => real.createApp(opts.hosted && !opts.fetch ? { ...opts, fetch: routing.routedFetch } : opts),
  };
});

const PUBLIC = 'https://story.example.test';
const INVITE = 'sdsz-Test';
const A_EMAIL = 'alice-secret@crew-mail.test';
const B_EMAIL = 'bob-secret@crew-mail.test';
const GROUP_KEY = 'sk-group-A-1111';
const OWN_KEY = 'sk-own-B-9999';
const GROUP_BASE = 'https://group-llm.example.invalid/v1';
const OWN_BASE = 'https://own-b.example.invalid/v1';

let data = '';
let server: HostedServer | null = null;
let sent: MailMessage[] = [];
let clock = Date.parse('2026-09-28T08:00:00.000Z');
let fake: FakeOpenAI;
/** every response body each signed-in browser received */
let seen = new Map<string, string[]>();
const now = () => clock;
const mailer: Mailer = {
  kind: 'outbox',
  async send(m) {
    sent.push(m);
  },
};

function config(limits: Partial<HostedLimits> = {}): HostedConfig {
  return {
    format: 'storyscript-mov-server',
    version: 2,
    site_name: '学校短片节',
    public_origin: PUBLIC,
    listen_host: '127.0.0.1',
    port: 4700,
    timezone: 'Asia/Shanghai',
    invite_sha256: hashInvite(INVITE),
    mail: { from: 'StoryScript-Mov <noreply@story.example.test>' },
    limits: HostedLimits.parse(limits),
  };
}

const start = async () => {
  server = await startHostedServer({ dataDir: data, port: 0, webDir: join(data, 'no-web'), log: () => undefined, mailer, now });
  return server;
};

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const port = server!.port;
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET') headers.origin = `http://127.0.0.1:${port}`;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => {
        if (opts.cookie) seen.set(opts.cookie, [...(seen.get(opts.cookie) ?? []), body]);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieOf = (r: Res) => ([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;

function lastCode(email: string): string {
  const m = [...sent].reverse().find((x) => x.to === email);
  const code = m && /验证码：(\d{6})/.exec(m.text)?.[1];
  if (!code) throw new Error(`no code mailed to ${email}`);
  return code;
}

async function register(email: string, name: string): Promise<string> {
  const a = await call('POST', '/api/v1/account/register/code', { body: { email, invite: INVITE } });
  expect(a.status, a.body).toBe(204);
  const r = await call('POST', '/api/v1/account/register', { body: { email, code: lastCode(email), name, password: 'password-1' } });
  expect(r.status, r.body).toBe(204);
  clock += 61_000;
  return cookieOf(r);
}

/** expect a status and return `data` */
async function ok<T = any>(p: Promise<Res>, status = 200): Promise<T> {
  const r = await p;
  expect(r.status, r.body).toBe(status);
  return (r.body ? r.json().data : undefined) as T;
}

interface World {
  a: string;
  b: string;
  aId: string;
  bId: string;
  slug: string;
  code: string;
}

/** A (阿杰) starts the group and leads it; B (阿丽) joins with the code. */
async function world(): Promise<World> {
  await start();
  const a = await register(A_EMAIL, '阿杰');
  const b = await register(B_EMAIL, '阿丽');
  const g = await ok<{ slug: string; join_code: string; members: { id: string }[] }>(call('POST', '/api/v1/groups', { cookie: a, body: { name: '一组' } }), 201);
  const joined = await ok<{ members: { id: string; you: boolean }[] }>(call('POST', '/api/v1/groups/join', { cookie: b, body: { code: g.join_code } }));
  return { a, b, aId: g.members[0]!.id, bId: joined.members.find((m) => m.you)!.id, slug: g.slug, code: g.join_code };
}

const setRoles = (w: World, cookie: string, memberId: string, crew_roles: unknown) =>
  call('PUT', `/api/v1/groups/${w.slug}/members/${memberId}/crew-roles`, { cookie, body: { crew_roles } });
const choose = (w: World, cookie: string, choice: object) => call('PUT', `/api/v1/groups/${w.slug}/model-choice`, { cookie, body: choice });
const refOf = (id: string, name: string, crew_roles: string[], left = false): ActorRef => ({ id, name, crew_roles, left });

const saveGroupText = (cookie: string, base_url = GROUP_BASE, api_key = GROUP_KEY, model = 'group-model') =>
  call('PUT', '/api/v1/settings/providers/text', { cookie, body: { base_url, model, api_key } });
const saveOwnText = (cookie: string, base_url = OWN_BASE, api_key = OWN_KEY, model = 'own-model') =>
  call('PUT', '/api/v1/settings/providers/me/text', { cookie, body: { base_url, model, api_key } });

const SCRIPT = () => ({ text: fixtureText('01-bookshop.txt'), source_name: '01-bookshop.txt', format: 'txt', heading_overrides: [] });
const ENTITIES = { characters: [{ name: '周明远', aliases: ['老周'] }], locations: [{ name: '旧书店', aliases: [] }], props: [] };

async function importScript(cookie: string): Promise<{ scenes: Scene[]; version: { id: string } }> {
  return ok(call('POST', '/api/v1/scripts', { cookie, body: SCRIPT() }), 201);
}

async function waitJob(cookie: string, id: string): Promise<Job> {
  for (let i = 0; i < 1500; i++) {
    const j = await ok<Job>(call('GET', `/api/v1/jobs/${id}`, { cookie }));
    if (['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not finish`);
}

/** POST /entities/extract and wait for the job (fake service must have a reply queued unless the request is refused). */
async function extract(cookie: string): Promise<{ status: number; res: Res; job?: Job }> {
  const res = await call('POST', '/api/v1/entities/extract', { cookie, body: {} });
  if (res.status !== 202) return { status: res.status, res };
  return { status: 202, res, job: await waitJob(cookie, res.json().data.job_id) };
}

const chatCalls = () => fake.chatRequests();

/** Every file under a folder, as one binary-ish string (to search for things that must not be there). */
function everythingUnder(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? everythingUnder(p) : readFileSync(p).toString('latin1');
  }
  return out;
}

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'ssm-s4-'));
  writeHostedConfig(data, config());
  sent = [];
  seen = new Map();
  clock = Date.parse('2026-09-28T08:00:00.000Z');
  fake = await startFakeOpenAI();
  fake.models = ['group-model', 'own-model'];
  routing.state.origin = new URL(fake.url).origin;
  routing.state.calls.length = 0;
  routing.state.failWith = null;
});
afterEach(async () => {
  await server?.close();
  server = null;
  await fake.close();
  rmSync(data, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('S4 identity comes only from the gateway', () => {
  test("invented headers and body fields cannot change who the instance thinks the caller is", async () => {
    const w = await world();
    const { scenes } = await importScript(w.a);
    const scene = scenes[0]!;
    const forged = {
      'x-actor': w.aId,
      'x-actor-id': w.aId,
      'x-ssm-actor-id': w.aId,
      'x-ssm-actor': JSON.stringify({ id: w.aId, name: 'A', role: 'leader', crew_roles: [] }),
      'x-forwarded-user': w.aId,
      'x-hosted-actor': w.aId,
      'x-account-id': w.aId,
    };

    // B creates a shot while pretending to be A, in headers and in the body
    const created = await call('POST', '/api/v1/shots', {
      cookie: w.b,
      headers: forged,
      body: { scene_id: scene.id, fields: fields(scene, { action: '乙冒充' }), manual_note: '乙', actor_id: w.aId, actor: refOf(w.aId, '阿杰', ['导演']), created_by: w.aId },
    });
    // either the extra body fields are ignored (201) or refused (400): never believed
    expect([201, 400], created.body).toContain(created.status);
    let shot: Shot;
    if (created.status === 201) shot = created.json().data;
    else shot = await ok<Shot>(call('POST', '/api/v1/shots', { cookie: w.b, headers: forged, body: { scene_id: scene.id, fields: fields(scene, { action: '乙冒充' }), manual_note: '乙' } }), 201);
    const edited = await call('PATCH', `/api/v1/shots/${shot.id}`, {
      cookie: w.b,
      headers: forged,
      body: { expected_revision: 0, fields: fields(scene, { action: '乙再改' }) },
    });
    expect(edited.status, edited.body).toBe(200);

    const revs = await ok<{ revision: number; actor: ActorRef }[]>(call('GET', `/api/v1/shots/${shot.id}/revisions`, { cookie: w.a }));
    expect(revs.map((r) => r.actor.id)).toEqual([w.bId, w.bId]);
    expect(revs.map((r) => r.actor.name)).toEqual(['阿丽', '阿丽']);
    // and the leader's powers did not travel with the forged headers
    const noLeader = await call('PUT', '/api/v1/settings/providers/text', {
      cookie: w.b,
      headers: { ...forged, 'x-actor-role': 'leader' },
      body: { base_url: GROUP_BASE, model: 'm', api_key: 'k' },
    });
    expect(noLeader.status).toBe(403);
    expect((await call('PUT', `/api/v1/groups/${w.slug}/members/${w.aId}/crew-roles`, { cookie: w.b, headers: forged, body: { crew_roles: ['导演'] } })).status).toBe(403);
  });

  test('a group instance called directly, without what the gateway puts in env, answers 401', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ssm-s4-direct-'));
    try {
      const { app } = createApp({
        mode: 'production',
        port: 4700,
        token: 'x'.repeat(40),
        webDir: join(stateDir, 'no-web'),
        stateDir,
        env: {},
        projectSession: new ProjectSession(stateDir, { projectRoot: false }),
        hosted: { slug: 'gdirect1', name: '直连组', limits: null },
      });
      const get = (path: string, init: RequestInit = {}, env?: unknown) => app.fetch(new Request(`http://127.0.0.1:4700${path}`, init), env as never);

      expect((await get('/api/v1/health')).status).toBe(401);
      expect((await get('/api/v1/health', {}, {})).status).toBe(401);
      // headers and the query string are not identity
      expect((await get('/api/v1/health?hosted=1&actor=acc-x', { headers: { 'x-actor': 'acc-x', 'x-ssm-actor-id': 'acc-x', authorization: 'Bearer x' } })).status).toBe(401);
      expect((await get('/api/v1/shots', { headers: { 'x-actor': 'acc-x' } })).status).toBe(401);
      // an env that is not what the gateway builds is not accepted either
      expect((await get('/api/v1/health', {}, { hosted: 'yes' })).status).toBe(401);
      expect((await get('/api/v1/health', {}, { hosted: { actor: { id: 'acc-x', name: 'x', role: 'leader', crew_roles: [], text_source: 'group', image_source: 'group' } } })).status).toBe(401);
      expect((await get('/api/v1/health', {}, { hosted: { actor: { id: 'acc-x' }, roster: 'x', personalDir: stateDir } })).status).toBe(401);

      // control: with a complete env from the gateway the same request works
      const good = {
        hosted: {
          actor: { id: 'acc-x', name: '某人', role: 'member', crew_roles: [], text_source: 'group', image_source: 'group' },
          roster: () => [{ id: 'acc-x', name: '某人', role: 'member', crew_roles: [] }],
          personalDir: join(stateDir, 'me'),
        },
      };
      const health = await get('/api/v1/health', {}, good);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { data: unknown }).data).toMatchObject({ hosted: true, text_model_source: 'group' });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('a browser cannot reach a group instance without a session, or one it is not a member of', async () => {
    const w = await world();
    const c = await register('carol-secret@crew-mail.test', '阿卡');
    expect((await call('GET', '/api/v1/shots', { headers: { 'x-actor': w.aId } })).status).toBe(401);
    // a signed-in account with no group is told so; it does not fall into someone else's group
    const none = await call('GET', '/api/v1/shots', { cookie: c, headers: { 'x-actor': w.aId, 'x-ssm-team': w.slug } });
    expect(none.status).toBe(409);
    expect(none.json().error.code).toBe('NO_TEAM');
    expect((await call('PUT', `/api/v1/groups/${w.slug}/members/${w.bId}/crew-roles`, { cookie: c, body: { crew_roles: ['剪辑'] } })).status).toBe(404);
    expect((await call('PUT', `/api/v1/groups/${w.slug}/model-choice`, { cookie: c, body: { text: 'own' } })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('S4 crew roles', () => {
  test('a member sets their own; the group view shows them to everyone', async () => {
    const w = await world();
    const view = await ok<{ members: { id: string; crew_roles: string[] }[] }>(setRoles(w, w.b, w.bId, ['摄影', '剪辑']));
    expect(view.members.find((m) => m.id === w.bId)!.crew_roles).toEqual(['摄影', '剪辑']);
    expect(view.members.find((m) => m.id === w.aId)!.crew_roles).toEqual([]);

    const seenByA = (await ok(call('GET', '/api/v1/account', { cookie: w.a }))).group.members;
    expect(seenByA.map((m: { name: string; crew_roles: string[] }) => [m.name, m.crew_roles])).toEqual([
      ['阿杰', []],
      ['阿丽', ['摄影', '剪辑']],
    ]);
    // every group of the account lists them too
    expect((await ok(call('GET', '/api/v1/account', { cookie: w.a }))).groups[0].members[1].crew_roles).toEqual(['摄影', '剪辑']);
  });

  test('only the member or the leader may change them; a leader can also clear them', async () => {
    const w = await world();
    expect((await setRoles(w, w.b, w.aId, ['导演'])).status).toBe(403);
    const forbidden = await setRoles(w, w.b, w.aId, ['导演']);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');

    const byLeader = await ok<{ members: { id: string; crew_roles: string[] }[] }>(setRoles(w, w.a, w.bId, ['场记']));
    expect(byLeader.members.find((m) => m.id === w.bId)!.crew_roles).toEqual(['场记']);
    // the leader's own too
    expect((await ok<any>(setRoles(w, w.a, w.aId, ['导演', '制片']))).members[0].crew_roles).toEqual(['导演', '制片']);
    // nobody else's roles moved
    expect((await ok<any>(setRoles(w, w.a, w.bId, []))).members[1].crew_roles).toEqual([]);
    expect((await ok<any>(call('GET', '/api/v1/account', { cookie: w.b }))).group.members[0].crew_roles).toEqual(['导演', '制片']);
    // an id that is not in the group
    expect((await setRoles(w, w.a, '00000000-0000-4000-8000-00000000dead', ['导演'])).status).toBe(404);
  });

  test.each([
    ['a space inside', ['有 空格']],
    ['an @', ['@导演']],
    ['nine characters', ['一二三四五六七八九']],
    ['seven roles', ['一', '二', '三', '四', '五', '六', '七']],
    ['a comma', ['导演,摄影']],
    ['a full-width comma', ['导演，摄影']],
    ['a blank role', ['  ']],
    ['an empty string', ['']],
    ['not an array', '导演'],
    ['a number', [1]],
  ])('%s is refused with 400 and nothing changes', async (_name, roles) => {
    const w = await world();
    await ok(setRoles(w, w.b, w.bId, ['摄影']));
    const r = await setRoles(w, w.b, w.bId, roles);
    expect(r.status, r.body).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
    expect((await ok<any>(call('GET', '/api/v1/account', { cookie: w.b }))).group.members[1].crew_roles).toEqual(['摄影']);
    expect((await call('PUT', `/api/v1/groups/${w.slug}/members/${w.bId}/crew-roles`, { cookie: w.b, body: {} })).status).toBe(400);
  });

  test('duplicates collapse, edges are trimmed, six roles of up to eight characters are fine, and it survives a restart', async () => {
    const w = await world();
    const view = await ok<any>(setRoles(w, w.b, w.bId, ['摄影', '摄影', ' 剪辑 ', '摄影', '一二三四五六七八', '灯光']));
    expect(view.members[1].crew_roles).toEqual(['摄影', '剪辑', '一二三四五六七八', '灯光']);
    expect((await ok<any>(setRoles(w, w.b, w.bId, ['一', '二', '三', '四', '五', '六']))).members[1].crew_roles).toHaveLength(6);
    await ok(setRoles(w, w.b, w.bId, ['摄影', '剪辑']));

    await server!.close();
    await start();
    expect((await ok<any>(call('GET', '/api/v1/account', { cookie: w.a }))).group.members[1].crew_roles).toEqual(['摄影', '剪辑']);
  });

  test("a member's roles are shown on their old history rows when they change", async () => {
    const w = await world();
    const { scenes } = await importScript(w.a);
    const shot = await ok<Shot>(call('POST', '/api/v1/shots', { cookie: w.b, body: { scene_id: scenes[0]!.id, fields: fields(scenes[0]!), manual_note: '乙建' } }), 201);
    const rolesOfRevision = async () => (await ok<{ actor: ActorRef }[]>(call('GET', `/api/v1/shots/${shot.id}/revisions`, { cookie: w.a })))[0]!.actor.crew_roles;
    expect(await rolesOfRevision()).toEqual([]);
    await ok(setRoles(w, w.b, w.bId, ['摄影']));
    // the project learns of the change on B's next request
    await ok(call('GET', '/api/v1/shots', { cookie: w.b }));
    expect(await rolesOfRevision()).toEqual(['摄影']);
  });
});

// ---------------------------------------------------------------------------

describe('S4 what a teammate can see: no email, anywhere', () => {
  test('the account, group, project, history, jobs and settings JSON of one member never contain the other member’s email', async () => {
    const w = await world();
    await ok(setRoles(w, w.a, w.aId, ['导演']));
    await ok(setRoles(w, w.b, w.bId, ['摄影']));
    await ok(saveGroupText(w.a));
    await ok(saveOwnText(w.b));
    const { scenes } = await importScript(w.a);
    const scene = scenes[0]!;
    const shot = await ok<Shot>(call('POST', '/api/v1/shots', { cookie: w.a, body: { scene_id: scene.id, fields: fields(scene), manual_note: '甲建' } }), 201);
    await ok(call('PATCH', `/api/v1/shots/${shot.id}`, { cookie: w.b, body: { expected_revision: 0, fields: fields(scene, { action: '乙改' }) } }));
    await ok(call('POST', '/api/v1/takes', { cookie: w.b, body: { setup_id: null, camera_label: 'A', rating: 'good', clip_hint: null, notes: '', shot_ids: [shot.id], unresolved_labels: [] } }), 201);
    await ok(call('POST', `/api/v1/shots/${shot.id}/coverage-decisions`, { cookie: w.a, body: { decision: 'needs_pickup', selected_link_ids: [], reason: '补拍' } }), 201);

    // a job in flight, so the active-jobs list has a row that names its starter
    fake.enqueue(reply.hang());
    const started = await ok<{ job_id: string }>(call('POST', '/api/v1/entities/extract', { cookie: w.b, body: {} }), 202);
    await fake.waitForHang();
    const active = await ok<Job[]>(call('GET', '/api/v1/jobs', { cookie: w.a }));
    expect(active.map((j) => [j.id, j.actor?.name])).toEqual([[started.job_id, '阿丽']]);
    await ok(call('POST', `/api/v1/jobs/${started.job_id}/cancel`, { cookie: w.a }));

    for (const cookie of [w.a, w.b]) {
      for (const path of [
        '/api/v1/account',
        '/api/v1/health',
        '/api/v1/project',
        '/api/v1/entities',
        '/api/v1/shots',
        `/api/v1/shots/${shot.id}/revisions`,
        `/api/v1/shots/${shot.id}/boards`,
        '/api/v1/boards',
        '/api/v1/takes',
        '/api/v1/scripts/versions',
        '/api/v1/scripts/current',
        '/api/v1/drafts',
        '/api/v1/jobs',
        '/api/v1/plans',
        '/api/v1/settings/providers',
        '/api/v1/settings/providers/me',
        '/api/v1/coverage',
      ]) {
        const r = await call('GET', path, { cookie });
        expect(r.status, `${path}: ${r.body}`).toBeLessThan(500);
      }
    }
    await call('POST', `/api/v1/groups/${w.slug}/code`, { cookie: w.a });
    await call('POST', '/api/v1/groups/preview', { cookie: w.b, body: { code: w.code } });
    await call('PUT', `/api/v1/groups/${w.slug}/members/${w.aId}/crew-roles`, { cookie: w.b, body: { crew_roles: ['导演'] } }); // refused: error bodies too

    const textOf = (cookie: string) => (seen.get(cookie) ?? []).join('\n');
    // A saw B's name and roles, never B's address; and the other way round
    expect(textOf(w.a)).toContain('阿丽');
    expect(textOf(w.a)).not.toContain('bob-secret');
    expect(textOf(w.a)).not.toContain(B_EMAIL);
    expect(textOf(w.b)).toContain('阿杰');
    expect(textOf(w.b)).not.toContain('alice-secret');
    expect(textOf(w.b)).not.toContain(A_EMAIL);
    // a member's own email is theirs to see, and only on the account call
    expect(textOf(w.a)).toContain(A_EMAIL);
    const groupViews = [
      (await ok<any>(call('GET', '/api/v1/account', { cookie: w.a }))).group,
      (await ok<any>(call('GET', '/api/v1/account', { cookie: w.b }))).group,
    ];
    for (const g of groupViews) for (const m of g.members) expect(Object.keys(m).sort()).toEqual(['crew_roles', 'id', 'joined_at', 'name', 'role', 'you']);
    // the crew-mail domain only ever shows up as the caller's own address
    expect(textOf(w.b).match(/[\w.-]+@crew-mail\.test/g)?.every((m) => m === B_EMAIL)).toBe(true);
    expect(textOf(w.a).match(/[\w.-]+@crew-mail\.test/g)?.every((m) => m === A_EMAIL)).toBe(true);

    // what the project itself stores (and could export) has no address either
    await server!.close();
    const stored = everythingUnder(teamDir(data, w.slug)) + everythingUnder(join(data, 'accounts'));
    // (positive control: the scan does read the project database, where the members' names are)
    expect(stored).toContain(Buffer.from('阿丽', 'utf8').toString('latin1'));
    expect(stored).not.toContain('crew-mail.test');
    expect(stored).not.toContain('secret@');
    await start();
  });
});

// ---------------------------------------------------------------------------

describe('S4 history over HTTP names the account that made each row', () => {
  test('A imports and creates, B edits: revisions read A then B with names and roles; after B leaves they read left with the same name', async () => {
    const w = await world();
    await ok(setRoles(w, w.a, w.aId, ['导演']));
    await ok(setRoles(w, w.b, w.bId, ['摄影', '剪辑']));
    const imported = await importScript(w.a);
    const scene = imported.scenes[0]!;
    const shot = await ok<Shot>(call('POST', '/api/v1/shots', { cookie: w.a, body: { scene_id: scene.id, fields: fields(scene, { action: '甲建' }), manual_note: '甲建' } }), 201);
    const edited = await ok<Shot>(call('PATCH', `/api/v1/shots/${shot.id}`, { cookie: w.b, body: { expected_revision: shot.revision, fields: fields(scene, { action: '乙改' }) } }));
    expect(edited.revision).toBe(1);

    const A = refOf(w.aId, '阿杰', ['导演']);
    const B = refOf(w.bId, '阿丽', ['摄影', '剪辑']);
    for (const cookie of [w.a, w.b]) {
      const revs = await ok<{ revision: number; actor: ActorRef }[]>(call('GET', `/api/v1/shots/${shot.id}/revisions`, { cookie }));
      expect(revs.map((r) => [r.revision, r.actor])).toEqual([
        [0, A],
        [1, B],
      ]);
    }
    const versions = await ok<{ actor: ActorRef }[]>(call('GET', '/api/v1/scripts/versions', { cookie: w.b }));
    expect(versions.map((v) => v.actor)).toEqual([A]);
    expect((await ok<any>(call('GET', '/api/v1/scripts/current', { cookie: w.b }))).version.actor).toEqual(A);

    // B leaves: their rows keep the name and roles and say they are gone
    expect((await call('POST', `/api/v1/groups/${w.slug}/leave`, { cookie: w.b })).status).toBe(204);
    const after = await ok<{ revision: number; actor: ActorRef }[]>(call('GET', `/api/v1/shots/${shot.id}/revisions`, { cookie: w.a }));
    expect(after.map((r) => r.actor)).toEqual([A, { ...B, left: true }]);
    expect(after[1]!.actor.name).toBe('阿丽');
    expect((await call('GET', '/api/v1/shots', { cookie: w.b })).json().error.code).toBe('NO_TEAM');

    // and coming back makes them present again, under whatever name and roles they have now
    await ok(call('POST', '/api/v1/groups/join', { cookie: w.b, body: { code: w.code } }));
    await ok(setRoles(w, w.b, w.bId, ['剪辑']));
    const back = await ok<{ actor: ActorRef }[]>(call('GET', `/api/v1/shots/${shot.id}/revisions`, { cookie: w.b }));
    expect(back[1]!.actor).toEqual(refOf(w.bId, '阿丽', ['剪辑']));
  });

  test('every route that writes history stamps the caller (table-driven, both members)', async () => {
    const w = await world();
    await ok(setRoles(w, w.a, w.aId, ['导演']));
    await ok(setRoles(w, w.b, w.bId, ['摄影', '剪辑']));
    const { scenes } = await importScript(w.a);
    const scene = scenes[0]!;
    const refs = new Map([
      [w.a, refOf(w.aId, '阿杰', ['导演'])],
      [w.b, refOf(w.bId, '阿丽', ['摄影', '剪辑'])],
    ]);
    // a fresh shot for each case, made by the other member, so a stale actor cannot pass for the right one
    const fresh = async (by: string) => ok<Shot>(call('POST', '/api/v1/shots', { cookie: by === w.a ? w.b : w.a, body: { scene_id: scene.id, fields: fields(scene), manual_note: '备用' } }), 201);
    const lastRevisionActor = async (cookie: string, id: string) => (await ok<{ actor: ActorRef | null }[]>(call('GET', `/api/v1/shots/${id}/revisions`, { cookie }))).at(-1)!.actor;
    const boardOf = async (cookie: string, shotId: string) => (await ok<{ id: string; shot_id: string; revision: number; spec: BoardSpec }[]>(call('GET', '/api/v1/boards', { cookie }))).find((b) => b.shot_id === shotId)!;

    const cases: { name: string; run: (cookie: string) => Promise<ActorRef | null | undefined> }[] = [
      {
        name: 'shot create',
        run: async (cookie) => {
          const s = await ok<Shot>(call('POST', '/api/v1/shots', { cookie, body: { scene_id: scene.id, fields: fields(scene), manual_note: 'x' } }), 201);
          return lastRevisionActor(cookie, s.id);
        },
      },
      {
        name: 'shot update',
        run: async (cookie) => {
          const s = await fresh(cookie);
          await ok(call('PATCH', `/api/v1/shots/${s.id}`, { cookie, body: { expected_revision: s.revision, fields: fields(scene, { action: '改' }) } }));
          return lastRevisionActor(cookie, s.id);
        },
      },
      {
        name: 'shot lock',
        run: async (cookie) => {
          const s = await fresh(cookie);
          await ok(call('PATCH', `/api/v1/shots/${s.id}`, { cookie, body: { expected_revision: s.revision, locked: true } }));
          return lastRevisionActor(cookie, s.id);
        },
      },
      {
        name: 'shot requirement',
        run: async (cookie) => {
          const s = await fresh(cookie);
          await ok(call('POST', `/api/v1/shots/${s.id}/requirement`, { cookie, body: { expected_revision: s.revision, required_status: 'optional', reason: '可选' } }));
          return lastRevisionActor(cookie, s.id);
        },
      },
      {
        name: 'shot archive',
        run: async (cookie) => {
          const s = await fresh(cookie);
          await ok(call('POST', `/api/v1/shots/${s.id}/archive`, { cookie, body: { expected_revision: s.revision, reason: '不要了' } }));
          return lastRevisionActor(cookie, s.id);
        },
      },
      {
        name: 'board saved',
        run: async (cookie) => {
          const s = await fresh(cookie);
          const b = await boardOf(cookie, s.id);
          const spec = structuredClone(b.spec);
          spec.camera.focal_mm = 85;
          return (await ok<{ actor: ActorRef | null }>(call('PATCH', `/api/v1/boards/${b.id}`, { cookie, body: { expected_revision: b.revision, spec } }))).actor;
        },
      },
      {
        name: 'board regenerated',
        run: async (cookie) => {
          const s = await fresh(cookie);
          await boardOf(cookie, s.id);
          return (await ok<{ actor: ActorRef | null }>(call('POST', `/api/v1/shots/${s.id}/boards`, { cookie }), 201)).actor;
        },
      },
      {
        name: 'take logged',
        run: async (cookie) => {
          const s = await fresh(cookie);
          const t = await ok<{ logged_by: ActorRef | null }>(
            call('POST', '/api/v1/takes', { cookie, body: { setup_id: null, camera_label: 'A', rating: 'good', clip_hint: null, notes: '', shot_ids: [s.id], unresolved_labels: [] } }),
            201,
          );
          return t.logged_by;
        },
      },
      {
        name: 'coverage decision',
        run: async (cookie) => {
          const s = await fresh(cookie);
          return (await ok<{ actor: ActorRef | null }>(call('POST', `/api/v1/shots/${s.id}/coverage-decisions`, { cookie, body: { decision: 'needs_pickup', selected_link_ids: [], reason: '补拍' } }), 201)).actor;
        },
      },
      {
        name: 'script version',
        run: async (cookie) => {
          const r = await ok<{ version: { id: string; actor: ActorRef | null } }>(call('POST', '/api/v1/scripts', { cookie, body: { ...SCRIPT(), text: `${SCRIPT().text}\n\n补 ${Math.random()}\n` } }), 201);
          const listed = (await ok<{ id: string; actor: ActorRef | null }[]>(call('GET', '/api/v1/scripts/versions', { cookie }))).find((v) => v.id === r.version.id)!;
          expect(listed.actor).toEqual(r.version.actor);
          return r.version.actor;
        },
      },
    ];
    for (const cookie of [w.a, w.b]) {
      for (const c of cases) expect(await c.run(cookie), `${c.name} by ${cookie === w.a ? 'A' : 'B'}`).toEqual(refs.get(cookie));
    }
  });

  test('a plan says who made it and who approved it', async () => {
    const w = await world();
    const { scenes } = await importScript(w.a);
    const shop = await ok<{ id: string }>(call('POST', '/api/v1/entities', { cookie: w.a, body: { type: 'location', name: '旧书店', aliases: [] } }), 201);
    await ok(call('PATCH', `/api/v1/scenes/${scenes[0]!.id}`, { cookie: w.a, body: { location_entity_id: shop.id } }));
    await ok(call('POST', '/api/v1/resources', { cookie: w.a, body: { type: 'location', name: '书店实景', windows: [W('07:00', '21:00')], cast_character_ids: [shop.id], confirmed: true } }), 201);
    await ok(call('POST', '/api/v1/shots', { cookie: w.a, body: { scene_id: scenes[0]!.id, fields: fields(scenes[0]!), manual_note: '测试' } }), 201);
    const setups = await ok<{ id: string }[]>(call('POST', '/api/v1/setups/derive', { cookie: w.a, body: { keep_edited: false, default_durations: DUR } }));
    for (const s of setups) await ok(call('PATCH', `/api/v1/setups/${s.id}`, { cookie: w.a, body: { estimate_confirmed: true } }));

    const created = await ok<any>(call('POST', '/api/v1/plans', { cookie: w.a, body: { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' } }), 201);
    expect(created.approval.ok, JSON.stringify(created.approval)).toBe(true);
    expect(created.plan.created_by).toEqual(refOf(w.aId, '阿杰', []));
    expect(created.plan.approved_by ?? null).toBeNull();
    const approved = await ok<any>(call('POST', `/api/v1/plans/${created.plan.id}/approve`, { cookie: w.b, body: { expected_revision: created.plan.revision } }));
    expect(approved.plan.status).toBe('approved');
    expect(approved.plan.created_by.id).toBe(w.aId);
    expect(approved.plan.approved_by).toEqual(refOf(w.bId, '阿丽', []));
    const listed = await ok<{ id: string; created_by: ActorRef; approved_by: ActorRef }[]>(call('GET', '/api/v1/plans', { cookie: w.a }));
    expect(listed.find((p) => p.id === created.plan.id)).toMatchObject({ created_by: { name: '阿杰' }, approved_by: { name: '阿丽' } });
  });
});

// ---------------------------------------------------------------------------

describe('S4 the group’s model belongs to the leader', () => {
  test('a member cannot change it or run the paid image test, and sees no key digits; the leader can', async () => {
    const w = await world();
    const image = { base_url: 'https://image.example.invalid/v1', model: 'img', api_key: 'sk-image-2222', dialect_override: null };

    const noText = await saveGroupText(w.b);
    expect(noText.status, noText.body).toBe(403);
    expect(noText.json().error.code).toBe('FORBIDDEN');
    expect(noText.json().error.message).toContain('组长');
    const noImage = await call('PUT', '/api/v1/settings/providers/image', { cookie: w.b, body: image });
    expect(noImage.status).toBe(403);
    expect(noImage.json().error.message).toContain('组长');
    const noPaid = await call('POST', '/api/v1/settings/providers/image/test', { cookie: w.b, body: { paid: true } });
    expect(noPaid.status, noPaid.body).toBe(403);
    // nothing was saved by the refused calls
    expect(existsSync(join(teamDir(data, w.slug), 'state', 'credentials.json'))).toBe(false);
    expect((await ok<any>(call('GET', '/api/v1/settings/providers', { cookie: w.a }))).text).toBeNull();

    const saved = await ok<any>(saveGroupText(w.a));
    expect(saved.editable).toBe(true);
    expect(saved.text).toMatchObject({ base_url: GROUP_BASE, model: 'group-model', key_last4: '1111' });
    await ok(call('PUT', '/api/v1/settings/providers/image', { cookie: w.a, body: image }));

    const leaderView = await call('GET', '/api/v1/settings/providers', { cookie: w.a });
    expect(leaderView.json().data).toMatchObject({ editable: true, text: { key_last4: '1111' }, image: { key_last4: '2222' } });
    const memberView = await call('GET', '/api/v1/settings/providers', { cookie: w.b });
    expect(memberView.json().data.editable).toBe(false);
    expect(memberView.json().data.text).toMatchObject({ base_url: GROUP_BASE, model: 'group-model', key_last4: null });
    expect(memberView.json().data.image).toMatchObject({ model: 'img', key_last4: null });
    // no part of any key reaches the member, or the leader (write-only)
    expect(memberView.body).not.toMatch(/1111|2222|sk-group|sk-image/);
    expect(leaderView.body).not.toMatch(/sk-group|sk-image/);
  });

  test('members may use the free connection checks (they spend nothing) but not the paid one', async () => {
    const w = await world();
    await ok(saveGroupText(w.a));
    routing.state.calls.length = 0;
    const text = await call('POST', '/api/v1/settings/providers/text/test', { cookie: w.b });
    expect(text.status, text.body).toBe(200);
    expect(text.json().data).toMatchObject({ ok: true, models_endpoint: true, model_listed: true });
    expect(routing.state.calls.map((c) => [c.host, c.path])).toEqual([['group-llm.example.invalid', '/v1/models']]);
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${GROUP_KEY}`);
    // the free image check is not a leader matter (no image model is set here, so it says so)
    const free = await call('POST', '/api/v1/settings/providers/image/test', { cookie: w.b, body: { paid: false } });
    expect(free.status).not.toBe(403);
    expect((await call('POST', '/api/v1/settings/providers/image/test', { cookie: w.b, body: { paid: true } })).status).toBe(403);
  });

  test('when the leader leaves, the next one leads at once — and the old leader is out', async () => {
    const w = await world();
    await ok(saveGroupText(w.a));
    expect((await saveGroupText(w.b, GROUP_BASE, 'sk-group-B-3333')).status).toBe(403);
    expect((await call('POST', `/api/v1/groups/${w.slug}/leave`, { cookie: w.a })).status).toBe(204);
    const now = await ok<any>(saveGroupText(w.b, GROUP_BASE, 'sk-group-B-3333'));
    expect(now).toMatchObject({ editable: true, text: { key_last4: '3333' } });
    expect((await ok<any>(call('GET', '/api/v1/settings/providers', { cookie: w.b }))).editable).toBe(true);
    expect((await call('GET', '/api/v1/settings/providers', { cookie: w.a })).json().error.code).toBe('NO_TEAM');
  });
});

// ---------------------------------------------------------------------------

describe('S4 my own model', () => {
  test('hosted only: a private or non-https base_url is refused when saving, and nothing is written', async () => {
    const w = await world();
    for (const base of ['https://127.0.0.1:8080/v1', 'https://localhost/v1', 'https://10.0.0.8/v1', 'https://169.254.169.254/v1', 'http://api.example.com/v1']) {
      const r = await saveOwnText(w.b, base);
      expect(r.status, `${base}: ${r.body}`).toBe(400);
      expect(r.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'base_url' } });
      const img = await call('PUT', '/api/v1/settings/providers/me/image', { cookie: w.b, body: { base_url: base, model: 'm', api_key: 'k', dialect_override: null } });
      expect(img.status, `${base}: ${img.body}`).toBe(400);
    }
    expect(existsSync(join(data, 'accounts'))).toBe(false);
    // the same call for the group’s model is the leader's, and equally strict
    expect((await saveGroupText(w.a, 'https://127.0.0.1:8080/v1')).status).toBe(400);
  });

  test('saved in the account’s own folder (0600), shown only to its owner, with the last 4 digits only', async () => {
    const w = await world();
    await ok(saveGroupText(w.a));
    const saved = await saveOwnText(w.b);
    expect(saved.status, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ editable: true, text: { base_url: OWN_BASE, model: 'own-model', key_last4: '9999' }, image: null });
    expect(saved.body).not.toContain(OWN_KEY);

    const file = join(data, 'accounts', w.bId, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, 'accounts', w.bId)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8')).llm).toMatchObject({ base_url: OWN_BASE, api_key: OWN_KEY, model: 'own-model' });
    // never in the group's folder (where the group's key lives), and the group's key never in B's
    expect(readFileSync(join(teamDir(data, w.slug), 'state', 'credentials.json'), 'utf8')).not.toContain('sk-own');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-group');
    expect(existsSync(join(data, 'accounts', w.aId))).toBe(false);

    // each member reads only their own
    const mineB = await call('GET', '/api/v1/settings/providers/me', { cookie: w.b });
    expect(mineB.json().data.text).toMatchObject({ base_url: OWN_BASE, key_last4: '9999' });
    const mineA = await call('GET', '/api/v1/settings/providers/me', { cookie: w.a });
    expect(mineA.json().data).toEqual({ text: null, image: null, editable: true });
    expect(mineA.body).not.toMatch(/9999|own-b/);
    // and the group's view (which A and B both get) has nothing of B's
    for (const cookie of [w.a, w.b]) expect((await call('GET', '/api/v1/settings/providers', { cookie })).body).not.toMatch(/own-b|own-model|9999/);
    // B may test their own connection; it uses B's key at B's address
    routing.state.calls.length = 0;
    const test = await call('POST', '/api/v1/settings/providers/me/text/test', { cookie: w.b });
    expect(test.json().data).toMatchObject({ ok: true, model_listed: true });
    expect(routing.state.calls).toEqual([{ host: 'own-b.example.invalid', path: '/v1/models' }]);
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${OWN_KEY}`);
  });

  test('a member who chooses their own model with nothing filled in gets 409 (never the leader’s key); a leader’s own choice is theirs alone', async () => {
    const w = await world();
    await ok(saveGroupText(w.a));
    await importScript(w.a);

    const chosen = await ok<any>(choose(w, w.b, { text: 'own' }));
    expect(chosen.model_choice).toEqual({ text: 'own', image: 'group' });
    // A's own view of the group did not move
    expect((await ok<any>(call('GET', '/api/v1/account', { cookie: w.a }))).group.model_choice).toEqual({ text: 'group', image: 'group' });

    const r = await extract(w.b);
    expect(r.status, r.res.body).toBe(409);
    expect(r.res.json().error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(r.res.json().error.message).toContain('自己的');
    expect(chatCalls()).toHaveLength(0); // nothing was sent, on anyone's key
    expect(fake.requests).toHaveLength(0);
    expect((await ok<any>(call('GET', '/api/v1/jobs', { cookie: w.b }))).length).toBe(0);

    // the same call by A (group model) works
    fake.enqueue(reply.json(ENTITIES));
    const okRun = await extract(w.a);
    expect(okRun.job!.status).toBe('succeeded');
    expect(chatCalls()[0]!.authorization).toBe(`Bearer ${GROUP_KEY}`);

    // back to the group's model: B is served with the group's key
    await ok(choose(w, w.b, { text: 'group' }));
    fake.enqueue(reply.json(ENTITIES));
    expect((await extract(w.b)).job!.status).toBe('succeeded');
    expect(chatCalls().map((c) => c.authorization)).toEqual([`Bearer ${GROUP_KEY}`, `Bearer ${GROUP_KEY}`]);
  });

  test('choosing my model sends B’s requests with B’s key to B’s address; A still uses the group’s; jobs record model_source and the starter', async () => {
    const w = await world();
    await ok(saveGroupText(w.a));
    await ok(saveOwnText(w.b));
    await importScript(w.a);

    // the default is the group's model, even though B has filled in their own
    fake.enqueue(reply.json(ENTITIES));
    const before = await extract(w.b);
    expect(before.job).toMatchObject({ status: 'succeeded', model_source: 'group', actor: { id: w.bId } });
    expect(chatCalls().at(-1)).toMatchObject({ authorization: `Bearer ${GROUP_KEY}`, body: { model: 'group-model' } });

    await ok(choose(w, w.b, { text: 'own' }));
    fake.enqueue(reply.json(ENTITIES));
    const mine = await extract(w.b);
    expect(mine.job).toMatchObject({ status: 'succeeded', model_source: 'own', actor: { id: w.bId, name: '阿丽' } });
    expect(chatCalls().at(-1)).toMatchObject({ authorization: `Bearer ${OWN_KEY}`, body: { model: 'own-model' } });
    expect(routing.state.calls.map((c) => c.host)).toEqual(['group-llm.example.invalid', 'own-b.example.invalid']);
    // the draft it produced says who asked
    const draft = await ok<any>(call('GET', `/api/v1/drafts/${mine.job!.result_ref}`, { cookie: w.a }));
    expect(draft.draft.actor).toMatchObject({ id: w.bId, name: '阿丽' });

    // A is unaffected by B's choice
    fake.enqueue(reply.json(ENTITIES));
    const theirs = await extract(w.a);
    expect(theirs.job).toMatchObject({ status: 'succeeded', model_source: 'group', actor: { id: w.aId } });
    expect(chatCalls().at(-1)!.authorization).toBe(`Bearer ${GROUP_KEY}`);
    // B's key appears in nothing A can fetch
    for (const path of ['/api/v1/jobs/' + mine.job!.id, '/api/v1/drafts', '/api/v1/settings/providers', '/api/v1/health']) {
      expect((await call('GET', path, { cookie: w.a })).body, path).not.toMatch(/sk-own|9999|own-b\.example/);
    }
  });

  test('a failure of B’s own model shows in the job list without B’s key or address', async () => {
    const w = await world();
    await ok(saveGroupText(w.a));
    await ok(saveOwnText(w.b));
    await importScript(w.a);
    await ok(choose(w, w.b, { text: 'own' }));
    fake.enqueue({ type: 'echo_auth', status: 401 });
    const failed = await extract(w.b);
    expect(failed.job!.status).toBe('failed');
    // this is what a teammate reads in the job list
    const asSeenByA = await call('GET', `/api/v1/jobs/${failed.job!.id}`, { cookie: w.a });
    expect(asSeenByA.json().data.error.message).toBeTruthy();
    expect(asSeenByA.body).not.toContain(OWN_KEY);
    expect(asSeenByA.body).not.toMatch(/sk-own/);
    expect(asSeenByA.body).not.toContain('own-b.example.invalid');
    const drafts = await call('GET', '/api/v1/drafts', { cookie: w.a });
    expect(drafts.body).not.toContain(OWN_KEY);
    expect(drafts.body).not.toContain('own-b.example.invalid');
  });

  test.each([
    ['the server’s egress guard refusing the address', (host: string) => new EgressBlockedError(host)],
    ['a DNS failure', (host: string) => Object.assign(new TypeError('fetch failed'), { cause: new Error(`getaddrinfo ENOTFOUND ${host}`) })],
    ['a refused connection', (host: string) => Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED ${host}:443`) })],
  ])('B’s own service being unreachable (%s) shows a teammate neither B’s key nor B’s address', async (_name, failure) => {
    const w = await world();
    await ok(saveGroupText(w.a));
    await ok(saveOwnText(w.b));
    await importScript(w.a);
    await ok(choose(w, w.b, { text: 'own' }));
    routing.state.failWith = (host) => (host === 'own-b.example.invalid' ? failure(host) : null);
    const failed = await extract(w.b);
    expect(failed.job!.status).toBe('failed');
    expect(failed.job!.error!.message).toBeTruthy();
    for (const path of [`/api/v1/jobs/${failed.job!.id}`, '/api/v1/drafts', `/api/v1/drafts/${failed.job!.result_ref}`]) {
      const asSeenByA = await call('GET', path, { cookie: w.a });
      expect(asSeenByA.body, path).not.toMatch(/own-b|example\.invalid|sk-own|9999/);
    }
  });

  test('health follows the member’s choice: source and whether it is filled in', async () => {
    const w = await world();
    const health = async (cookie: string) => (await ok<any>(call('GET', '/api/v1/health', { cookie })));
    // nothing set anywhere
    expect(await health(w.b)).toMatchObject({ text_provider_configured: false, text_model_source: 'group', image_model_source: 'group' });

    await ok(saveGroupText(w.a));
    expect(await health(w.b)).toMatchObject({ text_provider_configured: true, text_model_source: 'group' });

    await ok(choose(w, w.b, { text: 'own', image: 'own' }));
    expect(await health(w.b)).toMatchObject({ text_provider_configured: false, text_model_source: 'own', image_provider_configured: false, image_model_source: 'own' });
    // A still sees the group's
    expect(await health(w.a)).toMatchObject({ text_provider_configured: true, text_model_source: 'group', image_model_source: 'group' });

    await ok(saveOwnText(w.b));
    expect(await health(w.b)).toMatchObject({ text_provider_configured: true, text_model_source: 'own', image_provider_configured: false });
    // B's file is not A's: A choosing own gets false although B's is complete
    await ok(choose(w, w.a, { text: 'own' }));
    expect(await health(w.a)).toMatchObject({ text_provider_configured: false, text_model_source: 'own' });

    // an omitted field leaves the other choice alone; an unknown value is refused
    expect((await ok<any>(choose(w, w.b, { image: 'group' }))).model_choice).toEqual({ text: 'own', image: 'group' });
    expect((await choose(w, w.b, { text: 'nobody' })).status).toBe(400);
    expect((await ok<any>(choose(w, w.b, {}))).model_choice).toEqual({ text: 'own', image: 'group' });
    // the choice is remembered across a restart
    await server!.close();
    await start();
    expect((await ok<any>(call('GET', '/api/v1/account', { cookie: w.b }))).group.model_choice).toEqual({ text: 'own', image: 'group' });
  });
});

// ---------------------------------------------------------------------------

describe('S4 the daily cap protects the group’s key only', () => {
  test('with a cap of 1: the group key works once, the second group-key job is refused, an own-key job still runs', async () => {
    writeHostedConfig(data, config({ llm_jobs_per_day: 1 }));
    const w = await world();
    await ok(saveGroupText(w.a));
    await ok(saveOwnText(w.b));
    await importScript(w.a);

    fake.enqueue(reply.json(ENTITIES));
    const first = await extract(w.a);
    expect(first.job).toMatchObject({ status: 'succeeded', model_source: 'group' });

    // the cap is per group, not per person: B on the group's key is stopped too
    const second = await extract(w.a);
    expect(second.status, second.res.body).toBe(409);
    expect(second.res.json().error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { lane: 'llm', limit: 1, used: 1 } });
    const bGroup = await extract(w.b);
    expect(bGroup.res.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(chatCalls()).toHaveLength(1);

    // B on their own key is not held up by it
    await ok(choose(w, w.b, { text: 'own' }));
    fake.enqueue(reply.json(ENTITIES));
    const own = await extract(w.b);
    expect(own.job).toMatchObject({ status: 'succeeded', model_source: 'own' });
    expect(chatCalls().at(-1)!.authorization).toBe(`Bearer ${OWN_KEY}`);
    // and again: own jobs are not counted, however many
    fake.enqueue(reply.json(ENTITIES));
    expect((await extract(w.b)).job!.status).toBe('succeeded');

    // the group's count still stands at 1 (own jobs are recorded but not counted)
    const stillCapped = await extract(w.a);
    expect(stillCapped.res.json().error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { used: 1 } });
    // switching back to the group's model meets the cap again
    await ok(choose(w, w.b, { text: 'group' }));
    expect((await extract(w.b)).res.json().error.code).toBe('QUOTA_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------

describe('site.db v2 → v3 (S4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ssm-sitedb-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const V1 = `
    CREATE TABLE teams (slug TEXT PRIMARY KEY, name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      team_slug TEXT REFERENCES teams(slug) ON DELETE SET NULL, team_role TEXT CHECK (team_role IN ('leader', 'member')), joined_at TEXT, joined_seq INTEGER);
    CREATE INDEX accounts_team ON accounts(team_slug);
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE email_codes (email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (email, purpose));
    CREATE TABLE mail_log (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, ip TEXT NOT NULL, purpose TEXT NOT NULL, sent_at INTEGER NOT NULL);
    INSERT INTO teams VALUES ('goldgrp1', '老组', 'ABCD2345', '2026-09-28T00:00:00.000Z');
  `;
  const V2 = `${V1}
    ALTER TABLE sessions ADD COLUMN current_team TEXT;
    CREATE TABLE memberships (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      team_slug TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
      joined_at TEXT NOT NULL,
      joined_seq INTEGER NOT NULL,
      PRIMARY KEY (account_id, team_slug)
    );
    CREATE INDEX memberships_team ON memberships(team_slug, joined_seq);
    INSERT INTO accounts VALUES ('acc-1', 'old@school.test', '老张', 'x', '2026-09-28T00:00:00.000Z', NULL, NULL, NULL, NULL);
    INSERT INTO accounts VALUES ('acc-2', 'new@school.test', '小新', 'x', '2026-09-28T00:00:00.000Z', NULL, NULL, NULL, NULL);
    INSERT INTO memberships VALUES ('acc-1', 'goldgrp1', 'leader', '2026-09-28T00:00:00.000Z', 1);
    INSERT INTO memberships VALUES ('acc-2', 'goldgrp1', 'member', '2026-09-28T01:00:00.000Z', 2);
    INSERT INTO sessions VALUES ('h1', 'acc-1', 1, 9999999999999, 'goldgrp1');
    PRAGMA user_version = 2;
  `;

  async function build(sql: string): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(join(dir, 'site.db'));
    legacy.exec(sql);
    legacy.close();
  }
  async function inspect<T>(file: string, sql: string): Promise<T[]> {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  }
  const version = (site: SiteDb) => site.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version;

  test('memberships gain crew_roles_json [] and both sources "group"; a v2 backup is kept (0600) and holds the old shape', async () => {
    await build(V2);
    const site = SiteDb.open(dir, now);
    try {
      expect(version(site)).toBe(3);
      const cols = site.db.all<{ name: string; dflt_value: string | null }>('PRAGMA table_info(memberships)');
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['crew_roles_json', 'text_source', 'image_source']));
      expect(cols.find((c) => c.name === 'crew_roles_json')!.dflt_value).toBe("'[]'");
      const rows = site.db.all<Record<string, unknown>>('SELECT account_id, role, crew_roles_json, text_source, image_source FROM memberships ORDER BY joined_seq');
      expect(rows).toEqual([
        { account_id: 'acc-1', role: 'leader', crew_roles_json: '[]', text_source: 'group', image_source: 'group' },
        { account_id: 'acc-2', role: 'member', crew_roles_json: '[]', text_source: 'group', image_source: 'group' },
      ]);
      expect(site.membership('acc-2', 'goldgrp1')).toMatchObject({ role: 'member', crew_roles_json: '[]', text_source: 'group', image_source: 'group' });
      expect(site.members('goldgrp1').map((m) => [m.name, m.role, m.crew_roles_json])).toEqual([
        ['老张', 'leader', '[]'],
        ['小新', 'member', '[]'],
      ]);
      // a signed-in browser survives
      expect(site.session('h1')).toBeNull(); // (hash of a cookie, not a cookie: nothing to sign in with, but the row is kept)
      expect(site.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n).toBe(1);
      // the new columns are usable
      site.setCrewRoles('acc-2', 'goldgrp1', ['摄影']);
      site.setModelChoice('acc-2', 'goldgrp1', { text: 'own' });
      expect(site.membership('acc-2', 'goldgrp1')).toMatchObject({ crew_roles_json: '["摄影"]', text_source: 'own', image_source: 'group' });
    } finally {
      site.close();
    }

    const bak = join(dir, 'site.db.v2.bak');
    expect(existsSync(bak)).toBe(true);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    expect((await inspect<{ user_version: number }>(bak, 'PRAGMA user_version'))[0]!.user_version).toBe(2);
    const oldCols = (await inspect<{ name: string }>(bak, 'PRAGMA table_info(memberships)')).map((c) => c.name);
    expect(oldCols).toEqual(['account_id', 'team_slug', 'role', 'joined_at', 'joined_seq']);
    expect(await inspect(bak, 'SELECT account_id FROM memberships ORDER BY joined_seq')).toEqual([{ account_id: 'acc-1' }, { account_id: 'acc-2' }]);
    expect(existsSync(join(dir, 'site.db.v3.bak'))).toBe(false);
  });

  test('opening a v3 file again neither copies it nor touches the backup; what was set survives', async () => {
    await build(V2);
    SiteDb.open(dir, now).close();
    const bakBefore = readFileSync(join(dir, 'site.db.v2.bak'));
    const site = SiteDb.open(dir, now);
    site.setCrewRoles('acc-1', 'goldgrp1', ['导演']);
    site.close();
    const again = SiteDb.open(dir, now);
    try {
      expect(version(again)).toBe(3);
      expect(again.membership('acc-1', 'goldgrp1')!.crew_roles_json).toBe('["导演"]');
    } finally {
      again.close();
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak')).sort()).toEqual(['site.db.v2.bak']);
    expect(readFileSync(join(dir, 'site.db.v2.bak')).equals(bakBefore)).toBe(true);
  });

  test('a backup that is already there is never overwritten', async () => {
    await build(V2);
    writeFileSync(join(dir, 'site.db.v2.bak'), 'from an earlier attempt', { mode: 0o600 });
    SiteDb.open(dir, now).close();
    expect(readFileSync(join(dir, 'site.db.v2.bak'), 'utf8')).toBe('from an earlier attempt');
  });

  test('from v1 (S2a) it goes all the way to v3, backing up the v1 file', async () => {
    await build(
      `${V1}
       INSERT INTO accounts VALUES ('acc-1', 'old@school.test', '老张', 'x', '2026-09-28T00:00:00.000Z', 'goldgrp1', 'leader', '2026-09-28T00:00:00.000Z', 1);
       PRAGMA user_version = 1;`,
    );
    const site = SiteDb.open(dir, now);
    try {
      expect(version(site)).toBe(3);
      expect(site.membership('acc-1', 'goldgrp1')).toMatchObject({ role: 'leader', crew_roles_json: '[]', text_source: 'group', image_source: 'group' });
    } finally {
      site.close();
    }
    const bak = join(dir, 'site.db.v1.bak');
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    expect((await inspect<{ user_version: number }>(bak, 'PRAGMA user_version'))[0]!.user_version).toBe(1);
  });

  test('a brand-new site makes no backup; a file from a newer program is refused', async () => {
    SiteDb.open(dir, now).close();
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toEqual([]);
    expect(statSync(join(dir, 'site.db')).mode & 0o777).toBe(0o600);

    rmSync(join(dir, 'site.db'));
    await build(`${V2.replace('PRAGMA user_version = 2;', 'PRAGMA user_version = 99;')}`);
    expect(() => SiteDb.open(dir, now)).toThrow(/比这个程序新/);
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toEqual([]);
  });
});

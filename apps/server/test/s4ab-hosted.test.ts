import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { CollabChanges, CommentSummary, Scene, Shot, ShotComment } from '@storyscript/contracts';
import { hashInvite, HostedLimits, writeHostedConfig, type HostedConfig } from '../src/hosted/config.ts';
import type { MailMessage, Mailer } from '../src/hosted/mail/mailer.ts';
import { startHostedServer, type HostedServer } from '../src/hosted/start.ts';
import { fixtureText } from './helpers/m3-app.ts';

/**
 * S4a/S4b through the real gateway with two accounts in one group: the feed
 * names who changed what, presence lists teammates on their pages, and a
 * comment that mentions @导演 reaches the director's inbox and moves the
 * comments area. No email ever appears.
 */

const INVITE = 'sdsz-Test';
const A_EMAIL = 'alice-hidden@crew-mail.test';
const B_EMAIL = 'bob-hidden@crew-mail.test';

let data = '';
let server: HostedServer | null = null;
let sent: MailMessage[] = [];
let clock = Date.parse('2026-09-28T08:00:00.000Z');
const mailer: Mailer = {
  kind: 'outbox',
  async send(m) {
    sent.push(m);
  },
};

function config(): HostedConfig {
  return {
    format: 'storyscript-mov-server',
    version: 2,
    site_name: '学校短片节',
    public_origin: 'https://story.example.test',
    listen_host: '127.0.0.1',
    port: 4700,
    timezone: 'Asia/Shanghai',
    invite_sha256: hashInvite(INVITE),
    mail: { from: 'StoryScript-Mov <noreply@story.example.test>' },
    limits: HostedLimits.parse({}),
  };
}

interface Res {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
  const port = server!.port;
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET') headers.origin = `http://127.0.0.1:${port}`;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ok<T>(p: Promise<Res>, status = 200): Promise<T> {
  const r = await p;
  expect(r.status, r.body).toBe(status);
  expect(r.body).not.toContain('crew-mail.test');
  return (r.body ? JSON.parse(r.body).data : undefined) as T;
}

async function register(email: string, name: string): Promise<string> {
  await call('POST', '/api/v1/account/register/code', { body: { email, invite: INVITE } });
  const code = /验证码：(\d{6})/.exec([...sent].reverse().find((m) => m.to === email)!.text)![1];
  const r = await call('POST', '/api/v1/account/register', { body: { email, code, name, password: 'password-1' } });
  expect(r.status, r.body).toBe(204);
  clock += 61_000;
  return ([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
}

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'ssm-s4ab-'));
  writeHostedConfig(data, config());
  sent = [];
  server = await startHostedServer({ dataDir: data, port: 0, webDir: join(data, 'no-web'), log: () => undefined, mailer, now: () => clock });
});

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(data, { recursive: true, force: true });
});

test('feed names the teammate, presence shows pages, @导演 reaches the director', async () => {
  const a = await register(A_EMAIL, '阿杰');
  const b = await register(B_EMAIL, '阿丽');
  const g = await ok<{ slug: string; join_code: string; members: { id: string }[] }>(call('POST', '/api/v1/groups', { cookie: a, body: { name: '一组' } }), 201);
  const aId = g.members[0]!.id;
  const joined = await ok<{ members: { id: string; you: boolean }[] }>(call('POST', '/api/v1/groups/join', { cookie: b, body: { code: g.join_code } }));
  const bId = joined.members.find((m) => m.you)!.id;
  await ok(call('PUT', `/api/v1/groups/${g.slug}/members/${aId}/crew-roles`, { cookie: a, body: { crew_roles: ['导演'] } }));
  await ok(call('PUT', `/api/v1/groups/${g.slug}/members/${bId}/crew-roles`, { cookie: b, body: { crew_roles: ['摄影'] } }));

  // B's first poll: state only
  const b0 = await ok<CollabChanges>(call('GET', '/api/v1/collab/changes?since=0&epoch=&tab=b1&page=boards', { cookie: b }));
  // A imports and edits while on the script page
  await ok<CollabChanges>(call('GET', '/api/v1/collab/changes?since=0&epoch=&tab=a1&page=script', { cookie: a }));
  const imported = await ok<{ scenes: Scene[] }>(
    call('POST', '/api/v1/scripts', { cookie: a, body: { text: fixtureText('01-bookshop.txt'), source_name: 'x.txt', format: 'txt', heading_overrides: [] } }),
    201,
  );
  const shot = await ok<Shot>(
    call('POST', '/api/v1/shots', {
      cookie: a,
      body: {
        scene_id: imported.scenes[0]!.id,
        manual_note: '手工',
        fields: {
          template: null, shot_size: 'MS', angle: 'eye', lens: 'normal', focal_mm: null, movement: 'static', subjects: [], props: [], env: null,
          subject_motion: 'none', set_piece: false, pov_owner: null, frame_format: null, technique_id: null, est_seconds: 3,
          narrative_purpose: '交代', action: '书店全景', dialogue_quote: null, source: { paragraph_id: 'p-003', quote: '' }, assumptions: [], questions: [],
        },
      },
    }),
    201,
  );

  const b1 = await ok<CollabChanges>(call('GET', `/api/v1/collab/changes?since=${b0.seq}&epoch=${b0.epoch}&tab=b1&page=boards`, { cookie: b }));
  expect(b1.reset).toBe(false);
  expect(b1.events.map((e) => [e.actor?.name, e.actor?.crew_roles, e.verb])).toEqual([
    ['阿杰', ['导演'], 'imported'],
    ['阿杰', ['导演'], 'created'],
  ]);
  expect(b1.presence.map((p) => [p.actor.name, p.page, p.you])).toEqual([
    ['阿丽', 'boards', true],
    ['阿杰', 'script', false],
  ]);

  // B comments on the shot and calls the director
  const c = await ok<ShotComment>(call('POST', `/api/v1/shots/${shot.id}/comments`, { cookie: b, body: { body: '这里改成仰拍？', mentions: [{ role: '导演' }] } }), 201);
  expect(c.mentions.map((m) => m.name)).toEqual(['阿杰']);
  const sumA = await ok<CommentSummary>(call('GET', '/api/v1/comments/summary', { cookie: a }));
  expect(sumA.shots[shot.id]).toEqual({ total: 1, unresolved: 1, unread: 1 });
  expect(sumA.mentions.map((m) => [m.author.name, m.excerpt, m.shot_code])).toEqual([['阿丽', '这里改成仰拍？', shot.code]]);

  const a1 = await ok<CollabChanges>(call('GET', `/api/v1/collab/changes?since=${b1.seq}&epoch=${b1.epoch}&tab=a1&page=script`, { cookie: a }));
  expect(a1.events.map((e) => [e.actor?.name, e.verb, e.areas])).toEqual([['阿丽', 'commented', ['comments']]]);

  // A reads, replies, resolves; reading does not move the feed
  const before = a1.seq;
  const r = await call('POST', `/api/v1/shots/${shot.id}/comments/read`, { cookie: a, body: {} });
  expect(r.status).toBe(204);
  const a2 = await ok<CollabChanges>(call('GET', `/api/v1/collab/changes?since=${before}&epoch=${a1.epoch}&tab=a1&page=script`, { cookie: a }));
  expect(a2.seq).toBe(before);
  await ok(call('POST', `/api/v1/shots/${shot.id}/comments`, { cookie: a, body: { body: '可以', parent_id: c.id } }), 201);
  const resolved = await ok<ShotComment>(call('POST', `/api/v1/comments/${c.id}/resolve`, { cookie: a, body: {} }));
  expect(resolved.resolved_by?.name).toBe('阿杰');
  // B cannot edit A's reply, A cannot edit B's comment
  const thread = await ok<ShotComment[]>(call('GET', `/api/v1/shots/${shot.id}/comments`, { cookie: b }));
  const reply = thread.find((x) => x.parent_id === c.id)!;
  expect((await call('PATCH', `/api/v1/comments/${reply.id}`, { cookie: b, body: { body: '改' } })).status).toBe(403);
  expect((await call('PATCH', `/api/v1/comments/${c.id}`, { cookie: a, body: { body: '改' } })).status).toBe(403);
  // the leader may delete B's comment (soft)
  const del = await ok<ShotComment>(call('DELETE', `/api/v1/comments/${c.id}`, { cookie: a }));
  expect(del).toMatchObject({ deleted: true, body: '' });
});

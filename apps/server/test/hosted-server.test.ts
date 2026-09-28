import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { hashInvite, HostedLimits, readHostedConfig, teamDir, writeHostedConfig, type HostedConfig } from '../src/hosted/config.ts';
import { runServerCli } from '../src/hosted/cli.ts';
import { noMailer, type MailMessage, type Mailer } from '../src/hosted/mail/mailer.ts';
import { SiteDb } from '../src/hosted/site-db.ts';
import { startHostedServer, type HostedServer } from '../src/hosted/start.ts';

/**
 * Hosted server (S2a): people register with the site's invite code and an
 * emailed code, sign in with a password or an emailed code, then start or
 * join a group; a group shares one project. Each account only ever reaches
 * its own group's project; features that would touch the server's disk or
 * settings are refused; Host/Origin checks and limits hold; sessions and
 * groups survive a restart.
 */

const PUBLIC = 'https://story.example.test';
const INVITE = 'sdsz-Test';
let data = '';
let server: HostedServer | null = null;
let sent: MailMessage[] = [];
let clock = Date.parse('2026-09-28T08:00:00.000Z');
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
  opts: { cookie?: string; body?: unknown; host?: string; origin?: string | null; ip?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const port = server!.port;
  const host = opts.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, ...opts.headers };
  if (opts.ip) headers['x-forwarded-for'] = `10.0.0.1, ${opts.ip}`;
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

const cookieOf = (r: Res) => ([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;

function lastCode(email: string): string {
  const m = [...sent].reverse().find((x) => x.to === email);
  const code = m && /验证码：(\d{6})/.exec(m.text)?.[1];
  if (!code) throw new Error(`no code mailed to ${email}`);
  return code;
}

async function register(email: string, name = '同学', password = 'password-1', ip?: string): Promise<string> {
  const a = await call('POST', '/api/v1/account/register/code', { body: { email, invite: INVITE }, ip });
  expect(a.status, a.body).toBe(204);
  const r = await call('POST', '/api/v1/account/register', { body: { email, code: lastCode(email), name, password }, ip });
  expect(r.status, r.body).toBe(204);
  clock += 61_000; // past the resend wait, for the next mail to the same address
  return cookieOf(r);
}

async function createGroup(cookie: string, name: string): Promise<{ join_code: string; slug: string }> {
  const r = await call('POST', '/api/v1/group', { cookie, body: { name } });
  expect(r.status, r.body).toBe(201);
  return r.json().data;
}

async function joinGroup(cookie: string, code: string): Promise<Res> {
  return call('POST', '/api/v1/group/join', { cookie, body: { code } });
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ssm-hosted-'));
  writeHostedConfig(data, config());
  sent = [];
  clock = Date.parse('2026-09-28T08:00:00.000Z');
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(data, { recursive: true, force: true });
});

describe('hosted server: registering', () => {
  test('site info is public; everything else needs an account', async () => {
    await start();
    const site = await call('GET', '/api/v1/site');
    expect(site.json().data).toEqual({ hosted: true, name: '学校短片节' });
    expect((await call('GET', '/api/v1/health')).status).toBe(401);
    expect((await call('GET', '/api/v1/account')).status).toBe(401);
    // the local app's token exchange does not exist here
    expect((await call('POST', '/api/v1/session', { body: { token: 'x'.repeat(40) } })).status).toBe(404);
  });

  test('a wrong invite code sends nothing; the right one (any case) mails a code; the code signs up with a strict cookie', async () => {
    await start();
    const wrong = await call('POST', '/api/v1/account/register/code', { body: { email: 'a@school.test', invite: 'nope' } });
    expect(wrong.status).toBe(403);
    expect(wrong.json().error.message).toContain('邀请码不对');
    expect(sent).toHaveLength(0);

    const ok = await call('POST', '/api/v1/account/register/code', { body: { email: ' A@School.TEST ', invite: ' SDSZ-test ' } });
    expect(ok.status, ok.body).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'a@school.test' });
    expect(sent[0]!.subject).toMatch(/^学校短片节 注册验证码：\d{6}$/);

    const r = await call('POST', '/api/v1/account/register', { body: { email: 'a@school.test', code: lastCode('a@school.test'), name: '小林', password: 'password-1' } });
    expect(r.status, r.body).toBe(204);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    const me = (await call('GET', '/api/v1/account', { cookie: cookieOf(r) })).json().data;
    expect(me).toEqual({ email: 'a@school.test', name: '小林', group: null });

    // the same address cannot register twice
    clock += 61_000;
    const again = await call('POST', '/api/v1/account/register/code', { body: { email: 'a@school.test', invite: INVITE } });
    expect(again.status).toBe(409);
    expect(again.json().error.code).toBe('ACCOUNT_EXISTS');
  });

  test('a code is used once, expires after 10 minutes and dies after 5 wrong tries', async () => {
    await start();
    const body = (code: string) => ({ email: 'b@school.test', code, name: '小周', password: 'password-1' });
    await call('POST', '/api/v1/account/register/code', { body: { email: 'b@school.test', invite: INVITE } });
    const code = lastCode('b@school.test');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/v1/account/register', { body: body(wrong), ip: '203.0.113.1' });
      expect(r.status).toBe(401);
    }
    const dead = await call('POST', '/api/v1/account/register', { body: body(code), ip: '203.0.113.1' });
    expect(dead.status).toBe(401);
    expect(dead.json().error.message).toContain('失效');

    clock += 61_000;
    await call('POST', '/api/v1/account/register/code', { body: { email: 'b@school.test', invite: INVITE } });
    clock += 10 * 60_000 + 1;
    const late = await call('POST', '/api/v1/account/register', { body: body(lastCode('b@school.test')) });
    expect(late.status).toBe(401);
    expect(late.json().error.message).toContain('过期');
  });

  test('mail limits: one per minute per address, and the site-wide daily cap', async () => {
    writeHostedConfig(data, config({ emails_per_day: 2 }));
    await start();
    const ask = (email: string) => call('POST', '/api/v1/account/register/code', { body: { email, invite: INVITE } });
    expect((await ask('c@school.test')).status).toBe(204);
    const soon = await ask('c@school.test');
    expect(soon.status).toBe(429);
    expect(soon.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await ask('d@school.test')).status).toBe(204);
    const capped = await ask('e@school.test');
    expect(capped.status).toBe(429);
    expect(capped.json().error.code).toBe('QUOTA_EXCEEDED');
    clock += 24 * 3600_000 + 1;
    expect((await ask('e@school.test')).status).toBe(204);
  });

  test('without a mail service, asking for a code says so', async () => {
    server = await startHostedServer({
      dataDir: data,
      port: 0,
      webDir: join(data, 'no-web'),
      log: () => undefined,
      mailer: noMailer(),
    });
    const r = await call('POST', '/api/v1/account/register/code', { body: { email: 'f@school.test', invite: INVITE } });
    expect(r.status).toBe(503);
    expect(r.json().error).toMatchObject({ code: 'MAIL_FAILED', message: expect.stringContaining('还没有配置发信') });
  });
});

describe('hosted server: signing in', () => {
  test('password sign-in; wrong passwords are counted per address and per email', async () => {
    await start();
    await register('g@school.test', '小高', 'correct-horse');
    const login = (password: string, ip: string) => call('POST', '/api/v1/account/login', { body: { email: 'G@school.test', password }, ip });
    const ok = await login('correct-horse', '203.0.113.2');
    expect(ok.status).toBe(204);
    expect((await call('GET', '/api/v1/account', { cookie: cookieOf(ok) })).json().data.name).toBe('小高');

    const unknown = await call('POST', '/api/v1/account/login', { body: { email: 'nobody@school.test', password: 'x' } });
    expect(unknown.status).toBe(401);
    expect(unknown.json().error.message).toContain('还没有注册');

    for (let i = 0; i < 10; i++) expect((await login('wrong', `198.51.100.${i}`)).status).toBe(401);
    const blocked = await login('correct-horse', '198.51.100.99');
    expect(blocked.status).toBe(429);
    clock += 15 * 60_000 + 1;
    expect((await login('correct-horse', '198.51.100.99')).status).toBe(204);
  });

  test('asking codes for unknown addresses is limited per address, and a spoofed X-Real-IP does not dodge it', async () => {
    await start();
    const ask = (i: number, headers: { ip?: string; realIp?: string }) =>
      call('POST', '/api/v1/account/login/code', { body: { email: `nobody${i}@school.test` }, ip: headers.ip, headers: headers.realIp ? { 'x-real-ip': headers.realIp } : {} });
    for (let i = 0; i < 10; i++) expect((await ask(i, { ip: '203.0.113.50', realIp: `192.0.2.${i}` })).status).toBe(404);
    const blocked = await ask(99, { ip: '203.0.113.50', realIp: '192.0.2.200' });
    expect(blocked.status).toBe(429);
    expect((await ask(100, { ip: '203.0.113.51' })).status).toBe(404);
  });

  test('an emailed code signs in and can set a new password, which signs out other browsers', async () => {
    await start();
    const first = await register('h@school.test', '小何', 'old-password');
    const r1 = await call('POST', '/api/v1/account/login/code', { body: { email: 'h@school.test' } });
    expect(r1.status, r1.body).toBe(204);
    expect(sent.at(-1)!.subject).toContain('登录验证码');
    const r2 = await call('POST', '/api/v1/account/login/verify', { body: { email: 'h@school.test', code: lastCode('h@school.test'), new_password: 'new-password' } });
    expect(r2.status, r2.body).toBe(204);
    expect((await call('GET', '/api/v1/account', { cookie: first })).status).toBe(401);
    expect((await call('GET', '/api/v1/account', { cookie: cookieOf(r2) })).status).toBe(200);
    expect((await call('POST', '/api/v1/account/login', { body: { email: 'h@school.test', password: 'old-password' } })).status).toBe(401);
    expect((await call('POST', '/api/v1/account/login', { body: { email: 'h@school.test', password: 'new-password' } })).status).toBe(204);
    const noAccount = await call('POST', '/api/v1/account/login/code', { body: { email: 'nobody@school.test' } });
    expect(noAccount.status).toBe(404);
  });

  test('changing the password needs the current one (403, not a sign-out) and keeps this browser', async () => {
    await start();
    const a = await register('i@school.test', '小易', 'password-1');
    const other = cookieOf(await call('POST', '/api/v1/account/login', { body: { email: 'i@school.test', password: 'password-1' } }));
    const wrong = await call('POST', '/api/v1/account/password', { cookie: a, body: { current: 'nope', next: 'password-2' } });
    expect(wrong.status).toBe(403);
    expect((await call('POST', '/api/v1/account/password', { cookie: a, body: { current: 'password-1', next: 'password-2' } })).status).toBe(204);
    expect((await call('GET', '/api/v1/account', { cookie: a })).status).toBe(200);
    expect((await call('GET', '/api/v1/account', { cookie: other })).status).toBe(401);
  });

  test('sign out ends the session; sessions and groups survive a restart', async () => {
    await start();
    const a = await register('j@school.test');
    await createGroup(a, '一组');
    const b = cookieOf(await call('POST', '/api/v1/account/login', { body: { email: 'j@school.test', password: 'password-1' } }));
    expect((await call('DELETE', '/api/v1/session', { cookie: b })).status).toBe(204);
    expect((await call('GET', '/api/v1/account', { cookie: b })).status).toBe(401);
    await server!.close();
    await start();
    const h = await call('GET', '/api/v1/health', { cookie: a });
    expect(h.status).toBe(200);
    expect(h.json().data.team_name).toBe('一组');
  });
});

describe('hosted server: groups', () => {
  test('no group yet: project routes answer NO_TEAM; creating one opens its project', async () => {
    await start();
    const a = await register('k@school.test', '小孔');
    const none = await call('GET', '/api/v1/health', { cookie: a });
    expect(none.status).toBe(409);
    expect(none.json().error.code).toBe('NO_TEAM');
    const g = await createGroup(a, '雨夜组');
    expect(g.join_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const h = (await call('GET', '/api/v1/health', { cookie: a })).json().data;
    expect(h).toMatchObject({ hosted: true, team_name: '雨夜组', home_dir: '', project_open: true });
    expect((await call('GET', '/api/v1/project', { cookie: a })).json().data.name).toBe('雨夜组');
    const me = (await call('GET', '/api/v1/account', { cookie: a })).json().data;
    expect(me.group).toMatchObject({ name: '雨夜组', role: 'leader', max_members: 12, members: [{ name: '小孔', role: 'leader', you: true }] });
  });

  test('a teammate joins with the code or the link and sees the same project; other groups see nothing', async () => {
    await start();
    const a = await register('l@school.test', '组长');
    const b = await register('m@school.test', '组员');
    const c = await register('n@school.test', '别组');
    const g = await createGroup(a, '一组');
    await createGroup(c, '二组');
    const preview = await call('POST', '/api/v1/group/preview', { cookie: b, body: { code: g.join_code.toLowerCase() } });
    expect(preview.json().data).toEqual({ name: '一组', members: 1, full: false });
    const joined = await joinGroup(b, `${PUBLIC}/#join=${g.join_code}`);
    expect(joined.status, joined.body).toBe(200);
    expect(joined.json().data.members.map((m: { name: string }) => m.name)).toEqual(['组长', '组员']);

    const made = await call('POST', '/api/v1/entities', { cookie: a, body: { type: 'character', name: '店主', aliases: [] } });
    expect(made.status, made.body).toBe(201);
    const names = async (cookie: string) => ((await call('GET', '/api/v1/entities', { cookie })).json().data as { name: string }[]).map((e) => e.name);
    expect(await names(b)).toContain('店主');
    expect(await names(c)).not.toContain('店主');
  });

  test('wrong join codes are limited per account', async () => {
    await start();
    const a = await register('o@school.test');
    for (let i = 0; i < 10; i++) expect((await joinGroup(a, `ZZZZ-ZZZ${i}`)).status).toBe(404);
    expect((await joinGroup(a, 'ZZZZ-ZZZZ')).status).toBe(429);
  });

  test('leaving passes the lead on; the leader removes members and replaces the code; a removed member gets NO_TEAM at once', async () => {
    await start();
    const a = await register('p@school.test', '甲');
    const b = await register('q@school.test', '乙');
    const c = await register('r@school.test', '丙');
    const g = await createGroup(a, '三组');
    await joinGroup(b, g.join_code);
    await joinGroup(c, g.join_code);

    const notLeader = await call('POST', '/api/v1/group/code', { cookie: b });
    expect(notLeader.status).toBe(403);
    const reset = (await call('POST', '/api/v1/group/code', { cookie: a })).json().data;
    expect(reset.join_code).not.toBe(g.join_code);
    expect((await joinGroup(await register('s@school.test'), g.join_code)).status).toBe(404);

    const cId = reset.members.find((m: { name: string }) => m.name === '丙').id;
    const removed = await call('DELETE', `/api/v1/group/members/${cId}`, { cookie: a });
    expect(removed.json().data.members.map((m: { name: string }) => m.name)).toEqual(['甲', '乙']);
    expect((await call('GET', '/api/v1/health', { cookie: c })).json().error.code).toBe('NO_TEAM');

    expect((await call('POST', '/api/v1/group/leave', { cookie: a })).status).toBe(204);
    const me = (await call('GET', '/api/v1/account', { cookie: b })).json().data;
    expect(me.group.role).toBe('leader');
    expect(me.group.members).toHaveLength(1);
    // the last one cannot just leave
    expect((await call('POST', '/api/v1/group/leave', { cookie: b })).status).toBe(409);
  });

  test('joining another group leaves the current one (not when alone in it); disbanding needs to be alone and deletes the project', async () => {
    await start();
    const a = await register('t@school.test', '甲');
    const b = await register('u@school.test', '乙');
    const g1 = await createGroup(a, '四组');
    const g2 = await createGroup(b, '五组');
    const alone = await joinGroup(a, g2.join_code);
    expect(alone.status).toBe(409);
    expect(alone.json().error.message).toContain('解散');

    expect((await call('POST', '/api/v1/group/disband', { cookie: a, body: { confirm: true } })).status).toBe(204);
    expect(existsSync(teamDir(data, g1.slug))).toBe(false);
    expect((await joinGroup(a, g2.join_code)).status).toBe(200);
    expect((await call('GET', '/api/v1/account', { cookie: a })).json().data.group.name).toBe('五组');

    const busy = await call('POST', '/api/v1/group/disband', { cookie: b, body: { confirm: true } });
    expect(busy.status).toBe(409);
    expect((await call('POST', '/api/v1/group/disband', { cookie: a, body: { confirm: true } })).status).toBe(403); // not the leader

    // switching groups from a group with others in it just leaves it
    const c = await register('c2@school.test', '丙');
    const g3 = await createGroup(c, '六组');
    expect((await joinGroup(a, g3.join_code)).status).toBe(200);
    expect((await call('GET', '/api/v1/account', { cookie: b })).json().data.group.members).toHaveLength(1);
    expect(existsSync(teamDir(data, g2.slug))).toBe(true);
    expect((await call('POST', '/api/v1/group/disband', { cookie: b, body: { confirm: true } })).status).toBe(204);
    expect(existsSync(teamDir(data, g2.slug))).toBe(false);
    expect((await call('GET', '/api/v1/account', { cookie: b })).json().data.group).toBeNull();
  });

  test('group and member caps', async () => {
    writeHostedConfig(data, config({ max_teams: 1, max_team_members: 2 }));
    await start();
    const a = await register('v@school.test');
    const b = await register('w@school.test');
    const c = await register('x@school.test');
    const g = await createGroup(a, '唯一组');
    const second = await call('POST', '/api/v1/group', { cookie: b, body: { name: '第二组' } });
    expect(second.status).toBe(409);
    expect(second.json().error.code).toBe('QUOTA_EXCEEDED');
    expect((await joinGroup(b, g.join_code)).status).toBe(200);
    const full = await joinGroup(c, g.join_code);
    expect(full.status).toBe(409);
    expect(full.json().error.message).toContain('满员');
  });
});

describe('hosted server: what a group cannot do, and the front door', () => {
  test.each([
    ['POST', '/api/v1/projects/open', { dir: '/etc' }],
    ['POST', '/api/v1/projects', { dir: '/tmp/x', name: 'x', timezone: 'Asia/Shanghai', default_aspect: '2.39', target_duration_s: null }],
    ['POST', '/api/v1/projects/close', undefined],
    ['POST', '/api/v1/platform/choose-folder', undefined],
    ['PUT', '/api/v1/settings/providers/text', { base_url: 'http://169.254.169.254', model: 'x', api_key: 'k' }],
    ['POST', '/api/v1/media/roots', { abs_path: '/etc' }],
  ])('%s %s is refused on a hosted server', async (method, path, body) => {
    await start();
    const cookie = await register('y@school.test');
    await createGroup(cookie, '六组');
    const r = await call(method, path, { cookie, body });
    expect(r.status, r.body).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
    expect((await call('GET', '/api/v1/projects/recent', { cookie })).json().data).toEqual([]);
  });

  test('Host and Origin are checked against the public address', async () => {
    await start();
    const body = { email: 'z@school.test', invite: INVITE };
    expect((await call('GET', '/api/v1/site', { host: 'story.example.test' })).status).toBe(200);
    expect((await call('GET', '/api/v1/site', { host: 'evil.test' })).status).toBe(403);
    expect((await call('POST', '/api/v1/account/register/code', { body, origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('POST', '/api/v1/account/register/code', { body, origin: null })).status).toBe(403);
    expect((await call('POST', '/api/v1/account/register/code', { body, origin: PUBLIC, host: 'story.example.test' })).status).toBe(204);
  });
});

describe('hosted server: admin commands', () => {
  test('init needs an invite and a sender; invite set, user list/remove, team list/remove', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssm-hosted-cli-'));
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const base = ['init', '--data', dir, '--origin', 'https://Story.Example.test/', '--name', '短片节'];
      expect(await runServerCli([...base, '--mail-from', 'noreply@story.example.test'])).toBe(2);
      expect(await runServerCli([...base, '--invite', 'first-code'])).toBe(2);
      expect(await runServerCli([...base, '--invite', 'first-code', '--mail-from', 'not-an-address'])).toBe(2);
      expect(await runServerCli([...base, '--invite', 'first-code', '--mail-from', 'noreply@story.example.test'])).toBe(0);
      const saved = readHostedConfig(dir)!;
      expect(saved).toMatchObject({ version: 2, public_origin: 'https://story.example.test', mail: { from: 'StoryScript-Mov <noreply@story.example.test>' } });
      expect(saved.limits).toEqual({ llm_jobs_per_day: 200, image_jobs_per_day: 20, emails_per_day: 100, max_teams: 60, max_team_members: 12 });
      expect(JSON.stringify(saved)).not.toContain('first-code');
      expect(await runServerCli(['init', '--data', dir, '--origin', 'https://x.test/sub', '--invite', 'abcd', '--mail-from', 'a@b.test'])).toBe(2);

      data = dir;
      await start();
      expect(await runServerCli(['invite', 'set', 'second-code', '--data', dir])).toBe(1); // refused while running
      const wrongInvite = await call('POST', '/api/v1/account/register/code', { body: { email: 'aa@school.test', invite: 'second-code' } });
      expect(wrongInvite.status).toBe(403);
      const a = cookieOf(
        await (async () => {
          await call('POST', '/api/v1/account/register/code', { body: { email: 'aa@school.test', invite: 'first-code' } });
          return call('POST', '/api/v1/account/register', { body: { email: 'aa@school.test', code: lastCode('aa@school.test'), name: '小安', password: 'password-1' } });
        })(),
      );
      const g = await createGroup(a, '七组');

      out.length = 0;
      expect(await runServerCli(['user', 'list', '--data', dir])).toBe(0);
      expect(out.join('\n')).toMatch(/aa@school\.test\t小安\t七组（组长）/);
      out.length = 0;
      expect(await runServerCli(['team', 'list', '--data', dir])).toBe(0);
      expect(out.join('\n')).toContain(`组码 ${g.join_code}`);
      expect(await runServerCli(['team', 'remove', g.slug, '--data', dir])).toBe(1); // refused while running

      // removing an account signs it out at once, even while the server runs
      expect(await runServerCli(['user', 'remove', 'AA@school.test', '--data', dir])).toBe(0);
      expect((await call('GET', '/api/v1/account', { cookie: a })).status).toBe(401);

      await server!.close();
      server = null;
      expect(await runServerCli(['invite', 'set', 'second-code', '--data', dir])).toBe(0);
      expect(readHostedConfig(dir)!.invite_sha256).toBe(hashInvite('second-code'));
      expect(await runServerCli(['team', 'remove', g.slug, '--data', dir])).toBe(0);
      const site = SiteDb.open(dir);
      expect(site.listTeams()).toEqual([]);
      site.close();
      expect(existsSync(teamDir(dir, g.slug))).toBe(true); // project files kept
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test('mail test writes to the outbox when one is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssm-hosted-mail-'));
    const outbox = join(dir, 'outbox');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('STORYSCRIPT_MAIL_OUTBOX', outbox);
    try {
      writeHostedConfig(dir, config());
      expect(await runServerCli(['mail', 'test', 'admin@school.test', '--data', dir])).toBe(0);
      expect(existsSync(outbox)).toBe(true);
      expect(await runServerCli(['mail', 'test', 'not-an-email', '--data', dir])).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

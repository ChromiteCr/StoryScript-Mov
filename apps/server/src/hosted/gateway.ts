import type { IncomingMessage } from 'node:http';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  Api,
  ChangePasswordInput,
  CodeLoginInput,
  CreateGroupInput,
  DisbandGroupInput,
  EmailOnlyInput,
  JoinGroupInput,
  PasswordLoginInput,
  RegisterCodeInput,
  RegisterInput,
  type AccountMe,
  type SiteInfo,
} from '@storyscript/contracts';
import { AppError, errorBody, onError } from '../http/errors.ts';
import { parseBody } from '../http/validate.ts';
import { registerStaticRoutes } from '../routes/static.ts';
import { SAFE_METHODS, headersMiddleware } from '../security/guards.ts';
import { SESSION_COOKIE } from '../security/sessions.ts';
import type { Accounts } from './accounts.ts';
import type { HostedConfig } from './config.ts';
import type { Groups } from './groups.ts';
import { SESSION_TTL_MS, type Account, type SiteDb } from './site-db.ts';
import type { TeamRuntime } from './teams.ts';

/**
 * The hosted server's front door. Every request passes Host and Origin checks
 * against the configured public origin (plus loopback, for a reverse proxy
 * that rewrites Host). Accounts and groups are answered here; every other
 * /api request goes to the signed-in account's group instance, looked up on
 * each request, so groups never see each other's data and leaving a group
 * takes effect at once. The frontend is served here as static files.
 */

export interface GatewayOptions {
  config: HostedConfig;
  site: SiteDb;
  accounts: Accounts;
  groups: Groups;
  runtime: TeamRuntime;
  webDir: string;
}

const NOT_SIGNED_IN = '请先登录。';

/**
 * The address to rate-limit by. Behind a reverse proxy on the same machine the
 * peer is loopback: the last X-Forwarded-For hop is the one the proxy itself
 * appended (Caddy and the documented Nginx setup both add it), so a browser
 * cannot choose it. X-Real-IP counts only when no proxy hop is present, since
 * a proxy that does not overwrite it passes the browser's own value through.
 */
export function clientAddress(c: Context): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  const peer = incoming?.socket?.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hops.length > 0) return hops.at(-1)!;
  return c.req.header('x-real-ip')?.trim() || peer;
}

export function createGateway(o: GatewayOptions): Hono {
  const { config, site, accounts, groups, runtime } = o;
  const publicUrl = new URL(config.public_origin);
  const loopback = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const hosts = new Set([publicUrl.host, ...loopback]);
  const origins = new Set([config.public_origin, ...loopback.map((h) => `http://${h}`)]);
  const secureCookie = publicUrl.protocol === 'https:';

  const hostGuard: MiddlewareHandler = async (c, next) => {
    const host = (c.req.header('host') ?? '').trim().toLowerCase();
    if (!hosts.has(host)) return c.json(errorBody('FORBIDDEN', `拒绝访问：请通过 ${config.public_origin} 打开`), 403);
    await next();
  };
  const originGuard: MiddlewareHandler = async (c, next) => {
    const origin = (c.req.header('origin') ?? '').trim().toLowerCase();
    if (!SAFE_METHODS.has(c.req.method) && !origins.has(origin)) {
      return c.json(errorBody('FORBIDDEN', '拒绝访问：跨源请求已被拦截'), 403);
    }
    await next();
  };

  const signIn = (c: Context, session: string) => {
    // a browser switching accounts drops its old session first
    site.revokeSession(getCookie(c, SESSION_COOKIE));
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: secureCookie,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };
  /** The signed-in account and the group this browser works in (re-checked on every request). */
  const who = (c: Context): { account: Account; sessionId: string; current: string | null } => {
    const sessionId = getCookie(c, SESSION_COOKIE) ?? '';
    const s = site.session(sessionId);
    if (!s) throw new AppError('UNAUTHORIZED', NOT_SIGNED_IN, 401);
    const current = groups.resolveCurrent(s.account, s.current_team);
    if (current !== s.current_team) site.setSessionTeam(sessionId, current);
    return { account: s.account, sessionId, current };
  };
  const accountOf = (c: Context): Account => who(c).account;
  const slugOf = (c: Context) => c.req.param('slug') ?? '';
  const me = (account: Account, current: string | null): AccountMe => ({
    email: account.email,
    name: account.name,
    group: groups.view(account, current),
    groups: groups.list(account),
    max_groups: groups.maxGroups,
  });

  const gw = new Hono();
  gw.onError(onError);
  gw.notFound((c) => (c.req.path.startsWith('/api') ? c.json(errorBody('NOT_FOUND', '接口不存在'), 404) : c.text('Not Found', 404)));
  gw.use('*', headersMiddleware('production'));
  gw.use('*', hostGuard);
  gw.use('*', originGuard);

  gw.get(Api.site.path, (c) => c.json({ data: { hosted: true, name: config.site_name } satisfies SiteInfo }));

  // the local app trades a terminal token for a cookie here; the hosted server signs in with accounts
  gw.post(Api.session.path, (c) => c.json(errorBody('NOT_FOUND', '服务器版请用邮箱登录。'), 404));
  gw.delete(Api.logout.path, (c) => {
    site.revokeSession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secureCookie });
    return c.body(null, 204);
  });

  // ---- accounts ----

  gw.post(Api.registerCode.path, async (c) => {
    const input = await parseBody(c, RegisterCodeInput);
    await accounts.sendRegisterCode(input.email, input.invite, clientAddress(c));
    return c.body(null, 204);
  });
  gw.post(Api.register.path, async (c) => {
    const input = await parseBody(c, RegisterInput);
    const r = await accounts.register(input, clientAddress(c));
    signIn(c, r.session);
    return c.body(null, 204);
  });
  gw.post(Api.passwordLogin.path, async (c) => {
    const input = await parseBody(c, PasswordLoginInput);
    const r = await accounts.passwordLogin(input.email, input.password, clientAddress(c));
    signIn(c, r.session);
    return c.body(null, 204);
  });
  gw.post(Api.loginCode.path, async (c) => {
    const input = await parseBody(c, EmailOnlyInput);
    await accounts.sendLoginCode(input.email, clientAddress(c));
    return c.body(null, 204);
  });
  gw.post(Api.codeLogin.path, async (c) => {
    const input = await parseBody(c, CodeLoginInput);
    const r = await accounts.codeLogin(input, clientAddress(c));
    signIn(c, r.session);
    return c.body(null, 204);
  });
  gw.get(Api.me.path, (c) => {
    const w = who(c);
    return c.json({ data: me(w.account, w.current) });
  });
  gw.post(Api.changePassword.path, async (c) => {
    const account = accountOf(c);
    const input = await parseBody(c, ChangePasswordInput);
    await accounts.changePassword(account, input.current, input.next, getCookie(c, SESSION_COOKIE)!);
    return c.body(null, 204);
  });

  // ---- groups ----

  // creating, joining or switching makes that group this browser's current one
  gw.post(Api.createGroup.path, async (c) => {
    const w = who(c);
    const input = await parseBody(c, CreateGroupInput);
    const g = await groups.create(w.account, input.name);
    site.setSessionTeam(w.sessionId, g.slug);
    return c.json({ data: g }, 201);
  });
  gw.post(Api.previewGroup.path, async (c) => {
    const account = accountOf(c);
    const input = await parseBody(c, JoinGroupInput);
    return c.json({ data: groups.preview(account, input.code) });
  });
  gw.post(Api.joinGroup.path, async (c) => {
    const w = who(c);
    const input = await parseBody(c, JoinGroupInput);
    const g = groups.join(w.account, input.code);
    site.setSessionTeam(w.sessionId, g.slug);
    return c.json({ data: g });
  });
  gw.post(Api.switchGroup.path, (c) => {
    const w = who(c);
    const g = groups.view(w.account, slugOf(c));
    if (!g) throw new AppError('NOT_FOUND', '你不在这个小组里。', 404);
    site.setSessionTeam(w.sessionId, g.slug);
    return c.json({ data: g });
  });
  // leaving or disbanding the current group: the next request falls back to another group (resolveCurrent)
  gw.post(Api.leaveGroup.path, (c) => {
    groups.leave(accountOf(c), slugOf(c));
    return c.body(null, 204);
  });
  gw.post(Api.resetGroupCode.path, (c) => c.json({ data: groups.resetCode(accountOf(c), slugOf(c)) }));
  gw.delete(Api.removeGroupMember.path, (c) => c.json({ data: groups.removeMember(accountOf(c), slugOf(c), c.req.param('id') ?? '') }));
  gw.post(Api.disbandGroup.path, async (c) => {
    const account = accountOf(c);
    await parseBody(c, DisbandGroupInput);
    groups.disband(account, slugOf(c));
    return c.body(null, 204);
  });

  // ---- everything else: the account's group instance ----

  const forward = async (c: Context) => {
    const { current } = who(c);
    const team = current ? runtime.get(current) : undefined;
    if (!team) return c.json(errorBody('NO_TEAM', '你还没有加入小组：创建一个，或用组长发的链接加入。'), 409);
    return team.fetch(c.req.raw, c.env);
  };
  gw.all('/api', forward);
  gw.all('/api/*', forward);

  registerStaticRoutes(gw, o.webDir);
  return gw;
}

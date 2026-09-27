import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { Api, type SiteInfo } from '@storyscript/contracts';
import { errorBody, onError } from '../http/errors.ts';
import { parseBody } from '../http/validate.ts';
import { registerStaticRoutes } from '../routes/static.ts';
import { SAFE_METHODS, headersMiddleware } from '../security/guards.ts';
import { SESSION_COOKIE } from '../security/sessions.ts';
import { hashTeamCode, type HostedConfig } from './config.ts';
import { HOSTED_SESSION_TTL_MS, type HostedSessions, type LoginLimiter } from './sessions.ts';

/**
 * The hosted server's front door. Every request passes Host and Origin checks
 * against the configured public origin (plus loopback, for a reverse proxy
 * that rewrites Host). Signing in with a team code sets a session cookie; every
 * other /api request is forwarded to that team's own app instance, so teams
 * never see each other's data. The frontend is served here as static files.
 */

export interface GatewayTeam {
  name: string;
  fetch: (req: Request, env?: unknown) => Response | Promise<Response>;
}

export interface GatewayOptions {
  config: HostedConfig;
  teams: ReadonlyMap<string, GatewayTeam>;
  sessions: HostedSessions;
  limiter: LoginLimiter;
  webDir: string;
}

const LoginInput = z.object({ token: z.string().min(1).max(200) });

const NOT_SIGNED_IN = '请用队伍口令或管理员发的邀请链接登录。';

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Team slug for a typed code, comparing against every team so timing does not tell which one matched. */
function teamForCode(config: HostedConfig, code: string): string | null {
  const h = hashTeamCode(code);
  let found: string | null = null;
  for (const t of config.teams) if (sameHex(h, t.code_sha256) && found === null) found = t.slug;
  return found;
}

/**
 * The address to rate-limit by. Behind a reverse proxy on the same machine the
 * peer is loopback: X-Real-IP, else the last X-Forwarded-For hop (the one the
 * proxy appended), identifies the browser.
 */
export function clientAddress(c: Context): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  const peer = incoming?.socket?.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? peer;
}

export function createGateway(o: GatewayOptions): Hono {
  const { config, teams, sessions, limiter } = o;
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

  const gw = new Hono();
  gw.onError(onError);
  gw.notFound((c) => (c.req.path.startsWith('/api') ? c.json(errorBody('NOT_FOUND', '接口不存在'), 404) : c.text('Not Found', 404)));
  gw.use('*', headersMiddleware('production'));
  gw.use('*', hostGuard);
  gw.use('*', originGuard);

  gw.get(Api.site.path, (c) => c.json({ data: { hosted: true, name: config.site_name } satisfies SiteInfo }));

  gw.post(Api.session.path, async (c) => {
    const who = clientAddress(c);
    const wait = limiter.retryAfter(who);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(errorBody('TOO_MANY_ATTEMPTS', `队伍口令输错次数太多，请 ${Math.ceil(wait / 60)} 分钟后再试。`, { retry_after_s: wait }), 429);
    }
    const { token } = await parseBody(c, LoginInput);
    const slug = teamForCode(config, token);
    if (!slug || !teams.has(slug)) {
      limiter.fail(who);
      return c.json(errorBody('UNAUTHORIZED', '队伍口令不对。请检查后重新输入，或使用管理员发的邀请链接。'), 401);
    }
    limiter.succeed(who);
    // a browser switching teams drops its old session first
    sessions.revoke(getCookie(c, SESSION_COOKIE));
    setCookie(c, SESSION_COOKIE, sessions.create(slug), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: secureCookie,
      path: '/',
      maxAge: Math.floor(HOSTED_SESSION_TTL_MS / 1000),
    });
    return c.body(null, 204);
  });

  gw.delete(Api.logout.path, (c) => {
    sessions.revoke(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secureCookie });
    return c.body(null, 204);
  });

  const forward = async (c: Context) => {
    const slug = sessions.team(getCookie(c, SESSION_COOKIE));
    const team = slug ? teams.get(slug) : undefined;
    if (!team) return c.json(errorBody('UNAUTHORIZED', NOT_SIGNED_IN), 401);
    return team.fetch(c.req.raw, c.env);
  };
  gw.all('/api', forward);
  gw.all('/api/*', forward);

  registerStaticRoutes(gw, o.webDir);
  return gw;
}

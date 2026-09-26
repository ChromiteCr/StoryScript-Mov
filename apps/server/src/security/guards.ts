import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { errorBody } from '../http/errors.ts';
import { SESSION_COOKIE, type SessionStore } from './sessions.ts';

/**
 * AT-17 request guards (SPEC §6):
 *   1. Host ∈ {127.0.0.1:port, localhost:port}          → else 403 (DNS rebinding)
 *   2. unsafe methods need a same-origin Origin header  → else 403 (CSRF)
 *   3. /api/** needs a session cookie (except the token exchange) → else 401
 * No CORS headers are ever emitted.
 */

export type ServerMode = 'production' | 'development';

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const SESSION_PATH = '/api/v1/session';
export const UNAUTHORIZED_MESSAGE = '未登录或会话已失效：请使用终端打印的链接，或运行 storyscript-mov open';

export function allowedHosts(port: number): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return port === 80 ? [...hosts, '127.0.0.1', 'localhost'] : hosts;
}

export function isAllowedHost(host: string | undefined | null, port: number): boolean {
  if (!host) return false;
  return allowedHosts(port).includes(host.trim().toLowerCase());
}

/** Origin must be exactly http://<the request's own allowed Host>. */
export function isSameOrigin(origin: string | undefined | null, host: string | undefined | null, port: number): boolean {
  if (!origin || !host || !isAllowedHost(host, port)) return false;
  return origin.trim().toLowerCase() === `http://${host.trim().toLowerCase()}`;
}

const PROD_CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Vite dev needs inline scripts/styles (HMR preamble, injected CSS) and a ws: HMR socket. */
const DEV_CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(mode: ServerMode): Record<string, string> {
  return {
    'Content-Security-Policy': mode === 'production' ? PROD_CSP : DEV_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

function requestHost(c: Parameters<MiddlewareHandler>[0]): string | undefined {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

export function headersMiddleware(mode: ServerMode): MiddlewareHandler {
  const headers = securityHeaders(mode);
  return async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
    if (c.req.path.startsWith('/api/')) c.res.headers.set('Cache-Control', 'no-store');
  };
}

export function hostGuard(port: number): MiddlewareHandler {
  return async (c, next) => {
    if (!isAllowedHost(requestHost(c), port)) {
      return c.json(errorBody('FORBIDDEN', '拒绝访问：只接受来自 127.0.0.1 或 localhost 的请求'), 403);
    }
    await next();
  };
}

export function originGuard(port: number): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && !isSameOrigin(c.req.header('origin'), requestHost(c), port)) {
      return c.json(errorBody('FORBIDDEN', '拒绝访问：跨源请求已被拦截'), 403);
    }
    await next();
  };
}

export function authGuard(sessions: SessionStore): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const isApi = path === '/api' || path.startsWith('/api/');
    const isExchange = c.req.method === 'POST' && path === SESSION_PATH;
    if (isApi && !isExchange && !sessions.has(getCookie(c, SESSION_COOKIE))) {
      return c.json(errorBody('UNAUTHORIZED', UNAUTHORIZED_MESSAGE), 401);
    }
    await next();
  };
}

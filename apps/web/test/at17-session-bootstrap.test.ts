import { describe, expect, it, vi } from 'vitest';
import type { HealthInfo } from '@storyscript/contracts';
import { createApiClient, type FetchLike } from '../src/lib/api.ts';
import {
  bootstrapSession,
  isSessionExpired,
  markSessionExpired,
  readTokenFromHash,
  subscribeSessionExpired,
  type BootDeps,
} from '../src/lib/session.ts';

// AT-17 (web side): fragment token → POST /session → fragment removed; 401 → expired screen.

const TOKEN = 'k7Qp2vXw9LmN4rTs8YbZ1cDe6FgH3jKa';

const HEALTH: HealthInfo = {
  app_version: '0.0.0',
  node: 'v26.10.0',
  sqlite: '3.50.0',
  ffmpeg: { path: null, version: null },
  ffprobe: { path: null, version: null },
  encoders: [],
  project_open: false,
  text_provider_configured: false,
  image_provider_configured: false,
  demo: true,
  home_dir: '/home/someone',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = () => json(401, { error: { code: 'UNAUTHORIZED', message: 'no session', retryable: false } });

type Route = (init: RequestInit) => Response;

function setup(hash: string, routes: { session?: Route; health: Route | 'down' }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/v1/session' && routes.session) return routes.session(init);
    if (url === '/api/v1/health') {
      if (routes.health === 'down') throw new TypeError('Failed to fetch');
      return routes.health(init);
    }
    return json(404, { error: { code: 'NOT_FOUND', message: url, retryable: false } });
  };
  const location = { hash, pathname: '/', search: '?x=1' };
  const replaceState = vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => {
    location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '';
  });
  const deps: BootDeps = { client: createApiClient(fetch), location, history: { state: { keep: 1 }, replaceState } };
  return { deps, calls, replaceState, location };
}

describe('AT-17 readTokenFromHash', () => {
  it('reads t from the fragment without treating + as space', () => {
    expect(readTokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(readTokenFromHash('#a=1&t=ab+c%2Fd')).toBe('ab+c/d');
    expect(readTokenFromHash('#/script')).toBeNull();
    expect(readTokenFromHash('')).toBeNull();
    expect(readTokenFromHash('#t=')).toBeNull();
    expect(readTokenFromHash('#t=%E0%A4%A')).toBeNull();
  });
});

describe('AT-17 bootstrapSession', () => {
  it('exchanges the token, then removes the fragment, then checks health', async () => {
    const s = setup(`#t=${TOKEN}`, { session: () => json(200, { data: { ok: true } }), health: () => json(200, { data: HEALTH }) });
    const r = await bootstrapSession(s.deps);

    expect(r).toEqual({ kind: 'ready', health: HEALTH });
    expect(s.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST /api/v1/session', 'GET /api/v1/health']);
    const post = s.calls[0]?.init;
    expect(post?.credentials).toBe('same-origin');
    expect((post?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(post?.body))).toEqual({ token: TOKEN });
    expect(s.replaceState).toHaveBeenCalledTimes(1);
    expect(s.replaceState).toHaveBeenCalledWith({ keep: 1 }, '', '/?x=1');
    expect(s.location.hash).toBe('');
  });

  it('shows the expired state when the token is rejected and there is no cookie', async () => {
    const s = setup(`#t=${TOKEN}`, { session: unauthorized, health: unauthorized });
    expect(await bootstrapSession(s.deps)).toEqual({ kind: 'expired' });
    expect(s.replaceState).not.toHaveBeenCalled();
  });

  it('continues with an existing cookie when the token is stale, and still drops it', async () => {
    const s = setup(`#t=${TOKEN}`, { session: unauthorized, health: () => json(200, { data: HEALTH }) });
    expect((await bootstrapSession(s.deps)).kind).toBe('ready');
    expect(s.replaceState).toHaveBeenCalledTimes(1);
  });

  it('without a token, skips the exchange and reports 401 as expired', async () => {
    const s = setup('#/plan', { health: unauthorized });
    expect(await bootstrapSession(s.deps)).toEqual({ kind: 'expired' });
    expect(s.calls.map((c) => c.url)).toEqual(['/api/v1/health']);
    expect(s.replaceState).not.toHaveBeenCalled();
  });

  it('reports an unreachable server separately from an expired session', async () => {
    const s = setup('', { health: 'down' });
    const r = await bootstrapSession(s.deps);
    expect(r.kind).toBe('unreachable');
    if (r.kind === 'unreachable') expect(r.error.code).toBe('NETWORK_ERROR');
  });
});

describe('AT-17 session-expired flag', () => {
  it('notifies subscribers once', () => {
    const listener = vi.fn();
    const off = subscribeSessionExpired(listener);
    expect(isSessionExpired()).toBe(false);
    markSessionExpired();
    markSessionExpired();
    expect(isSessionExpired()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

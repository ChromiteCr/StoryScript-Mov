import { describe, expect, expectTypeOf, it } from 'vitest';
import type { HealthInfo, Project, RecentProject } from '@storyscript/contracts';
import { ApiClientError, createApiClient, fillPath, type FetchLike } from '../src/lib/api.ts';
import { describeError } from '../src/lib/errors.ts';

const HEALTH: HealthInfo = {
  app_version: '0.0.0',
  node: 'v26.10.0',
  sqlite: '3.50.0',
  ffmpeg: { path: '/opt/homebrew/bin/ffmpeg', version: '7.1' },
  ffprobe: { path: '/opt/homebrew/bin/ffprobe', version: '7.1' },
  encoders: ['h264_videotoolbox'],
  project_open: false,
  text_provider_configured: false,
  image_provider_configured: false,
  demo: false,
};

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function caught(p: Promise<unknown>): Promise<ApiClientError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiClientError);
    return e as ApiClientError;
  }
  throw new Error('expected rejection');
}

describe('api client: success envelope', () => {
  it('unwraps { data } and validates it with the output schema', async () => {
    const m = mockFetch(() => json(200, { data: HEALTH }));
    const client = createApiClient(m.fetch);
    const health = await client.call('health');
    expect(health).toEqual(HEALTH);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.url).toBe('/api/v1/health');
    expect(m.calls[0]?.init.method).toBe('GET');
    expect(m.calls[0]?.init.credentials).toBe('same-origin');
    expect(m.calls[0]?.init.body).toBeUndefined();
    expect((m.calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sends validated JSON input with Content-Type', async () => {
    const project: Project = {
      id: '0b9c8a4e-6d0f-4d4e-9d7c-2f1e0a9b8c7d',
      name: '周末短片',
      timezone: 'Asia/Shanghai',
      default_aspect: '2.39',
      target_duration_s: 600,
      look_preset_id: 'wide-pencil',
      code_format: 'S{scene:02}-{shot:03}-T{take:02}',
      schema_version: 1,
      created_at: '2026-09-26T08:00:00.000Z',
      updated_at: '2026-09-26T08:00:00.000Z',
    };
    const m = mockFetch(() => json(201, { data: project }));
    const client = createApiClient(m.fetch);
    const input = {
      dir: '/tmp/demo',
      name: '周末短片',
      timezone: 'Asia/Shanghai',
      default_aspect: '2.39' as const,
      target_duration_s: 600,
    };
    const out = await client.call('createProject', input);
    expect(out).toEqual(project);
    const init = m.calls[0]?.init;
    expect(m.calls[0]?.url).toBe('/api/v1/projects');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it('returns undefined for endpoints without an output schema, including empty 204', async () => {
    const empty = createApiClient(mockFetch(() => new Response(null, { status: 204 })).fetch);
    await expect(empty.call('closeProject')).resolves.toBeUndefined();
    const enveloped = createApiClient(mockFetch(() => json(200, { data: { ok: true } })).fetch);
    await expect(enveloped.call('closeProject')).resolves.toEqual({ ok: true });
  });

  it('infers input and output types from the contract', () => {
    const client = createApiClient(mockFetch(() => json(200, { data: [] })).fetch);
    expectTypeOf(client.call<'health'>).returns.resolves.toEqualTypeOf<HealthInfo>();
    expectTypeOf(client.call<'recentProjects'>).returns.resolves.toEqualTypeOf<RecentProject[]>();
    expectTypeOf(client.call<'chooseFolder'>).returns.resolves.toEqualTypeOf<{ path: string | null }>();
  });
});

describe('api client: errors', () => {
  it('maps the ApiError envelope to ApiClientError with code, status, retryable, details', async () => {
    const details = { pid: 4242, hostname: 'studio-mac', started_at: '2026-09-26T08:00:00.000Z' };
    const client = createApiClient(
      mockFetch(() => json(423, { error: { code: 'PROJECT_LOCKED', message: 'project is locked', retryable: false, details } })).fetch,
    );
    const e = await caught(client.call('openProject', { dir: '/tmp/p' }));
    expect(e.code).toBe('PROJECT_LOCKED');
    expect(e.status).toBe(423);
    expect(e.retryable).toBe(false);
    expect(e.details).toEqual(details);
    expect(e.message).toBe('project is locked');
  });

  it('falls back to the HTTP status when there is no envelope', async () => {
    const cases: [number, string, string][] = [
      [401, 'nope', 'UNAUTHORIZED'],
      [403, '<html>forbidden</html>', 'FORBIDDEN'],
      [404, '', 'NOT_FOUND'],
      [500, 'boom', 'INTERNAL'],
      [418, '{}', 'BAD_RESPONSE'],
    ];
    for (const [status, body, code] of cases) {
      const client = createApiClient(mockFetch(() => new Response(body, { status })).fetch);
      const e = await caught(client.call('health'));
      expect([status, e.code]).toEqual([status, code]);
      expect(e.status).toBe(status);
    }
  });

  it('keeps the server message when the envelope has an unknown code', async () => {
    const client = createApiClient(
      mockFetch(() => json(409, { error: { code: 'SOMETHING_NEW', message: 'new failure', retryable: true } })).fetch,
    );
    const e = await caught(client.call('health'));
    expect(e.code).toBe('BAD_RESPONSE');
    expect(e.message).toBe('new failure');
    expect(e.retryable).toBe(true);
  });

  it('rejects success bodies that break the contract or miss the envelope', async () => {
    const wrongShape = createApiClient(mockFetch(() => json(200, { data: { ...HEALTH, demo: 'yes' } })).fetch);
    const e1 = await caught(wrongShape.call('health'));
    expect(e1.code).toBe('BAD_RESPONSE');
    expect(e1.message).toContain('demo');

    const noEnvelope = createApiClient(mockFetch(() => json(200, HEALTH)).fetch);
    expect((await caught(noEnvelope.call('health'))).code).toBe('BAD_RESPONSE');

    const notJson = createApiClient(mockFetch(() => new Response('<html></html>', { status: 200 })).fetch);
    expect((await caught(notJson.call('health'))).code).toBe('BAD_RESPONSE');

    const empty = createApiClient(mockFetch(() => new Response(null, { status: 204 })).fetch);
    expect((await caught(empty.call('health'))).code).toBe('BAD_RESPONSE');
  });

  it('validates input before sending', async () => {
    const m = mockFetch(() => json(200, { data: null }));
    const client = createApiClient(m.fetch);
    const e = await caught(client.call('session', { token: 'short' }));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.status).toBe(0);
    expect(m.calls).toHaveLength(0);
  });

  it('turns a failed fetch into a retryable NETWORK_ERROR but rethrows aborts', async () => {
    const down = createApiClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    const e = await caught(down.call('health'));
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.retryable).toBe(true);
    expect(e.status).toBe(0);

    const abort = new DOMException('aborted', 'AbortError');
    const aborted = createApiClient(async () => {
      throw abort;
    });
    await expect(aborted.call('health')).rejects.toBe(abort);
  });
});

describe('fillPath', () => {
  it('substitutes and encodes :params, and refuses missing ones', () => {
    expect(fillPath('/api/v1/jobs/:id', { id: 'a b/c' })).toBe('/api/v1/jobs/a%20b%2Fc');
    expect(fillPath('/api/v1/health')).toBe('/api/v1/health');
    expect(() => fillPath('/api/v1/jobs/:id')).toThrow(/id/);
  });
});

describe('describeError', () => {
  const err = (code: ApiClientError['code'], extra: Partial<{ status: number; message: string; details: unknown }> = {}) =>
    new ApiClientError({ code, message: extra.message ?? 'm', status: extra.status ?? 400, retryable: false, details: extra.details });

  it('explains PROJECT_LOCKED in plain language and names the holder', () => {
    const h = describeError(err('PROJECT_LOCKED', { status: 423, details: { pid: 4242, hostname: 'studio-mac' } }), 'open');
    expect(h.title).toBe('这个项目正在别处打开');
    expect(h.detail).toContain('project.lock');
    expect(h.detail).toContain('studio-mac');
    expect(h.detail).toContain('4242');
    expect(h.technical).toBe('PROJECT_LOCKED（HTTP 423）：m');
  });

  it('explains SCHEMA_VERSION_UNSUPPORTED', () => {
    const h = describeError(err('SCHEMA_VERSION_UNSUPPORTED'), 'open');
    expect(h.title).toBe('无法打开这个版本的项目');
    expect(h.detail).toContain('升级');
  });

  it('words NOT_FOUND by context', () => {
    expect(describeError(err('NOT_FOUND', { status: 404 }), 'open').title).toBe('这个目录里没有 StoryScript-Mov 项目');
    expect(describeError(err('NOT_FOUND', { status: 404 })).title).toBe('要找的内容不存在');
  });

  it('shows the server reason for validation and path errors', () => {
    const h = describeError(err('PATH_NOT_ALLOWED', { message: 'directory is not empty' }), 'create');
    expect(h.detail).toContain('directory is not empty');
  });

  it('points to pasting a path when the folder dialog fails', () => {
    const h = describeError(err('INTERNAL', { status: 500 }), 'choose-folder');
    expect(h.title).toBe('无法弹出系统的文件夹选择框');
  });

  it('uses the session wording for UNAUTHORIZED', () => {
    const h = describeError(err('UNAUTHORIZED', { status: 401 }));
    expect(`${h.title}：${h.detail}`).toBe('会话已失效：请使用终端打印的链接，或运行 storyscript-mov open');
  });

  it('handles non-client errors', () => {
    const h = describeError(new Error('kaboom'));
    expect(h.technical).toBe('kaboom');
  });
});

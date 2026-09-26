import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ImagePreset, type ProvidersView, type ProviderTestResult } from '@storyscript/contracts';
import { planCanvas, standardBoard, STANDARD_SHOTS } from '@storyscript/core';
import { callImage, type CallOutcome } from '../src/adapters/image/call.ts';
import { detectImageDialect, DASHSCOPE_COMPAT_WARNING, GEMINI_WARNING, hostMatches } from '../src/adapters/image/dialect.ts';
import { ALL_PRESETS, GENERIC_PRESET, presetById, PRESET_FILES } from '../src/adapters/image/presets.ts';
import type { ImageEndpoint, ImageRequest } from '../src/adapters/image/types.ts';
import { credentialsPath } from '../src/config/paths.ts';
import { svgToPixels } from '../src/adapters/render/resvg.ts';
import { postProcess, renderControl } from '../src/services/raster/imaging.ts';
import { configureImage } from '../src/services/raster/runtime.ts';
import { fakePng, IMAGE_TEST_KEY, imageEnv, imageReply, startFakeImage, type FakeImage } from './helpers/fake-image.ts';
import { makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * Image dialects (SPEC FR-12) against FakeImage: wire formats of
 * openai-edits / Seedream / OpenRouter, host detection and warnings, and the
 * FR-11 retry policy (429 only, 5xx/timeout → outcome_unknown with exactly
 * one request, refusals not retried, one stripped retry on "unknown
 * parameter"). No key in any error.
 */

const SEEDREAM = presetById('volcengine-seedream')!;
const OPENROUTER = presetById('openrouter')!;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CONTROL = new Uint8Array(fakePng(46, 19));
const ANCHOR = new Uint8Array(fakePng(20, 20));

let fake: FakeImage;
beforeEach(async () => {
  fake = await startFakeImage();
});
afterEach(async () => {
  await fake.close();
});

function endpoint(over: Partial<ImageEndpoint> = {}): ImageEndpoint {
  return { base_url: fake.url, api_key: IMAGE_TEST_KEY, model: 'gpt-image-2.5-flare', dialect: 'openai-edits', preset: null, host: '127.0.0.1', ...over };
}

function request(over: Partial<ImageRequest> = {}): ImageRequest {
  return { prompt: 'Task: test.\nSecond line.', images: [{ bytes: CONTROL, mime: 'image/png', name: 'control.png' }], size: '1840x768', quality: 'low', ...over };
}

const sleeps: number[] = [];
const policy = (over: Partial<Parameters<typeof callImage>[2]> = {}) => ({
  userAgent: 'storyscript-mov/test',
  timeoutMs: 2_000,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  ...over,
});

beforeEach(() => {
  sleeps.length = 0;
});

function expectNoKey(o: CallOutcome) {
  expect(JSON.stringify(o)).not.toContain(IMAGE_TEST_KEY);
  expect(JSON.stringify(o)).not.toContain('SECRET');
}

// ---------------------------------------------------------------------------

describe('presets and host detection', () => {
  test('every preset JSON validates against contracts ImagePreset and is unverified', () => {
    for (const [name, raw] of Object.entries(PRESET_FILES)) {
      const parsed = ImagePreset.safeParse(raw);
      expect(parsed.success, name).toBe(true);
    }
    for (const p of ALL_PRESETS) {
      expect(p.verified).toBe(false);
      expect(p.verified_at).toBeNull();
      expect(p.dialect).toBe('generations-ref');
    }
  });

  test('Seedream preset: image array of data URLs, pixel size, watermark off, b64 response', () => {
    expect(SEEDREAM).toMatchObject({
      path: '/images/generations',
      ref_field: 'image',
      ref_format: 'data_url',
      ref_is_array: true,
      size_mode: 'pixels',
      response_path: 'data.0.b64_json',
      extra_body: { watermark: false, response_format: 'b64_json' },
    });
    expect(SEEDREAM.optional_params).toContain('sequential_image_generation');
  });

  test('OpenRouter preset: /images, input_references, ratio enum up to 21:9', () => {
    expect(OPENROUTER).toMatchObject({ path: '/images', ref_field: 'input_references', size_mode: 'aspect_enum' });
    expect(OPENROUTER.aspect_values[0]).toBe('21:9');
  });

  test('host patterns', () => {
    expect(hostMatches('ark.*.volces.com', 'ark.cn-beijing.volces.com')).toBe(true);
    expect(hostMatches('ark.*.volces.com', 'ark.volces.com')).toBe(false);
    expect(hostMatches('*.bytepluses.com', 'ark.ap-southeast.bytepluses.com')).toBe(true);
    expect(hostMatches('openrouter.ai', 'openrouter.ai')).toBe(true);
    expect(hostMatches('openrouter.ai', 'evil-openrouter.ai')).toBe(false);
  });

  test('dialect: preset hosts → generations-ref, everything else → openai-edits, override wins', () => {
    expect(detectImageDialect('https://ark.cn-beijing.volces.com/api/v3', null)).toMatchObject({ dialect: 'generations-ref', preset: { id: 'volcengine-seedream' }, warning: null });
    expect(detectImageDialect('https://ark.ap-southeast.bytepluses.com/api/v3', null).preset?.id).toBe('volcengine-seedream');
    expect(detectImageDialect('https://openrouter.ai/api/v1', null)).toMatchObject({ dialect: 'generations-ref', preset: { id: 'openrouter' } });
    expect(detectImageDialect('https://api.openai.com/v1', null)).toMatchObject({ dialect: 'openai-edits', preset: null });
    expect(detectImageDialect('http://127.0.0.1:9/v1', null)).toMatchObject({ dialect: 'openai-edits', preset: null, host: '127.0.0.1' });
    expect(detectImageDialect('https://api.openai.com/v1', 'generations-ref').preset).toBe(GENERIC_PRESET);
    expect(detectImageDialect('https://openrouter.ai/api/v1', 'openai-edits')).toMatchObject({ dialect: 'openai-edits', preset: null });
  });

  test('warnings: Gemini compatibility layer and DashScope compatible-mode block redraw', () => {
    expect(detectImageDialect('https://generativelanguage.googleapis.com/v1beta/openai/', null)).toMatchObject({ warning: GEMINI_WARNING, blocking: true });
    expect(detectImageDialect('https://dashscope.aliyuncs.com/compatible-mode/v1', null)).toMatchObject({ warning: DASHSCOPE_COMPAT_WARNING, blocking: true });
    expect(GEMINI_WARNING).toBe('该地址不接收参考图，不能用于草图重绘');
    expect(DASHSCOPE_COMPAT_WARNING).toBe('百炼兼容模式不支持图像编辑，原生接口 v0.2 适配');
  });
});

// ---------------------------------------------------------------------------

describe('wire formats', () => {
  test('openai-edits: multipart, image[] control first then style anchor, model/size/quality/n, no input_fidelity for 2.x', async () => {
    const res = await callImage(endpoint(), request({ images: [{ bytes: CONTROL, mime: 'image/png', name: 'control.png' }, { bytes: ANCHOR, mime: 'image/png', name: 'anchor.png' }] }), policy());
    expect(res.outcome).toBe('ok');
    const [r] = fake.imageRequests();
    expect(r!.kind).toBe('edits');
    expect(r!.contentType).toMatch(/^multipart\/form-data/);
    expect(r!.files.map((f) => [f.field, f.filename, f.sha256])).toEqual([
      ['image[]', 'control.png', sha(CONTROL)],
      ['image[]', 'anchor.png', sha(ANCHOR)],
    ]);
    const fields = Object.fromEntries(r!.fields);
    expect(fields).toMatchObject({ model: 'gpt-image-2.5-flare', size: '1840x768', quality: 'low', n: '1' });
    expect(fields.prompt!.replace(/\r\n/g, '\n')).toBe('Task: test.\nSecond line.');
    expect(fields).not.toHaveProperty('input_fidelity');
    expect(fields).not.toHaveProperty('stream');
  });

  test('openai-edits: gpt-image-1.x gets input_fidelity=high', async () => {
    await callImage(endpoint({ model: 'gpt-image-1.5' }), request(), policy());
    expect(Object.fromEntries(fake.imageRequests()[0]!.fields)).toMatchObject({ input_fidelity: 'high' });
  });

  test('Seedream preset: JSON body with image data URLs, pixel size, watermark:false, response_format', async () => {
    const plan = planCanvas('2.39', { mode: 'pixels' });
    const res = await callImage(endpoint({ dialect: 'generations-ref', preset: SEEDREAM, model: 'seedream-model-id' }), request({ size: plan.request_size, quality: null }), policy());
    expect(res.outcome).toBe('ok');
    const [r] = fake.imageRequests();
    expect(r!.kind).toBe('generations');
    expect(r!.authorization).toBe(`Bearer ${IMAGE_TEST_KEY}`);
    expect(r!.userAgent).toBe('storyscript-mov/test');
    const body = r!.json!;
    expect(body).toMatchObject({
      model: 'seedream-model-id',
      prompt: 'Task: test.\nSecond line.',
      size: '3168x1328',
      watermark: false,
      response_format: 'b64_json',
      sequential_image_generation: 'disabled',
    });
    expect(body.image).toEqual([`data:image/png;base64,${Buffer.from(CONTROL).toString('base64')}`]);
    expect(body).not.toHaveProperty('quality');
  });

  test('OpenRouter preset: input_references and the 21:9 ratio for a 2.39 frame; result cropped back to the frame', async () => {
    const plan = planCanvas('2.39', { mode: 'aspect_enum', aspect_values: OPENROUTER.aspect_values });
    expect(plan.request_size).toBe('21:9');
    expect(planCanvas('1.78', { mode: 'aspect_enum', aspect_values: OPENROUTER.aspect_values }).request_size).toBe('16:9');
    const res = await callImage(endpoint({ base_url: fake.url, dialect: 'generations-ref', preset: OPENROUTER, model: 'vendor/image-model' }), request({ size: plan.request_size, quality: null }), policy());
    const [r] = fake.imageRequests();
    expect(r!.kind).toBe('images');
    expect(r!.json).toMatchObject({ model: 'vendor/image-model', aspect_ratio: '21:9' });
    expect(r!.json!.input_references).toEqual([`data:image/png;base64,${Buffer.from(CONTROL).toString('base64')}`]);
    expect(res.outcome).toBe('ok');
    if (res.outcome !== 'ok') return;
    expect([res.image.width, res.image.height]).toEqual([168, 72]);
    const out = await postProcess(res.image, plan, '2.39');
    expect([out.width, out.height]).toEqual([1840, 770]);
    expect(Buffer.from(out.png).readUInt32BE(16)).toBe(1840);
  });

  test('URL delivery: downloaded at once with our User-Agent, without the key; sha256 of the bytes', async () => {
    fake.enqueue(imageReply.url());
    const res = await callImage(endpoint(), request({ size: '1536x864' }), policy());
    expect(res.outcome).toBe('ok');
    if (res.outcome !== 'ok') return;
    const dl = fake.requests.find((r) => r.kind === 'file')!;
    expect(dl.userAgent).toBe('storyscript-mov/test');
    expect(dl.authorization).toBeUndefined();
    expect(res.image.delivery).toBe('url');
    expect(res.image.sha256).toBe(sha(fakePng(192, 108)));
  });
});

describe('control image', () => {
  test.each(['structure', 'pencil'] as const)('%s control keeps the board inside the frame box and plain paper margins (21:9 canvas)', async (mode) => {
    const spec = standardBoard(STANDARD_SHOTS.find((s) => s.key === '03-ots-a')!);
    const plan = planCanvas('2.39', { mode: 'aspect_enum', aspect_values: OPENROUTER.aspect_values });
    const control = await renderControl(spec, mode, plan);
    expect([control.width, control.height]).toEqual([1536, 658]);
    const b64 = Buffer.from(control.png).toString('base64');
    const px = await svgToPixels(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1536 658" width="1536" height="658"><image href="data:image/png;base64,${b64}" width="1536" height="658"/></svg>`, { width: 1536 });
    const lum = (x: number, y: number) => px.rgba[(y * px.width + x) * 4]!;
    let dark = 0;
    for (let y = 20; y < 640; y += 2) for (let x = 0; x < 1536; x += 2) if (lum(x, y) < 128) dark++;
    // the frame holds real content (silhouettes / outlines), not just the frame line
    expect(dark).toBeGreaterThan(2_000);
    // margins above and below the frame are one flat paper tone
    const top = new Set<number>();
    for (let x = 0; x < 1536; x += 7) top.add(lum(x, 2));
    expect(top.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('retry policy (FR-11/FR-12)', () => {
  test('429 is retried after Retry-After (capped at 30 s); every attempt counts', async () => {
    fake.enqueue(imageReply.rateLimited('5'), imageReply.rateLimited('120'), imageReply.ok());
    const attempts: number[] = [];
    const res = await callImage(endpoint(), request(), policy({ onAttempt: (n) => attempts.push(n) }));
    expect(res).toMatchObject({ outcome: 'ok', attempts: 3 });
    expect(sleeps).toEqual([5_000, 30_000]);
    expect(attempts).toEqual([1, 2, 3]);
    expect(fake.imageRequests()).toHaveLength(3);
  });

  test('429 three times → ATTEMPTS_EXHAUSTED after exactly 3 requests', async () => {
    fake.enqueue(imageReply.rateLimited('1'), imageReply.rateLimited('1'), imageReply.rateLimited('1'), imageReply.ok());
    const res = await callImage(endpoint(), request(), policy());
    expect(res.outcome).toBe('failed');
    if (res.outcome !== 'failed') return;
    expect(res.error.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(res.attempts).toBe(3);
    expect(fake.imageRequests()).toHaveLength(3);
  });

  test.each([500, 502, 503])('%i → outcome_unknown, exactly one request', async (status) => {
    fake.enqueue(imageReply.serverError(status), imageReply.ok());
    const res = await callImage(endpoint(), request(), policy());
    expect(res.outcome).toBe('outcome_unknown');
    if (res.outcome !== 'outcome_unknown') return;
    expect(res.error.code).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(res.error.message).toContain(`HTTP ${status}`);
    expect(res.error.message).toContain('不会自动重发');
    expect(fake.imageRequests()).toHaveLength(1);
  });

  test('timeout → outcome_unknown, exactly one request (both dialects)', async () => {
    fake.enqueue(imageReply.hang());
    const gen = await callImage(endpoint({ dialect: 'generations-ref', preset: SEEDREAM }), request({ size: '3168x1328' }), policy({ timeoutMs: 200 }));
    expect(gen.outcome).toBe('outcome_unknown');
    expect(fake.imageRequests()).toHaveLength(1);
    fake.enqueue(imageReply.hang());
    const edits = await callImage(endpoint(), request(), policy({ timeoutMs: 200 }));
    expect(edits.outcome).toBe('outcome_unknown');
    if (edits.outcome === 'outcome_unknown') expect(edits.error.message).toContain('不会自动重发');
    expect(fake.imageRequests()).toHaveLength(2);
  });

  test('moderation refusal → PROVIDER_REFUSED, not retried', async () => {
    fake.enqueue(imageReply.refused(), imageReply.ok());
    const res = await callImage(endpoint(), request(), policy());
    expect(res.outcome).toBe('refused');
    if (res.outcome !== 'refused') return;
    expect(res.error.code).toBe('PROVIDER_REFUSED');
    expect(res.error.message).toContain('moderation_blocked');
    expect(fake.imageRequests()).toHaveLength(1);
  });

  test('400 unknown parameter (Seedream) → optional params stripped, retried once', async () => {
    fake.enqueue(imageReply.unknownParam('sequential_image_generation'), imageReply.ok());
    const res = await callImage(endpoint({ dialect: 'generations-ref', preset: SEEDREAM }), request({ size: '3168x1328', quality: null }), policy());
    expect(res).toMatchObject({ outcome: 'ok', attempts: 2, stripped: true });
    const [first, second] = fake.imageRequests();
    expect(first!.json).toHaveProperty('sequential_image_generation');
    expect(second!.json).not.toHaveProperty('sequential_image_generation');
    expect(second!.json).toMatchObject({ watermark: false, response_format: 'b64_json' });
  });

  test('400 unknown parameter twice → only one stripped retry', async () => {
    fake.enqueue(imageReply.unknownParam('quality'), imageReply.unknownParam('quality'), imageReply.ok());
    const res = await callImage(endpoint(), request(), policy());
    expect(res.outcome).toBe('failed');
    expect(fake.imageRequests()).toHaveLength(2);
    expect(Object.fromEntries(fake.imageRequests()[0]!.fields)).toHaveProperty('quality');
    expect(Object.fromEntries(fake.imageRequests()[1]!.fields)).not.toHaveProperty('quality');
  });

  test('400 size → plain message with the nearest legal size', async () => {
    fake.enqueue(imageReply.badSize('1840x768'));
    const res = await callImage(endpoint(), request(), policy());
    expect(res.outcome).toBe('failed');
    if (res.outcome !== 'failed') return;
    expect(res.error.message).toContain('不接受尺寸 1840x768');
    expect(res.error.message).toContain('最近的合法尺寸：1536x1024');
    expect(res.error.details).toMatchObject({ suggested_size: '1536x1024' });
    // a size that breaks the custom-size rules (ratio 4:1) → the nearest size that follows them
    fake.enqueue(imageReply.badSize('2400x600'));
    const bad = await callImage(endpoint(), request({ size: '2400x600' }), policy());
    if (bad.outcome !== 'failed') throw new Error('expected failure');
    const suggested = String(bad.error.details!.suggested_size);
    const [w, h] = suggested.split('x').map(Number) as [number, number];
    expect(w % 16 + (h % 16)).toBe(0);
    expect(w / h).toBeLessThanOrEqual(3);
  });

  test('401/403/404 → translated messages; 404 suggests generations-ref; no key anywhere', async () => {
    fake.enqueue(imageReply.echoAuth(401));
    const r401 = await callImage(endpoint(), request(), policy());
    expect(r401).toMatchObject({ outcome: 'failed', attempts: 1, error: { code: 'PROVIDER_ERROR' } });
    if (r401.outcome === 'failed') expect(r401.error.message).toContain('API key');
    expectNoKey(r401);

    fake.enqueue({ type: 'status', status: 403, body: { error: { message: `key ${IMAGE_TEST_KEY} has no access` } } });
    const r403 = await callImage(endpoint(), request(), policy());
    if (r403.outcome === 'failed') expect(r403.error.message).toContain('没有权限');
    expectNoKey(r403);

    fake.enqueue(imageReply.notFound());
    const r404 = await callImage(endpoint(), request(), policy());
    if (r404.outcome !== 'failed') throw new Error('expected failure');
    expect(r404.error.message).toContain('该端点不支持此写法');
    expect(r404.error.message).toContain('generations-ref');
    expectNoKey(r404);

    fake.enqueue({ type: 'status', status: 400, body: { error: { message: `bad request for ${IMAGE_TEST_KEY}` } } });
    const r400 = await callImage(endpoint({ dialect: 'generations-ref', preset: SEEDREAM }), request({ size: '3168x1328' }), policy());
    expectNoKey(r400);
  });

  test('service unreachable → PROVIDER_ERROR (nothing was processed), not outcome_unknown', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const res = await callImage(endpoint({ base_url: `http://127.0.0.1:${port}/v1` }), request(), policy());
    expect(res).toMatchObject({ outcome: 'failed', attempts: 1, error: { code: 'PROVIDER_ERROR' } });
  });

  test('cancel during the 429 wait sends nothing more', async () => {
    fake.enqueue(imageReply.rateLimited('1'), imageReply.ok());
    const ac = new AbortController();
    const res = await callImage(endpoint(), request(), policy({ signal: ac.signal, sleep: async () => ac.abort() }));
    expect(res.outcome).toBe('cancelled');
    expect(fake.imageRequests()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('settings routes (image)', () => {
  let app: M3App;
  afterEach(() => app?.close());

  test('PUT saves to credentials.json (0600); GET shows dialect, preset, last 4 of the key only', async () => {
    app = await makeM3App({ openProject: false });
    const empty = await app.get<ProvidersView>('/api/v1/settings/providers');
    expect(empty.data.image).toBeNull();
    const put = await app.put<ProvidersView>('/api/v1/settings/providers/image', {
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'seedream-model-id',
      api_key: IMAGE_TEST_KEY,
      dialect_override: null,
    });
    expect(put.status, put.text).toBe(200);
    expect(put.text).not.toContain(IMAGE_TEST_KEY);
    expect(put.data.image).toEqual({
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'seedream-model-id',
      key_last4: IMAGE_TEST_KEY.slice(-4),
      source: 'file',
      dialect_override: null,
      dialect: 'generations-ref',
      preset_id: 'volcengine-seedream',
      verified: false,
      warning: null,
    });
    expect(statSync(credentialsPath(app.stateDir)).mode & 0o777).toBe(0o600);
    // keep the key when omitted; override the dialect
    const again = await app.put<ProvidersView>('/api/v1/settings/providers/image', {
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'some-image-model',
      dialect_override: 'openai-edits',
    });
    expect(again.data.image).toMatchObject({ key_last4: IMAGE_TEST_KEY.slice(-4), dialect: 'openai-edits', dialect_override: 'openai-edits', warning: GEMINI_WARNING });
    // the text provider view is unaffected
    expect(again.data.text).toBeNull();
  });

  test('env wins and is reported; DashScope compatible-mode warning', async () => {
    app = await makeM3App({ openProject: false, env: imageEnv('https://dashscope.aliyuncs.com/compatible-mode/v1') });
    const res = await app.get<ProvidersView>('/api/v1/settings/providers');
    expect(res.data.image).toMatchObject({ source: 'env', dialect: 'openai-edits', warning: DASHSCOPE_COMPAT_WARNING });
    expect(res.text).not.toContain(IMAGE_TEST_KEY);
  });

  test('test: free check lists models (no image request); paid test sends one smallest, lowest-quality image', async () => {
    app = await makeM3App({ openProject: false, env: imageEnv(fake.url) });
    configureImage(app.handle.deps, { sleep: async () => {} });
    const free = await app.post<ProviderTestResult>('/api/v1/settings/providers/image/test', { paid: false });
    expect(free.status, free.text).toBe(200);
    expect(free.data).toMatchObject({ ok: true, models_endpoint: true, model_listed: true });
    expect(fake.imageRequests()).toHaveLength(0);

    const paid = await app.post<ProviderTestResult>('/api/v1/settings/providers/image/test', { paid: true });
    expect(paid.data.ok).toBe(true);
    expect(paid.data.message).toContain('付费测试成功');
    const sent = fake.imageRequests();
    expect(sent).toHaveLength(1);
    expect(Object.fromEntries(sent[0]!.fields)).toMatchObject({ size: '1024x1024', quality: 'low', n: '1' });

    fake.enqueue(imageReply.echoAuth(401));
    const failed = await app.post<ProviderTestResult>('/api/v1/settings/providers/image/test', { paid: true });
    expect(failed.data.ok).toBe(false);
    expect(failed.text).not.toContain(IMAGE_TEST_KEY);
  });

  test('test without configuration → 409 PROVIDER_NOT_CONFIGURED', async () => {
    app = await makeM3App({ openProject: false });
    const res = await app.post('/api/v1/settings/providers/image/test', { paid: false });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

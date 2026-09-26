import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BoardSpec, Job, RasterView, Scene, Shot } from '@storyscript/contracts';
import { shotFields, standardBoard, STANDARD_SHOTS, standardSubject, structureHash } from '@storyscript/core';
import { svgToPixels } from '../src/adapters/render/resvg.ts';
import type { DbPort } from '../src/db/port.ts';
import { configureImage } from '../src/services/raster/runtime.ts';
import type { RasterSidecar } from '../src/services/raster/storage.ts';
import { DEFAULT_IMAGE_USAGE, IMAGE_TEST_KEY, imageEnv, imageReply, insertBoardRow, startFakeImage, type FakeImage } from './helpers/fake-image.ts';
import { bookshopRoster, importFixture, makeM3App, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-18 (simplified, FakeImage): redraw → candidate → adopt → board.spec and
 * shot.fields untouched (INV-09) → structure change makes the raster stale →
 * inputs and usage traceable (sidecar ≡ row). Plus the gates: no
 * confirmation → 400, no provider → 409 with nothing sent, cache hits send
 * nothing, soft cap, late result after cancel.
 */

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

let fake: FakeImage;
let app: M3App;
let db: DbPort;
let scene: Scene;
let shot: Shot;
let spec: BoardSpec;
let boardId: string;

/** control_mode 'structure' keeps the gate tests fast (the pencil control render takes ~1 s). */
async function setup(env: NodeJS.ProcessEnv, opts: { structure?: boolean } = {}) {
  app = await makeM3App({ env });
  configureImage(app.handle.deps, { sleep: async () => {}, timeoutMs: 5_000 });
  db = app.handle.projectSession.require().db;
  if (opts.structure) db.run(`INSERT INTO kv (key, value_json, updated_at) VALUES ('image.control_mode', '"structure"', '2026-01-01T00:00:00.000Z')`);
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  scene = imported.scenes[0]!;
  await bookshopRoster(app);
  const created = await app.post<Shot>('/api/v1/shots', {
    scene_id: scene.id,
    fields: shotFields({
      shot_size: 'MS',
      subjects: [standardSubject('c1'), standardSubject('c2')],
      action: '老周把《某片》的旧海报递过去',
      source: { paragraph_id: scene.paragraph_ids[1]!, quote: '' },
    }),
    manual_note: 'AT-18 手工镜头',
  });
  expect(created.status, created.text).toBe(201);
  shot = created.data;
  spec = standardBoard(STANDARD_SHOTS.find((s) => s.key === '10-depth-two')!);
  boardId = insertBoardRow(db, shot.id, spec);
}

const redraw = (body: unknown = { confirmed: true, quality: 'low' }, id = boardId) => app.post<{ job_id: string }>(`/api/v1/boards/${id}/redraw`, body);
const rasters = async () => (await app.get<RasterView[]>(`/api/v1/boards/${boardId}/rasters`)).data;
const boardRow = () => db.get<{ spec_json: string; revision: number; version: number }>('SELECT spec_json, revision, version FROM board WHERE id = ?', boardId)!;

async function redrawOk(body?: unknown): Promise<Job> {
  const res = await redraw(body);
  expect(res.status, res.text).toBe(202);
  return waitJob(app, res.data.job_id);
}

beforeEach(async () => {
  fake = await startFakeImage();
});

afterEach(async () => {
  app?.close();
  await fake.close();
});

describe('AT-18 AI pencil redraw (FakeImage)', () => {
  test('generate → candidate → adopt keeps board and shot (INV-09) → stale after a structure change → sources and usage traceable', async () => {
    await setup(imageEnv(fake.url));
    const job = await redrawOk();
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.kind).toBe('image_redraw');
    expect(job.remote).toBe(true);
    expect(job.attempts).toBe(1);

    // exactly one outbound request, openai-edits multipart
    const sent = fake.imageRequests();
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.kind).toBe('edits');
    expect(req.authorization).toBe(`Bearer ${IMAGE_TEST_KEY}`);
    expect(req.files.map((f) => [f.field, f.filename, f.type])).toEqual([['image[]', 'control.png', 'image/png']]);
    const field = (n: string) => req.fields.filter(([k]) => k === n).map(([, v]) => v);
    expect(field('model')).toEqual(['fake-image-model']);
    expect(field('size')).toEqual(['1840x768']);
    expect(field('quality')).toEqual(['low']);
    expect(field('n')).toEqual(['1']);
    // multipart text fields travel with CRLF line breaks
    const prompt = field('prompt')[0]!.replace(/\r\n/g, '\n');
    expect(prompt).toContain('exactly 2 people');
    expect(prompt).not.toContain('《');

    // one candidate
    const list = await rasters();
    expect(list).toHaveLength(1);
    const r = list[0]!;
    expect(job.result_ref).toBe(r.id);
    expect(r).toMatchObject({
      board_id: boardId,
      status: 'candidate',
      outcome: 'ok',
      dialect: 'openai-edits',
      host: '127.0.0.1',
      model: 'fake-image-model',
      preset_id: null,
      size: '1840x768',
      quality: 'low',
      ai_label_on: true,
      source_type: 'model_generated',
      stale: false,
      image_url: `/api/v1/rasters/${r.id}/image`,
    });
    expect(r.usage).toEqual({
      input_tokens: DEFAULT_IMAGE_USAGE.input_tokens,
      output_tokens: DEFAULT_IMAGE_USAGE.output_tokens,
      total_tokens: DEFAULT_IMAGE_USAGE.total_tokens,
      'input_tokens_details.image_tokens': 1100,
      'input_tokens_details.text_tokens': 100,
    });
    expect(r.structure_hash).toBe(structureHash(spec));

    // post-processed PNG: frame size, greyscale
    const img = await app.handle.app.request(r.image_url!, { headers: { host: '127.0.0.1:43203', cookie: '' } });
    expect(img.status).toBe(401); // session cookie required
    const bytes = await fetchImage(r.image_url!);
    expect(pngSize(bytes)).toEqual({ w: 1840, h: 770 });
    const px = await svgToPixels(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1840 770" width="1840" height="770"><image href="data:image/png;base64,${bytes.toString('base64')}" width="1840" height="770"/></svg>`, { width: 460 });
    let maxChroma = 0;
    for (let i = 0; i < px.rgba.length; i += 4) {
      const [a, b, c] = [px.rgba[i]!, px.rgba[i + 1]!, px.rgba[i + 2]!];
      maxChroma = Math.max(maxChroma, Math.max(a, b, c) - Math.min(a, b, c));
    }
    expect(maxChroma).toBeLessThanOrEqual(2);

    // sources and usage: sidecar ≡ row ≡ files on disk ≡ what the service received
    const dir = join(app.projectDir, 'boards', boardId);
    const sidecar = JSON.parse(readFileSync(join(dir, `raster-${r.id}.json`), 'utf8')) as RasterSidecar;
    const out = readFileSync(join(dir, `raster-${r.id}.png`));
    const raw = readFileSync(join(dir, `raw-${r.id}.png`));
    const control = readFileSync(join(dir, `control-${r.id}.png`));
    expect(sidecar).toMatchObject({
      raster_id: r.id,
      board_id: boardId,
      shot_id: shot.id,
      job_id: job.id,
      source_type: 'model_generated',
      ai_label: true,
      outcome: 'ok',
      structure_hash: r.structure_hash,
      usage: r.usage,
      provider: { dialect: r.dialect, host: r.host, model: r.model, preset_id: null, preset_verified: false },
      request: { size: r.size, quality: r.quality, requested_quality: 'low', n: 1, prompt_version: 'image-v1', prompt_hash: r.prompt_hash, attempts: 1 },
      control: { mode: 'pencil', sha256: r.control_sha256, file: `boards/${boardId}/control-${r.id}.png` },
      output: { file: r.file, sha256: r.sha256 },
    });
    expect(sha(out)).toBe(r.sha256);
    expect(sha(control)).toBe(r.control_sha256);
    expect(req.files[0]!.sha256).toBe(r.control_sha256);
    expect(sha(raw)).toBe(sidecar.raw!.sha256);
    expect(sha(sidecar.request.prompt)).toBe(r.prompt_hash);
    expect(sidecar.request.prompt).toBe(prompt);
    expect(sidecar.request.removed_terms).toEqual(['《某片》']);
    expect(sidecar.created_at).toBe(r.created_at);
    expect(JSON.stringify(sidecar)).not.toContain(IMAGE_TEST_KEY);

    // adopt: only board_raster changes (INV-09)
    const boardBefore = boardRow();
    const shotBefore = (await app.get<Shot[]>('/api/v1/shots')).data.find((s) => s.id === shot.id)!;
    const adopted = await app.post<RasterView>(`/api/v1/rasters/${r.id}/adopt`);
    expect(adopted.status, adopted.text).toBe(200);
    expect(adopted.data.status).toBe('adopted');
    expect(boardRow()).toEqual(boardBefore);
    const shotAfter = (await app.get<Shot[]>('/api/v1/shots')).data.find((s) => s.id === shot.id)!;
    expect(shotAfter).toEqual(shotBefore);

    // the same request again is a cache hit: nothing is sent
    const again = await redraw();
    expect(again.status).toBe(202);
    expect(again.data.job_id).toBe(job.id);
    expect(fake.imageRequests()).toHaveLength(1);

    // structure changes (as a board save would) → the raster is stale, still adopted
    const moved: BoardSpec = { ...spec, scene: { ...spec.scene, subjects: spec.scene.subjects.map((s, i) => (i === 0 ? { ...s, x: s.x + 0.5 } : s)) } };
    db.run('UPDATE board SET spec_json = ?, revision = revision + 1 WHERE id = ?', JSON.stringify(moved), boardId);
    const after = await rasters();
    expect(after[0]).toMatchObject({ id: r.id, status: 'adopted', stale: true });
  });

  test('adopting a second candidate returns the first to candidate; reject; rejected result is re-requested', async () => {
    await setup(imageEnv(fake.url), { structure: true });
    const j1 = await redrawOk({ confirmed: true, quality: 'low' });
    const j2 = await redrawOk({ confirmed: true, quality: 'medium' });
    expect(fake.imageRequests()).toHaveLength(2);
    const [a, b] = [j1.result_ref!, j2.result_ref!];
    expect((await app.post<RasterView>(`/api/v1/rasters/${a}/adopt`)).data.status).toBe('adopted');
    expect((await app.post<RasterView>(`/api/v1/rasters/${b}/adopt`)).data.status).toBe('adopted');
    const byId = new Map((await rasters()).map((r) => [r.id, r]));
    expect(byId.get(a)!.status).toBe('candidate');
    expect(byId.get(b)!.status).toBe('adopted');
    expect((await app.post<RasterView>(`/api/v1/rasters/${a}/reject`)).data.status).toBe('rejected');
    // a rejected result does not count as a cache hit
    const j3 = await redrawOk({ confirmed: true, quality: 'low' });
    expect(j3.status).toBe('succeeded');
    expect(fake.imageRequests()).toHaveLength(3);
    expect(await rasters()).toHaveLength(3);
  });

  test('provider errors reach the job without the key; a result that cannot be post-processed (WebP) keeps the raw file', async () => {
    await setup(imageEnv(fake.url), { structure: true });
    fake.enqueue(imageReply.echoAuth(401));
    const j = await redrawOk();
    expect(j.status).toBe('failed');
    expect(j.error?.code).toBe('PROVIDER_ERROR');
    expect(j.error?.message).toContain('API key');
    const jobText = (await app.get(`/api/v1/jobs/${j.id}`)).text;
    expect(jobText).not.toContain(IMAGE_TEST_KEY);
    expect(await rasters()).toEqual([]);

    fake.enqueue(imageReply.webp());
    const w = await redrawOk({ confirmed: true, quality: 'medium' });
    expect(w.status).toBe('failed');
    expect(w.error?.message).toContain('image/webp');
    const [row] = await rasters();
    expect(row).toMatchObject({ outcome: 'ok', file: null, sha256: null, image_url: null });
    const sidecar = JSON.parse(readFileSync(join(app.projectDir, 'boards', boardId, `raster-${row!.id}.json`), 'utf8')) as RasterSidecar;
    expect(sidecar.raw?.file).toBe(`boards/${boardId}/raw-${row!.id}.webp`);
    expect(sidecar.control.mode).toBe('structure');
    expect(sidecar.postprocess_error).toContain('image/webp');
    expect(readFileSync(join(app.projectDir, 'boards', boardId, `raw-${row!.id}.webp`)).length).toBeGreaterThan(0);
  });

  test('confirmed=false → 400 MISSING_CONFIRMATION, nothing sent', async () => {
    await setup(imageEnv(fake.url));
    const res = await redraw({ confirmed: false, quality: 'low' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('MISSING_CONFIRMATION');
    expect(fake.requests).toHaveLength(0);
    expect(await rasters()).toEqual([]);
  });

  test('no image provider → 409 PROVIDER_NOT_CONFIGURED, nothing sent; unknown board → 404', async () => {
    await setup({});
    const res = await redraw();
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(fake.requests).toHaveLength(0);
    const missing = await redraw(undefined, '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });

  test('an address that cannot take reference images is refused before sending', async () => {
    await setup(imageEnv('https://generativelanguage.googleapis.com/v1beta/openai'));
    const res = await redraw();
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(res.body.error?.message).toContain('该地址不接收参考图，不能用于草图重绘');
  });

  test('project soft cap (kv image.raster_cap) → 409 before sending', async () => {
    await setup(imageEnv(fake.url), { structure: true });
    db.run(`INSERT INTO kv (key, value_json, updated_at) VALUES ('image.raster_cap', '1', '2026-01-01T00:00:00.000Z')`);
    expect((await redrawOk()).status).toBe('succeeded');
    const res = await redraw({ confirmed: true, quality: 'high' });
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toContain('软上限 1 张');
    expect(res.body.error?.details).toMatchObject({ cap: 1, used: 1 });
    expect(fake.imageRequests()).toHaveLength(1);
    // a cache hit is still served at the cap
    expect((await redraw()).status).toBe(202);
  });

  test('refusal and timeout are recorded as candidates without image; job errors carry the translated message', async () => {
    await setup(imageEnv(fake.url), { structure: true });
    fake.enqueue(imageReply.refused());
    const refused = await redrawOk();
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe('PROVIDER_REFUSED');
    expect(refused.attempts).toBe(1);

    configureImage(app.handle.deps, { timeoutMs: 250 });
    fake.enqueue(imageReply.hang());
    const unknown = await redrawOk({ confirmed: true, quality: 'medium' });
    expect(unknown.status).toBe('outcome_unknown');
    expect(unknown.error?.code).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(unknown.attempts).toBe(1);
    expect(fake.imageRequests()).toHaveLength(2);

    const list = await rasters();
    expect(list.map((r) => [r.outcome, r.status, r.image_url, r.file])).toEqual(
      expect.arrayContaining([
        ['refused', 'candidate', null, null],
        ['outcome_unknown', 'candidate', null, null],
      ]),
    );
    const noImage = list.find((r) => r.outcome === 'refused')!;
    const adopt = await app.post(`/api/v1/rasters/${noImage.id}/adopt`);
    expect(adopt.status).toBe(409);
  });

  test('cancel after the request left → the late image is kept as late_after_cancel, not adopted; a repeat request is served from it', async () => {
    await setup(imageEnv(fake.url), { structure: true });
    fake.enqueue(imageReply.hold());
    const res = await redraw();
    expect(res.status).toBe(202);
    await fake.waitForHang();
    const cancelled = await app.post<Job>(`/api/v1/jobs/${res.data.job_id}/cancel`);
    expect(cancelled.data.status).toBe('outcome_unknown');
    fake.release();
    await waitFor(async () => (await rasters()).length === 1);
    const [late] = await rasters();
    expect(late).toMatchObject({ outcome: 'late_after_cancel', status: 'candidate' });
    expect(late!.image_url).not.toBeNull();
    const job = (await app.get<Job>(`/api/v1/jobs/${res.data.job_id}`)).data;
    expect(job.status).toBe('outcome_unknown');

    const again = await redraw();
    const settled = await waitJob(app, again.data.job_id);
    expect(settled).toMatchObject({ status: 'succeeded', remote: false, attempts: 0, result_ref: late!.id });
    expect(fake.imageRequests()).toHaveLength(1);
  });
});

async function fetchImage(url: string): Promise<Buffer> {
  const session = await app.handle.app.request('/api/v1/session', {
    method: 'POST',
    headers: { host: '127.0.0.1:43203', origin: 'http://127.0.0.1:43203', 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'm3-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF' }),
  });
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]!;
  const res = await app.handle.app.request(url, { headers: { host: '127.0.0.1:43203', cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  return Buffer.from(await res.arrayBuffer());
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

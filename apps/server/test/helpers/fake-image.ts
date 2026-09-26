import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import type { BoardSpec } from '@storyscript/contracts';
import { RENDERER_VERSION } from '@storyscript/core';
import type { DbPort } from '../../src/db/port.ts';

/**
 * FakeImage — a fake image service on 127.0.0.1 (random port) for tests
 * (SPEC FR-12: AT-18 is verified against it). It answers:
 *
 *   POST /v1/images/edits        multipart (openai-edits)
 *   POST /v1/images/generations  JSON (Seedream-style generations-ref)
 *   POST /v1/images              JSON (OpenRouter-style generations-ref)
 *   GET  /v1/models              model list (free connection check)
 *   GET  /files/<n>.png          images handed out in URL mode
 *
 * Image replies are scripted in order (default: one deterministic PNG). Every
 * request is recorded: multipart field names/values in order, uploaded files
 * (field, filename, type, size, sha256), JSON bodies, Authorization and
 * User-Agent headers.
 */

export type FakeImageReply =
  | { type: 'image'; delivery?: 'b64' | 'url'; usage?: Record<string, unknown> | null; format?: 'png' | 'webp' }
  | { type: 'status'; status: number; body?: unknown; headers?: Record<string, string> }
  /** error whose message echoes the Authorization header (providers sometimes leak keys) */
  | { type: 'echo_auth'; status: number }
  /** never answers (client timeout) */
  | { type: 'hang' }
  /** answers with an image only when release() is called (late result after cancel) */
  | { type: 'hold' };

export const imageReply = {
  ok: (usage?: Record<string, unknown> | null): FakeImageReply => ({ type: 'image', usage }),
  url: (): FakeImageReply => ({ type: 'image', delivery: 'url' }),
  webp: (): FakeImageReply => ({ type: 'image', format: 'webp' }),
  rateLimited: (retryAfter = '2'): FakeImageReply => ({
    type: 'status',
    status: 429,
    body: { error: { message: 'Rate limit reached for images per minute.', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
    headers: { 'retry-after': retryAfter },
  }),
  serverError: (status = 500): FakeImageReply => ({ type: 'status', status, body: { error: { message: 'The server had an error while processing your request.', type: 'server_error' } } }),
  refused: (): FakeImageReply => ({
    type: 'status',
    status: 400,
    body: { error: { message: 'Your request was rejected as a result of our safety system.', type: 'image_generation_user_error', code: 'moderation_blocked' } },
  }),
  unknownParam: (name: string): FakeImageReply => ({
    type: 'status',
    status: 400,
    body: { error: { message: `Unknown parameter: '${name}'.`, type: 'invalid_request_error', param: name, code: 'unknown_parameter' } },
  }),
  badSize: (size: string): FakeImageReply => ({
    type: 'status',
    status: 400,
    body: { error: { message: `Invalid size '${size}'. Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto.`, type: 'invalid_request_error', param: 'size' } },
  }),
  unauthorized: (): FakeImageReply => ({ type: 'status', status: 401, body: { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } } }),
  notFound: (): FakeImageReply => ({ type: 'status', status: 404, body: { error: { message: 'Not found', type: 'invalid_request_error' } } }),
  echoAuth: (status = 401): FakeImageReply => ({ type: 'echo_auth', status }),
  hang: (): FakeImageReply => ({ type: 'hang' }),
  hold: (): FakeImageReply => ({ type: 'hold' }),
};

export interface RecordedFile {
  field: string;
  filename: string;
  type: string;
  size: number;
  sha256: string;
}

export interface RecordedImageRequest {
  method: string;
  path: string;
  kind: 'edits' | 'generations' | 'images' | 'models' | 'file' | 'other';
  authorization: string | undefined;
  userAgent: string | undefined;
  contentType: string | undefined;
  /** multipart text fields in order */
  fields: [string, string][];
  /** multipart files in order */
  files: RecordedFile[];
  json: Record<string, unknown> | null;
}

export interface FakeImage {
  /** base_url to configure, ends in /v1 */
  readonly url: string;
  readonly origin: string;
  readonly requests: RecordedImageRequest[];
  /** POSTs to the three image endpoints */
  imageRequests(): RecordedImageRequest[];
  enqueue(...replies: FakeImageReply[]): void;
  /** ids served by GET /v1/models; null → 404 */
  models: string[] | null;
  /** resolves when a hang/hold request has arrived */
  waitForHang(): Promise<void>;
  /** answer the held request(s) with an image */
  release(): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// deterministic PNG (RGB, colour on purpose: post-processing must grey it)
// ---------------------------------------------------------------------------

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function fakePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      const band = Math.floor((x / w) * 3);
      const dark = x > w * 0.4 && x < w * 0.6 && y > h * 0.3;
      const [r, g, b] = dark ? [30, 30, 40] : band === 0 ? [210, 60, 50] : band === 1 ? [235, 225, 200] : [40, 80, 200];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Minimal RIFF/WEBP (VP8X header only) — enough for type sniffing. */
function fakeWebp(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

/** Output size for a request: WxH / 8, or 24 px per ratio unit for "21:9". */
function outputSize(size: unknown): { w: number; h: number } {
  if (typeof size === 'string') {
    const px = /^(\d+)x(\d+)$/.exec(size);
    if (px) return { w: Math.max(8, Math.round(Number(px[1]) / 8)), h: Math.max(8, Math.round(Number(px[2]) / 8)) };
    const ar = /^(\d+):(\d+)$/.exec(size);
    if (ar) return { w: Number(ar[1]) * 8, h: Number(ar[2]) * 8 };
  }
  return { w: 64, h: 64 };
}

export const DEFAULT_IMAGE_USAGE = { input_tokens: 1200, output_tokens: 4160, total_tokens: 5360, input_tokens_details: { image_tokens: 1100, text_tokens: 100 } };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startFakeImage(): Promise<FakeImage> {
  const queue: FakeImageReply[] = [];
  const requests: RecordedImageRequest[] = [];
  const hanging = new Set<ServerResponse>();
  const held: (() => void)[] = [];
  let hangWaiters: (() => void)[] = [];
  const files = new Map<string, Buffer>();
  const state = { models: ['fake-image-model', 'other-image-model'] as string[] | null, origin: '' };

  const imageBody = (r: Extract<FakeImageReply, { type: 'image' }>, size: unknown) => {
    const s = outputSize(size);
    const bytes = r.format === 'webp' ? fakeWebp(s.w, s.h) : fakePng(s.w, s.h);
    let item: Record<string, string>;
    if (r.delivery === 'url') {
      const name = `${randomUUID()}.png`;
      files.set(name, bytes);
      item = { url: `${state.origin}/files/${name}` };
    } else {
      item = { b64_json: bytes.toString('base64') };
    }
    return { created: 0, data: [item], ...(r.usage === null ? {} : { usage: r.usage ?? DEFAULT_IMAGE_USAGE }) };
  };

  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const path = (req.url ?? '/').split('?')[0]!;
      const ct = req.headers['content-type'];
      const kind: RecordedImageRequest['kind'] =
        path === '/v1/images/edits'
          ? 'edits'
          : path === '/v1/images/generations'
            ? 'generations'
            : path === '/v1/images'
              ? 'images'
              : path === '/v1/models'
                ? 'models'
                : path.startsWith('/files/')
                  ? 'file'
                  : 'other';
      const rec: RecordedImageRequest = {
        method: req.method ?? 'GET',
        path,
        kind,
        authorization: req.headers.authorization,
        userAgent: req.headers['user-agent'],
        contentType: ct,
        fields: [],
        files: [],
        json: null,
      };
      let size: unknown = null;
      if (ct?.startsWith('multipart/form-data')) {
        const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
        for (const [name, value] of form.entries()) {
          if (typeof value === 'string') {
            rec.fields.push([name, value]);
            if (name === 'size') size = value;
          } else {
            const buf = Buffer.from(await value.arrayBuffer());
            rec.files.push({ field: name, filename: value.name, type: value.type, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
          }
        }
      } else if (raw.length) {
        try {
          rec.json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          size = rec.json.size ?? rec.json.aspect_ratio ?? null;
        } catch {
          rec.json = null;
        }
      }
      requests.push(rec);

      if (req.method === 'GET' && kind === 'models') {
        if (state.models === null) return send(res, 404, { error: { message: 'Not found' } });
        return send(res, 200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })) });
      }
      if (req.method === 'GET' && kind === 'file') {
        const f = files.get(path.slice('/files/'.length));
        if (!f) return send(res, 404, { error: { message: 'Not found' } });
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': f.length });
        return res.end(f);
      }
      if (req.method !== 'POST' || (kind !== 'edits' && kind !== 'generations' && kind !== 'images')) {
        return send(res, 404, { error: { message: 'Not found' } });
      }
      const r = queue.shift() ?? imageReply.ok();
      switch (r.type) {
        case 'image':
          return send(res, 200, imageBody(r, size));
        case 'status':
          return send(res, r.status, r.body ?? { error: { message: `status ${r.status}` } }, r.headers);
        case 'echo_auth':
          return send(res, r.status, { error: { message: `Incorrect API key provided: ${req.headers.authorization ?? ''}`, type: 'invalid_request_error' } });
        case 'hang':
        case 'hold':
          hanging.add(res);
          res.on('close', () => hanging.delete(res));
          if (r.type === 'hold') held.push(() => send(res, 200, imageBody({ type: 'image' }, size)));
          for (const w of hangWaiters) w();
          hangWaiters = [];
          return;
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  state.origin = `http://127.0.0.1:${port}`;

  return {
    url: `${state.origin}/v1`,
    origin: state.origin,
    requests,
    imageRequests: () => requests.filter((r) => r.method === 'POST' && (r.kind === 'edits' || r.kind === 'generations' || r.kind === 'images')),
    enqueue: (...replies) => queue.push(...replies),
    get models() {
      return state.models;
    },
    set models(v) {
      state.models = v;
    },
    waitForHang: () =>
      new Promise<void>((resolve) => {
        if (hanging.size > 0) resolve();
        else hangWaiters.push(resolve);
      }),
    release: () => {
      for (const f of held.splice(0)) f();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export const IMAGE_TEST_KEY = 'sk-img-SECRET-7a6b5c4d3e2f1098';

export function imageEnv(baseUrl: string, model = 'fake-image-model', key = IMAGE_TEST_KEY): NodeJS.ProcessEnv {
  return { STORYSCRIPT_IMAGE_BASE_URL: baseUrl, STORYSCRIPT_IMAGE_API_KEY: key, STORYSCRIPT_IMAGE_MODEL: model };
}

/**
 * Board rows are written by the M4 board routes; tests of the redraw
 * pipeline insert one directly (same columns as migration 001).
 */
export function insertBoardRow(db: DbPort, shotId: string, spec: BoardSpec, opts: { version?: number; basis?: string } = {}): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO board (id, shot_id, version, parent_board_id, spec_json, renderer_version, basis_content_hash, user_edited, revision, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, ?)`,
    id,
    shotId,
    opts.version ?? 1,
    JSON.stringify(spec),
    RENDERER_VERSION,
    opts.basis ?? 'basis',
    new Date().toISOString(),
  );
  return id;
}

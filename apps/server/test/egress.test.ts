import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkPublicBaseUrl, createGuardedFetch, EgressBlockedError, isPublicAddress, publicOnlyFetch } from '../src/security/egress.ts';

/**
 * S2b: on a hosted server every group sets its own model service, so the
 * server's outbound fetch must never reach loopback, the private network or
 * the cloud metadata address, whatever base_url, DNS answer or redirect a
 * group arranges. Test servers run on loopback, so these tests use the same
 * guard with an allow-list of 127.0.0.1 over plain http.
 */

let server: Server;
let base = '';
const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  seen.push({ url: req.url ?? '', headers: req.headers, body });
  const port = (server.address() as AddressInfo).port;
  switch (req.url) {
    case '/json':
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    case '/gzip':
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(JSON.stringify({ zipped: true })));
      return;
    case '/echo':
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: req.headers['content-type'], length: body.length, body }));
      return;
    case '/to-same':
      res.writeHead(302, { location: '/json' }).end();
      return;
    case '/to-other-host':
      res.writeHead(307, { location: `http://localhost:${port}/echo` }).end();
      return;
    case '/to-private':
      res.writeHead(302, { location: `http://127.0.0.2:${port}/json` }).end();
      return;
    case '/huge':
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(64 * 1024));
      return;
    case '/slow':
      setTimeout(() => res.writeHead(200).end('late'), 2000);
      return;
    case '/v1/chat/completions':
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `收到：${JSON.parse(body).messages[0].content}` } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    default:
      res.writeHead(404).end();
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// loopback test servers stand in for "a public address"; everything else stays blocked
const loopbackOnly = createGuardedFetch({ requireHttps: false, isAllowedAddress: (a) => a === '127.0.0.1' || a === '::1', maxBodyBytes: 32 * 1024 });
const only127 = createGuardedFetch({ requireHttps: false, isAllowedAddress: (a) => a === '127.0.0.1' });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('did not reject');
}

describe('which addresses count as public', () => {
  test.each([
    ['8.8.8.8', true],
    ['20.214.225.88', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', true],
    ['2002:7f00:1::', false],
    ['not-an-ip', false],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('the guarded fetch', () => {
  test('plain requests, JSON and gzip bodies work like fetch', async () => {
    expect(await (await loopbackOnly(`${base}/json`)).json()).toEqual({ ok: true });
    const z = await loopbackOnly(`${base}/gzip`);
    expect(z.headers.get('content-encoding')).toBeNull();
    expect(await z.json()).toEqual({ zipped: true });
  });

  test('FormData bodies go out as multipart with their boundary', async () => {
    const form = new FormData();
    form.append('model', 'x');
    form.append('image', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'control.png');
    const r = (await (await loopbackOnly(`${base}/echo`, { method: 'POST', body: form })).json()) as { type: string; body: string };
    expect(r.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(r.body).toContain('filename="control.png"');
  });

  test('redirects are followed and re-checked; the key is dropped when the host changes', async () => {
    expect(await (await loopbackOnly(`${base}/to-same`)).json()).toEqual({ ok: true });
    seen.length = 0;
    await loopbackOnly(`${base}/to-other-host`, { method: 'POST', headers: { authorization: 'Bearer sk-secret' }, body: '{}' });
    const hops = seen.filter((s) => s.url === '/to-other-host' || s.url === '/echo');
    expect(hops[0]!.headers.authorization).toBe('Bearer sk-secret');
    expect(hops[1]!.headers.authorization).toBeUndefined();
    expect(await rejection(only127(`${base}/to-private`))).toBeInstanceOf(EgressBlockedError);
  });

  test('a name resolving to a blocked address is refused at connect time', async () => {
    const port = (server.address() as AddressInfo).port;
    // "localhost" may resolve to ::1 first; only 127.0.0.1 is allowed here
    const onlyNumeric = createGuardedFetch({ requireHttps: false, isAllowedAddress: () => false });
    expect(await rejection(onlyNumeric(`http://localhost:${port}/json`))).toBeInstanceOf(EgressBlockedError);
  });

  test('oversized responses and timeouts fail', async () => {
    expect(String(await rejection(loopbackOnly(`${base}/huge`)))).toMatch(/响应超过/);
    const e = (await rejection(loopbackOnly(`${base}/slow`, { signal: AbortSignal.timeout(100) }))) as Error;
    expect(e.name).toBe('TimeoutError');
  });

  test('the openai SDK works through it', async () => {
    const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: 'sk-test', maxRetries: 0, fetch: loopbackOnly });
    const r = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: '你好' }] });
    expect(r.choices[0]!.message.content).toBe('收到：你好');
  });
});

describe('the hosted server fetch (public https only)', () => {
  test.each([
    'http://api.example.com/v1/models',
    'https://127.0.0.1/v1/models',
    'https://[::1]/v1/models',
    'https://169.254.169.254/metadata/instance',
    'https://10.0.0.5:8443/v1/models',
    'https://localhost/v1/models',
    'https://localhost:2019/load',
  ])('%s is refused before anything is sent', async (url) => {
    expect(await rejection(publicOnlyFetch(url))).toBeInstanceOf(EgressBlockedError);
  });

  test('base_url check when a group saves its settings', async () => {
    expect(await checkPublicBaseUrl('http://api.example.com/v1')).toMatch(/https/);
    expect(await checkPublicBaseUrl('https://127.0.0.1:8080/v1')).toMatch(/本机或内网/);
    expect(await checkPublicBaseUrl('https://localhost/v1')).toMatch(/本机或内网/);
    expect(await checkPublicBaseUrl('https://8.8.8.8/v1')).toBeNull();
    // a name that does not resolve (yet) is let through; the connect-time check still applies
    expect(await checkPublicBaseUrl('https://api.example.invalid/v1')).toBeNull();
  });
});

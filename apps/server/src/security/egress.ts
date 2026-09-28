import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * Outbound requests to model services on a hosted server. Each group types
 * its own base_url, so the server must not become a way into the machine
 * it runs on (other services on loopback, the cloud metadata address, the
 * private network). The guarded fetch:
 * - only speaks https,
 * - checks every address a name resolves to at connect time (inside the
 *   socket's own lookup, so a name cannot pass the check and then rebind),
 * - follows redirects itself, re-checking each hop and dropping the
 *   Authorization header when the origin changes,
 * - caps the response size.
 * It is a drop-in `fetch` for the openai SDK and the image adapters.
 */

export type FetchFn = typeof fetch;

export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(readonly host: string) {
    super(`服务器版只能连接公网上的 https 地址，${host} 指向本机或内网`);
    this.name = 'EgressBlockedError';
  }
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const blocked4 = new BlockList();
for (const [net, prefix] of V4_BLOCKED) blocked4.addSubnet(net, prefix, 'ipv4');
/** IPv6: global unicast only, minus documentation, 6to4 and Teredo (they can wrap private IPv4). */
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
blocked6.addSubnet('2001:db8::', 32, 'ipv6');
blocked6.addSubnet('2002::', 16, 'ipv6');
blocked6.addSubnet('2001::', 32, 'ipv6');

/** A public unicast address (not loopback, private, link-local, shared, reserved or multicast). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
  }
  return false;
}

export interface GuardOptions {
  /** false only in tests (loopback test servers speak plain http) */
  requireHttps: boolean;
  isAllowedAddress: (address: string) => boolean;
  maxBodyBytes?: number;
  maxRedirects?: number;
}

const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

function guardedLookup(o: GuardOptions): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family, hints: options.hints, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => !o.isAllowedAddress(a.address))) return callback(new EgressBlockedError(hostname), '', 0);
      if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function decoded(res: IncomingMessage): Readable {
  switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

const NULL_BODY = new Set([101, 204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** Each guard keeps its own connection pools: a kept-alive socket is only ever reused under the policy that checked it. */
interface Pools {
  http: HttpAgent;
  https: HttpsAgent;
}

function once(o: GuardOptions, pools: Pools, url: URL, method: string, headers: Headers, body: Uint8Array | null, signal: AbortSignal): Promise<Response> {
  const host = bareHost(url.hostname);
  if (url.protocol !== 'https:' && (o.requireHttps || url.protocol !== 'http:')) {
    return Promise.reject(new EgressBlockedError(`${url.protocol}//${host}`));
  }
  if (isIP(host) && !o.isAllowedAddress(host)) return Promise.reject(new EgressBlockedError(host));
  if (signal.aborted) return Promise.reject(signal.reason);

  const out: Record<string, string> = {};
  headers.forEach((v, k) => (out[k] = v));
  out['accept-encoding'] = 'gzip, deflate, br';
  if (body) out['content-length'] = String(body.byteLength);
  const max = o.maxBodyBytes ?? 60 * 1024 * 1024;
  const tls = url.protocol === 'https:';
  const send = tls ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    const fail = (err: unknown) => reject(signal.aborted ? signal.reason : err);
    const req = send(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: out,
        agent: tls ? pools.https : pools.http,
        lookup: guardedLookup(o),
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') continue;
          for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
        }
        const finish = (buf: Buffer | null) => {
          const r = new Response(buf, { status, statusText: res.statusMessage ?? '', headers: h });
          Object.defineProperty(r, 'url', { value: url.href });
          resolve(r);
        };
        if (NULL_BODY.has(status) || method === 'HEAD') {
          res.resume();
          return finish(null);
        }
        const stream = decoded(res);
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > max) {
            req.destroy(new Error(`响应超过 ${Math.round(max / 1024 / 1024)} MB`));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => finish(Buffer.concat(chunks)));
        stream.on('error', fail);
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

export function createGuardedFetch(o: GuardOptions): FetchFn {
  const pools: Pools = { http: new HttpAgent({ keepAlive: true }), https: new HttpsAgent({ keepAlive: true }) };
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Request serialises every body kind (string, bytes, FormData → multipart, streams) and fills content-type
    const first = new Request(input, init);
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    const headers = new Headers(first.headers);
    let body: Uint8Array | null = first.body ? new Uint8Array(await first.arrayBuffer()) : null;
    let method = first.method;
    let url = new URL(first.url);
    const maxRedirects = o.maxRedirects ?? 5;
    for (let hop = 0; ; hop++) {
      const res = await once(o, pools, url, method, headers, body, first.signal);
      const location = res.headers.get('location');
      if (mode === 'manual' || !REDIRECT.has(res.status) || !location) return res;
      if (mode === 'error') throw new TypeError(`redirect to ${location} refused`);
      if (hop >= maxRedirects) throw new TypeError('too many redirects');
      const next = new URL(location, url);
      if (next.origin !== url.origin) headers.delete('authorization');
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
        headers.delete('content-type');
      }
      url = next;
    }
  };
  return guarded as FetchFn;
}

/** The hosted server's fetch for model services: public https only. */
export const publicOnlyFetch: FetchFn = createGuardedFetch({ requireHttps: true, isAllowedAddress: isPublicAddress });

/**
 * Save-time check of a base_url on a hosted server, so a group learns about a
 * wrong address when it saves rather than on the first call. The connect-time
 * check above is what actually protects; a name that does not resolve now is
 * let through (it fails later, visibly).
 */
export async function checkPublicBaseUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '不是有效的网址';
  }
  if (url.protocol !== 'https:') return '服务器版只能连接 https 地址（以 https:// 开头）';
  const host = bareHost(url.hostname);
  if (isIP(host)) return isPublicAddress(host) ? null : `${host} 是本机或内网地址，服务器版不能连接`;
  const addresses = await new Promise<LookupAddress[] | null>((resolve) => {
    dnsLookup(host, { all: true }, (err, list) => resolve(err ? null : list));
  });
  if (addresses && addresses.some((a) => !isPublicAddress(a.address))) return `${host} 指向本机或内网地址，服务器版不能连接`;
  return null;
}

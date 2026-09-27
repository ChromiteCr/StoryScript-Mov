import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createSha256, mulberry32 } from '../../src/index.ts';

const nodeSha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function hashInChunks(b: Uint8Array, sizes: () => number): string {
  const h = createSha256();
  for (let o = 0; o < b.length; ) {
    const n = Math.min(b.length - o, Math.max(0, sizes()));
    h.update(b.subarray(o, o + n));
    o += n;
  }
  return h.digest();
}

function randomBytes(seed: number, length: number): Uint8Array {
  const rnd = mulberry32(seed);
  return Uint8Array.from({ length }, () => Math.floor(rnd() * 256));
}

describe('createSha256 (FIPS 180-4)', () => {
  test('known answers', () => {
    const one = (s: string): string => {
      const h = createSha256();
      h.update(new TextEncoder().encode(s));
      return h.digest();
    };
    expect(one('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(one('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const twoBlocks = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(one(twoBlocks)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(one(twoBlocks)).toBe(nodeSha(new TextEncoder().encode(twoBlocks)));
    expect(one('abc')).toBe(nodeSha(new TextEncoder().encode('abc')));
    expect(createSha256().digest()).toBe(nodeSha(new Uint8Array(0)));
  });

  test('every length around the padding boundaries, byte by byte and in one piece', () => {
    const data = randomBytes(1, 200);
    for (const len of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 200]) {
      const b = data.subarray(0, len);
      expect(hashInChunks(b, () => 1)).toBe(nodeSha(b));
      expect(hashInChunks(b, () => len)).toBe(nodeSha(b));
    }
  });

  test('1 MB of random data fed in random chunk sizes (including empty chunks)', () => {
    const b = randomBytes(42, 1024 * 1024);
    const want = nodeSha(b);
    const rnd = mulberry32(9);
    expect(hashInChunks(b, () => Math.floor(rnd() * 70))).toBe(want);
    expect(hashInChunks(b, () => Math.floor(rnd() * 100_000))).toBe(want);
    expect(hashInChunks(b, () => 64 * 1024)).toBe(want);
    expect(hashInChunks(b, () => 1 << 30)).toBe(want);
  });

  test('each demo clip matches node:crypto and the manifest', () => {
    const demo = join(import.meta.dirname, '..', '..', '..', '..', 'samples', 'demo-media');
    const manifest = JSON.parse(readFileSync(join(demo, 'media.json'), 'utf8')) as { clips: { rel_path: string; sha256: string }[] };
    const rnd = mulberry32(3);
    for (const c of manifest.clips) {
      const b = new Uint8Array(readFileSync(join(demo, 'clips', c.rel_path)));
      const got = hashInChunks(b, () => 1 + Math.floor(rnd() * 8192));
      expect(got, c.rel_path).toBe(nodeSha(b));
      expect(got, c.rel_path).toBe(c.sha256);
    }
  });

  test('digest() is final: repeat calls agree, update() afterwards throws', () => {
    const h = createSha256();
    h.update(Uint8Array.of(1, 2, 3));
    const d = h.digest();
    expect(h.digest()).toBe(d);
    expect(() => h.update(Uint8Array.of(4))).toThrow();
  });
});

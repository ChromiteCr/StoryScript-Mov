import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ProbeNormalized } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { deriveMediaFlags, mulberry32, probeIsoFile, type IsoProbeResult, type ReadAt } from '../../src/index.ts';
import { aacProfileFromConfig, frameToTimecode } from '../../src/media/iso-bmff.ts';

/**
 * Ground truth: samples/demo-media/media.json holds the ffprobe-derived
 * ProbeNormalized of each demo clip (generated with lavfi, see notes.txt).
 */
const DEMO = join(import.meta.dirname, '..', '..', '..', '..', 'samples', 'demo-media');
interface Clip {
  rel_path: string;
  probe: ProbeNormalized;
}
const clips = (JSON.parse(readFileSync(join(DEMO, 'media.json'), 'utf8')) as { clips: Clip[] }).clips;
const bytesOf = (c: Clip): Uint8Array => new Uint8Array(readFileSync(join(DEMO, 'clips', c.rel_path)));
const clip = (name: string): Clip => clips.find((c) => c.rel_path === name)!;

function reader(bytes: Uint8Array, log?: [number, number][]): ReadAt {
  return async (offset, length) => {
    log?.push([offset, length]);
    const start = Math.min(Math.max(0, offset), bytes.length);
    return bytes.subarray(start, Math.min(bytes.length, start + length));
  };
}

const probeBytes = (bytes: Uint8Array): Promise<IsoProbeResult> => probeIsoFile(reader(bytes), bytes.length);

// ---------------------------------------------------------------- test-side box helpers

interface TopBox {
  type: string;
  start: number;
  hdr: number;
  end: number;
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function boxesIn(b: Uint8Array, from: number, to: number): TopBox[] {
  const dv = view(b);
  const out: TopBox[] = [];
  for (let o = from; o + 8 <= to; ) {
    let size = dv.getUint32(o);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      hdr = 16;
    } else if (size === 0) size = to - o;
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    out.push({ type, start: o, hdr, end: o + size });
    o += size;
  }
  return out;
}

/** Adds `shift` to every stco/co64 entry inside a moov copy. */
function shiftChunkOffsets(moov: Uint8Array, shift: number): void {
  const dv = view(moov);
  const walk = (from: number, to: number): void => {
    for (const x of boxesIn(moov, from, to)) {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(x.type)) walk(x.start + x.hdr, x.end);
      const body = x.start + x.hdr;
      if (x.type === 'stco') {
        const n = dv.getUint32(body + 4);
        for (let i = 0; i < n; i++) dv.setUint32(body + 8 + i * 4, dv.getUint32(body + 8 + i * 4) + shift);
      } else if (x.type === 'co64') {
        const n = dv.getUint32(body + 4);
        for (let i = 0; i < n; i++) dv.setBigUint64(body + 8 + i * 8, dv.getBigUint64(body + 8 + i * 8) + BigInt(shift));
      }
    }
  };
  walk(0, moov.length);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** "Fast start" rewrite: moov moved in front of the first mdat, chunk offsets adjusted. */
function faststart(b: Uint8Array): Uint8Array {
  const top = boxesIn(b, 0, b.length);
  const moovBox = top.find((x) => x.type === 'moov')!;
  const firstMdat = top.findIndex((x) => x.type === 'mdat');
  const moov = b.slice(moovBox.start, moovBox.end);
  shiftChunkOffsets(moov, moov.length);
  const others = top.filter((x) => x !== moovBox).map((x) => b.subarray(x.start, x.end));
  return concat([...others.slice(0, firstMdat), moov, ...others.slice(firstMdat)]);
}

function mdatPayload(b: Uint8Array): [number, number] {
  const m = boxesIn(b, 0, b.length).find((x) => x.type === 'mdat')!;
  return [m.start + m.hdr, m.end];
}

function indexOfBytes(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------- comparison with ffprobe truth

const FIELDS = [
  'index',
  'codec_type',
  'codec_name',
  'profile',
  'pix_fmt',
  'width',
  'height',
  'time_base_num',
  'time_base_den',
  'start_pts',
  'duration_ts',
  'avg_frame_rate',
  'bits_per_raw_sample',
] as const;

/** ffprobe's r_frame_rate is a heuristic guess; ours is time scale / most common sample delta. */
const R_FRAME_RATE_GUESSED = new Set(['S01-003-T02.mp4']);

function expectLikeFfprobe(res: IsoProbeResult, c: Clip): void {
  expect(res.ok, res.ok ? '' : `${res.reason}: ${res.detail}`).toBe(true);
  if (!res.ok) return;
  const p = res.probe;
  const truth = c.probe;
  expect(ProbeNormalized.safeParse(p).success).toBe(true);
  expect(p.format_name).toBe(truth.format_name);
  expect(p.duration_s).not.toBeNull();
  expect(Math.abs(p.duration_s! - truth.duration_s!)).toBeLessThanOrEqual(0.01);
  expect(p.timecode).toBe(truth.timecode);
  expect(p.creation_time).toBe(truth.creation_time);
  expect(p.streams).toHaveLength(truth.streams.length);
  truth.streams.forEach((t, i) => {
    const s = p.streams[i]!;
    for (const k of FIELDS) expect(s[k], `stream ${i} ${k}`).toEqual(t[k]);
    if (!R_FRAME_RATE_GUESSED.has(c.rel_path)) expect(s.r_frame_rate, `stream ${i} r_frame_rate`).toBe(t.r_frame_rate);
  });
  const ext = extname(c.rel_path);
  expect(deriveMediaFlags(p, ext)).toEqual(deriveMediaFlags(truth, ext));
}

describe('probeIsoFile matches ffprobe on the demo clips', () => {
  test('the demo set covers the intended cases', () => {
    const codecs = clips.flatMap((c) => c.probe.streams.map((s) => s.codec_name));
    expect(clips).toHaveLength(6);
    expect(codecs).toEqual(expect.arrayContaining(['h264', 'hevc', 'prores', 'aac', 'pcm_s16le']));
    expect(clips.some((c) => c.probe.timecode === '01:00:00:00')).toBe(true);
  });

  test.each(clips.map((c) => [c.rel_path, c] as const))('%s (moov at end, as recorded)', async (_name, c) => {
    const bytes = bytesOf(c);
    const top = boxesIn(bytes, 0, bytes.length).map((x) => x.type);
    expect(top.indexOf('moov')).toBeGreaterThan(top.indexOf('mdat'));
    expectLikeFfprobe(await probeBytes(bytes), c);
  });

  test.each(clips.map((c) => [c.rel_path, c] as const))('%s (fast start: moov before mdat)', async (_name, c) => {
    const bytes = faststart(bytesOf(c));
    const top = boxesIn(bytes, 0, bytes.length).map((x) => x.type);
    expect(top.indexOf('moov')).toBeLessThan(top.indexOf('mdat'));
    expectLikeFfprobe(await probeBytes(bytes), c);
  });

  test('QuickTime file without ftyp (mdat first) still probes, timecode included', async () => {
    const c = clip('A001C003.mov');
    const b = bytesOf(c);
    const top = boxesIn(b, 0, b.length);
    const skip = top.filter((x) => x.type === 'ftyp' || x.type === 'wide');
    const cut = skip.reduce((n, x) => n + (x.end - x.start), 0);
    const moovBox = top.find((x) => x.type === 'moov')!;
    const moov = b.slice(moovBox.start, moovBox.end);
    shiftChunkOffsets(moov, -cut);
    const rest = top.filter((x) => !skip.includes(x) && x !== moovBox).map((x) => b.subarray(x.start, x.end));
    const bare = concat([...rest, moov]);
    expect(boxesIn(bare, 0, bare.length)[0]!.type).toBe('mdat');
    expectLikeFfprobe(await probeBytes(bare), c);
  });
});

describe('only box headers and moov are read', () => {
  test.each(clips.map((c) => [c.rel_path, c] as const))('%s: mdat payload is not read', async (name, c) => {
    for (const bytes of [bytesOf(c), faststart(bytesOf(c))]) {
      const log: [number, number][] = [];
      const res = await probeIsoFile(reader(bytes, log), bytes.length);
      expect(res.ok).toBe(true);
      const [from, to] = mdatPayload(bytes);
      const inMdat = log.filter(([o, n]) => o < to && o + n > from);
      if (name === 'A001C003.mov') {
        // The tmcd track's single 4-byte frame counter, nothing else.
        expect(inMdat).toHaveLength(1);
        expect(inMdat[0]![1]).toBe(4);
      } else {
        expect(inMdat).toEqual([]);
      }
      const total = log.reduce((n, [, len]) => n + len, 0);
      expect(total).toBeLessThan(bytes.length / 10);
    }
  });
});

describe('failures are reported, never thrown', () => {
  test('empty file', async () => {
    const res = await probeIsoFile(reader(new Uint8Array(0)), 0);
    expect(res).toMatchObject({ ok: false, reason: 'not_iso' });
  });

  test('random bytes', async () => {
    const rnd = mulberry32(7);
    for (let k = 0; k < 20; k++) {
      const b = Uint8Array.from({ length: 4096 + k * 97 }, () => Math.floor(rnd() * 256));
      const res = await probeBytes(b);
      expect(res).toMatchObject({ ok: false, reason: 'not_iso' });
    }
  });

  test('a JPEG poster is not ISO media', async () => {
    const jpg = new Uint8Array(readFileSync(join(DEMO, 'posters', 'S01-001-T01.jpg')));
    expect(await probeBytes(jpg)).toMatchObject({ ok: false, reason: 'not_iso' });
  });

  test('truncated recording (moov never written) → no_moov', async () => {
    const b = bytesOf(clip('S01-001-T01.mp4'));
    const res = await probeBytes(b.subarray(0, 60_000));
    expect(res).toMatchObject({ ok: false, reason: 'no_moov' });
  });

  test('file cut inside moov → malformed', async () => {
    const fast = faststart(bytesOf(clip('S01-001-T01.mp4')));
    const moov = boxesIn(fast, 0, fast.length).find((x) => x.type === 'moov')!;
    const res = await probeBytes(fast.subarray(0, moov.start + 500));
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
  });

  test('absurd box sizes → malformed', async () => {
    const ftyp = bytesOf(clip('S01-001-T01.mp4')).subarray(0, 32);
    const huge32 = concat([ftyp, Uint8Array.from([0xff, 0xff, 0xff, 0xf0, 0x6d, 0x6f, 0x6f, 0x76]), new Uint8Array(100)]);
    expect(await probeBytes(huge32)).toMatchObject({ ok: false, reason: 'malformed' });
    const huge64 = concat([
      ftyp,
      Uint8Array.from([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x76, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      new Uint8Array(100),
    ]);
    expect(await probeBytes(huge64)).toMatchObject({ ok: false, reason: 'malformed' });
    const tooSmall = concat([ftyp, Uint8Array.from([0, 0, 0, 4, 0x6d, 0x64, 0x61, 0x74]), new Uint8Array(100)]);
    expect(await probeBytes(tooSmall)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  test('moov over 256 MB → too_large, without reading it', async () => {
    const size = 300 * 1024 * 1024;
    const head = concat([bytesOf(clip('S01-001-T01.mp4')).subarray(0, 32), new Uint8Array(8)]);
    view(head).setUint32(32, size);
    head.set([0x6d, 0x6f, 0x6f, 0x76], 36);
    const log: [number, number][] = [];
    const inner = reader(head, log);
    const res = await probeIsoFile(inner, 32 + size);
    expect(res).toMatchObject({ ok: false, reason: 'too_large' });
    expect(Math.max(...log.map(([, n]) => n))).toBeLessThanOrEqual(16);
  });

  test('a failing reader → malformed', async () => {
    const res = await probeIsoFile(() => Promise.reject(new Error('disk gone')), 1000);
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    if (!res.ok) expect(res.detail).toContain('disk gone');
  });

  test('corrupted moov bytes never throw and any success is a valid probe', async () => {
    const rnd = mulberry32(2024);
    for (const c of clips) {
      const base = faststart(bytesOf(c));
      const moov = boxesIn(base, 0, base.length).find((x) => x.type === 'moov')!;
      for (let k = 0; k < 40; k++) {
        const b = base.slice();
        const flips = 1 + Math.floor(rnd() * 8);
        for (let f = 0; f < flips; f++) {
          const at = moov.start + 8 + Math.floor(rnd() * (moov.end - moov.start - 8));
          b[at] = Math.floor(rnd() * 256);
        }
        const res = await probeBytes(b);
        if (res.ok) expect(ProbeNormalized.safeParse(res.probe).success).toBe(true);
        else expect(['malformed', 'no_moov', 'too_large', 'not_iso']).toContain(res.reason);
      }
    }
  });
});

describe('codec details beyond the demo set', () => {
  test('the demo AAC config carries an SBR sync extension with SBR off → LC', async () => {
    const b = bytesOf(clip('S01-001-T01.mp4'));
    // DecoderSpecificInfo: tag 0x05, length 5, LC 48 kHz mono + sync extension 0x2b7 / AOT 5 / sbr=0.
    expect(indexOfBytes(b, [0x05, 0x80, 0x80, 0x80, 0x05, 0x11, 0x88, 0x56, 0xe5, 0x00])).toBeGreaterThan(0);
    const res = await probeBytes(b);
    expect(res.ok && res.probe.streams[1]!.profile).toBe('LC');
  });

  test.each([
    // configs as written by real encoders; ffprobe reported the same profile for those streams
    ['LC, 48 kHz, SBR sync extension off', '118856e500', 'LC'],
    ['LC core 24 kHz + implicit SBR to 48 kHz', '130856e598', 'HE-AAC'],
    ['implicit SBR + implicit PS (0x548)', '130856e59d4880', 'HE-AACv2'],
    ['explicit object type 5', '2b09880000', 'HE-AAC'],
    ['explicit object type 29', 'eb09880000', 'HE-AACv2'],
    ['plain LC, no extension', '1190', 'LC'],
    ['AAC Main', '0a10', 'Main'],
    ['too short', '11', null],
  ])('AudioSpecificConfig %s', (_what, hex, want) => {
    const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(aacProfileFromConfig(bytes)).toBe(want);
  });

  test('SMPTE timecode strings (non-drop, drop-frame, 24 h wrap)', () => {
    expect(frameToTimecode(90_000, 25, false, false)).toBe('01:00:00:00');
    expect(frameToTimecode(1799, 30, true, false)).toBe('00:00:59;29');
    expect(frameToTimecode(1800, 30, true, false)).toBe('00:01:00;02');
    expect(frameToTimecode(17_982, 30, true, false)).toBe('00:10:00;00');
    expect(frameToTimecode(107_892, 30, true, false)).toBe('01:00:00;00');
    expect(frameToTimecode(3600, 60, true, false)).toBe('00:01:00;04');
    expect(frameToTimecode(25 * 3600 * 24 + 5, 25, false, true)).toBe('00:00:00:05');
    expect(frameToTimecode(25 * 3600 * 24 + 5, 25, false, false)).toBe('24:00:00:05');
  });
});

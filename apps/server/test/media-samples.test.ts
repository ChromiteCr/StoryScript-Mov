import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ProbeNormalized, SourceRange } from '@storyscript/contracts';
import { deriveMediaFlags, type MediaFlags, wholeAssetSourceRange } from '@storyscript/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateMedia, type GenResult, SAMPLE, SAMPLE_CREATION_TIME, SAMPLE_TIMECODE } from '../../../scripts/gen-media.ts';
import { locateTool } from '../src/adapters/media/ffmpeg.ts';
import { hashFile } from '../src/adapters/media/hash.ts';
import { extractPoster, PathNotAllowedError } from '../src/adapters/media/poster.ts';
import { ffInput, ProbeError, probeFile } from '../src/adapters/media/probe.ts';

/**
 * Media spike on lavfi-generated samples (AT-11/AT-12 subset):
 * probe → normalize → flags, input-side -ss posters, streaming SHA-256,
 * and INV-04 (the source folder never gains or changes a file).
 */

const ffmpeg = locateTool('ffmpeg');
const ffprobe = locateTool('ffprobe');
const POSTER_BUDGET_MS = 300;

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const s = await stat(p);
    const sha = createHash('sha256').update(await readFile(p)).digest('hex');
    out[name] = `${s.size}:${s.mtimeMs}:${sha}`;
  }
  return out;
}

describe.skipIf(!ffmpeg || !ffprobe)('media samples: probe, flags, posters, hashing', () => {
  let root: string;
  let src: string;
  let derivatives: string;
  let gen: GenResult;
  let before: Record<string, string>;
  const flags = new Map<string, { probe: ProbeNormalized; flags: MediaFlags }>();
  const generated = (f: string) => gen.files.some((g) => g.file === f);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ssm-media-'));
    src = join(root, 'card');
    derivatives = join(root, 'project', 'derivatives', 'posters');
    gen = await generateMedia(src, { ffmpeg });
    await mkdir(derivatives, { recursive: true });
    before = await snapshot(src);
    for (const f of Object.values(SAMPLE)) {
      if (!generated(f) || f === SAMPLE.notes || f === SAMPLE.appleDouble) continue;
      const probe = await probeFile(ffprobe!, join(src, f));
      flags.set(f, { probe, flags: deriveMediaFlags(probe, extname(f)) });
    }
  }, 120_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('generator produced the H.264 set and explains every skip', () => {
    expect(gen.h264).not.toBeNull();
    for (const f of [SAMPLE.h264Mp4, SAMPLE.h264Mov, SAMPLE.timecodeMov, SAMPLE.vfrMp4]) expect(generated(f)).toBe(true);
    for (const s of gen.skipped) expect(s.reason.length).toBeGreaterThan(0);
    expect(gen.files.length + gen.skipped.length).toBe(Object.keys(SAMPLE).length);
  });

  test('normalized probes are schema-valid and ranges are exact', () => {
    for (const [f, { probe, flags: fl }] of flags) {
      expect(ProbeNormalized.safeParse(probe).success, f).toBe(true);
      expect(fl.kind, f).toBe('video');
      expect(fl.video_stream_index, f).not.toBeNull();
      const r = wholeAssetSourceRange(probe, fl.video_stream_index!);
      expect(r?.exact, f).toBe(true);
      expect(SourceRange.safeParse(r?.range).success, f).toBe(true);
      const secs = ((r!.range.out_pts - r!.range.in_pts) * r!.range.time_base_num) / r!.range.time_base_den;
      expect(Math.abs(secs - gen.seconds), f).toBeLessThan(0.1);
    }
  });

  test('H.264 8-bit 4:2:0 mp4/mov is playable_direct', () => {
    for (const f of [SAMPLE.h264Mp4, SAMPLE.h264Mov, SAMPLE.timecodeMov]) {
      const e = flags.get(f)!;
      expect(e.probe.streams.find((s) => s.index === e.flags.video_stream_index)?.codec_name, f).toBe('h264');
      expect(e.flags, f).toMatchObject({ playable_direct: true, is_vfr_suspect: false });
    }
  });

  test('A001C003.mov carries timecode and creation_time', () => {
    const e = flags.get(SAMPLE.timecodeMov)!;
    expect(e.flags.has_timecode).toBe(true);
    expect(e.probe.timecode).toBe(SAMPLE_TIMECODE);
    expect(e.probe.creation_time).toBe(SAMPLE_CREATION_TIME);
    expect(flags.get(SAMPLE.h264Mp4)!.flags.has_timecode).toBe(false);
  });

  test('VFR sample is flagged, CFR samples are not', () => {
    expect(flags.get(SAMPLE.vfrMp4)!.flags.is_vfr_suspect).toBe(true);
    expect(flags.get(SAMPLE.h264Mov)!.flags.is_vfr_suspect).toBe(false);
  });

  test('HEVC (10-bit when available) and ProRes need a proxy', (ctx) => {
    const hevc = flags.get(SAMPLE.hevcMov);
    const prores = flags.get(SAMPLE.proresMov);
    if (!hevc && !prores) ctx.skip();
    if (hevc) {
      const v = hevc.probe.streams.find((s) => s.index === hevc.flags.video_stream_index)!;
      expect(v.codec_name).toBe('hevc');
      if (gen.files.find((g) => g.file === SAMPLE.hevcMov)?.note?.includes('Main10')) expect(v.pix_fmt).toMatch(/10/);
      expect(hevc.flags.playable_direct).toBe(false);
    }
    if (prores) {
      const v = prores.probe.streams.find((s) => s.index === prores.flags.video_stream_index)!;
      expect(v.codec_name).toBe('prores');
      expect(v.pix_fmt).toBe('yuv422p10le');
      expect(prores.flags.playable_direct).toBe(false);
    }
  });

  test('AppleDouble stub is not media to ffprobe (scanner must skip ._* by name)', async () => {
    await expect(probeFile(ffprobe!, join(src, SAMPLE.appleDouble))).rejects.toBeInstanceOf(ProbeError);
    // .txt is excluded by the extension whitelist before ffprobe ever sees it
    expect(deriveMediaFlags(null, extname(SAMPLE.notes)).kind).toBe('other');
    expect(() => ffInput('relative/clip.mov')).toThrow();
  });

  test(`poster frames via input-side -ss, each < ${POSTER_BUDGET_MS}ms`, async () => {
    const timings: Record<string, number> = {};
    for (const f of flags.keys()) {
      const out = join(derivatives, `${f}.jpg`);
      const t0 = performance.now();
      const r = await extractPoster(ffmpeg!, join(src, f), out, {
        allowedDir: derivatives,
        atSeconds: gen.seconds / 2,
        streamIndex: flags.get(f)!.flags.video_stream_index!,
      });
      timings[f] = Math.round(performance.now() - t0);
      const jpg = await readFile(r.path);
      expect(r.bytes).toBe(jpg.length);
      expect([jpg[0], jpg[1]], f).toEqual([0xff, 0xd8]);
      expect(timings[f], f).toBeLessThan(POSTER_BUDGET_MS);
    }
    console.info('[spike] poster ms', timings);
    expect((await readdir(derivatives)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('poster output is confined to allowedDir', async () => {
    const clip = join(src, SAMPLE.h264Mp4);
    const opts = { allowedDir: derivatives, atSeconds: 0 };
    await expect(extractPoster(ffmpeg!, clip, join(src, 'poster.jpg'), opts)).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(extractPoster(ffmpeg!, clip, join(derivatives, '..', '..', 'x.jpg'), opts)).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await expect(extractPoster(ffmpeg!, clip, derivatives, opts)).rejects.toBeInstanceOf(PathNotAllowedError);
    // a symlinked sub-folder pointing at the card must not be a way out
    await symlink(src, join(derivatives, 'escape'));
    await expect(extractPoster(ffmpeg!, clip, join(derivatives, 'escape', 'p.jpg'), opts)).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await rm(join(derivatives, 'escape'));
    // nested folders inside the sandbox are created on demand
    const ok = await extractPoster(ffmpeg!, clip, join(derivatives, 'a', 'b', 'p.jpg'), opts);
    expect(ok.bytes).toBeGreaterThan(0);
  });

  test('hashFile streams SHA-256 and is stable', async () => {
    for (const f of flags.keys()) {
      const p = join(src, f);
      const a = await hashFile(p);
      const b = await hashFile(p);
      expect(a.status).toBe('done');
      expect(a).toEqual(b);
      const want = createHash('sha256').update(await readFile(p)).digest('hex');
      if (a.status === 'done') expect(a.sha256).toBe(want);
    }
  });

  test('hashFile reports source_changed when size/mtime differ from the scan', async () => {
    const p = join(src, SAMPLE.h264Mp4);
    const s = await stat(p);
    expect(await hashFile(p, { expect: { size: s.size, mtimeMs: s.mtimeMs } })).toMatchObject({ status: 'done' });
    expect(await hashFile(p, { expect: { size: s.size + 1, mtimeMs: s.mtimeMs } })).toEqual({ status: 'source_changed' });
  });

  test('hashFile reports source_changed when the file changes during the read', { retry: 2 }, async () => {
    // scratch file outside the card: 96 MiB takes tens of ms to hash
    const p = join(root, 'growing.bin');
    await writeFile(p, Buffer.alloc(96 * 1024 * 1024, 7));
    const pending = hashFile(p);
    await new Promise((r) => setTimeout(r, 5));
    const t = new Date(Date.now() + 60_000);
    await utimes(p, t, t);
    expect(await pending).toEqual({ status: 'source_changed' });
    await rm(p);
  });

  test('INV-04: source folder is byte-for-byte unchanged, no new files', async () => {
    expect(await snapshot(src)).toEqual(before);
  });
});

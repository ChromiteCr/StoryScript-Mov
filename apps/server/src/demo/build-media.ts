/**
 * Regenerates samples/demo-media/ — the footage of the `--demo` project:
 *
 *   npx tsx apps/server/src/demo/build-media.ts [--out samples/demo-media]
 *
 * 1. scripts/gen-media.ts --small with libopenh264 (lavfi testsrc2 + sine,
 *    nothing copied, CLEANROOM §2) into a temp folder;
 * 2. the clips the demo uses are copied to clips/ (the AppleDouble stub is not);
 * 3. each clip is probed (ffprobe → core normalizeProbe) and gets a 480px
 *    poster frame (input-side -ss, like the scan job) in posters/;
 * 4. media.json records rel_path, size, sha256, probe and poster.
 * When clips + posters + manifest exceed 2 MB the clips are dropped and the
 * demo shows the footage as offline (posters and metadata still load).
 * Run once by a maintainer; the output is committed. Not part of the bundle.
 */
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { deriveMediaFlags } from '@storyscript/core';
import { generateMedia, SAMPLE } from '../../../../scripts/gen-media.ts';
import { locateTool } from '../adapters/media/ffmpeg.ts';
import { hashFile } from '../adapters/media/hash.ts';
import { extractPoster } from '../adapters/media/poster.ts';
import { probeFile } from '../adapters/media/probe.ts';
import { DEMO_MEDIA_BUDGET_BYTES, DEMO_MEDIA_FORMAT, DemoMediaManifest, type DemoClip } from './media-manifest.ts';

/** The clips the demo project links (see seed.ts): slate-named, clip-hint-named and two "needs proxy" formats. */
const DEMO_CLIP_FILES =[SAMPLE.h264Mp4, SAMPLE.h264Mov, SAMPLE.vfrMp4, SAMPLE.timecodeMov, SAMPLE.hevcMov, SAMPLE.proresMov, SAMPLE.notes] as const;

async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? await dirBytes(p) : (await stat(p)).size;
  }
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'samples/demo-media' } } });
  const out = resolve(values.out);
  const ffmpeg = locateTool('ffmpeg');
  const ffprobe = locateTool('ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error('需要 ffmpeg 和 ffprobe（brew install ffmpeg）');

  const tmp = await mkdtemp(join(tmpdir(), 'ssm-demo-media-'));
  try {
    const gen = await generateMedia(tmp, { ffmpeg, small: true, h264Encoder: 'libopenh264', log: (l) => console.log(l) });
    const encoderOf = new Map(gen.files.map((f) => [f.file, f.encoder] as const));
    await rm(out, { recursive: true, force: true });
    const clipsDir = join(out, 'clips');
    const postersDir = join(out, 'posters');
    await mkdir(clipsDir, { recursive: true });
    await mkdir(postersDir, { recursive: true });

    const clips: DemoClip[] = [];
    for (const file of DEMO_CLIP_FILES) {
      const src = join(tmp, file);
      if (!(await stat(src).catch(() => null))) {
        console.warn(`跳过 ${file}：本机没有生成（${gen.skipped.find((s) => s.file === file)?.reason ?? '未知原因'}）`);
        continue;
      }
      const dest = join(clipsDir, file);
      await copyFile(src, dest);
      if (file === SAMPLE.notes) continue; // provenance note, not footage
      const s = await stat(dest);
      const probe = await probeFile(ffprobe, dest);
      const flags = deriveMediaFlags(probe, file.slice(file.lastIndexOf('.') + 1).toLowerCase());
      const stem = file.slice(0, file.lastIndexOf('.'));
      let poster: string | null = null;
      if (flags.kind === 'video' && flags.video_stream_index !== null) {
        const rel = `posters/${stem}.jpg`;
        await extractPoster(ffmpeg, dest, join(out, rel), {
          allowedDir: postersDir,
          atSeconds: Math.max(0, Math.min(1, (probe.duration_s ?? 0) / 2)),
          streamIndex: flags.video_stream_index,
        });
        poster = rel;
      }
      const hash = await hashFile(dest);
      if (hash.status !== 'done') throw new Error(`hash failed for ${file}`);
      clips.push({ rel_path: file, size: s.size, sha256: hash.sha256, probe, poster, encoder: encoderOf.get(file) ?? null });
      console.log(`  ${file}  ${(s.size / 1024).toFixed(0)} KB  ${flags.playable_direct ? '可直接播放' : '需代理'}`);
    }

    const manifest = (included: boolean) =>
      `${JSON.stringify(
        DemoMediaManifest.parse({
          format: DEMO_MEDIA_FORMAT,
          generated_by: 'apps/server/src/demo/build-media.ts（scripts/gen-media.ts --small，lavfi testsrc2 + sine，不含任何真实拍摄内容）',
          clips_included: included,
          clips,
        }),
        null,
        2,
      )}\n`;
    await writeFile(join(out, 'media.json'), manifest(true));
    let total = await dirBytes(out);
    if (total > DEMO_MEDIA_BUDGET_BYTES) {
      console.warn(`合计 ${(total / 1024).toFixed(0)} KB 超出 2 MB 预算：去掉原片，演示中显示为离线`);
      await rm(clipsDir, { recursive: true, force: true });
      await writeFile(join(out, 'media.json'), manifest(false));
      total = await dirBytes(out);
    }
    console.log(`samples/demo-media：${clips.length} 条素材，合计 ${(total / 1024).toFixed(0)} KB → ${out}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

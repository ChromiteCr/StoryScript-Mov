/**
 * Deterministic test footage from lavfi (testsrc2 + sine). No external media,
 * nothing copied: every byte is generated here (CLEANROOM §2).
 *
 *   npx tsx scripts/gen-media.ts <outdir> [--small] [--h264 libopenh264]
 *
 * Encoders are probed, never assumed: H.264 via listEncoders + pickH264Encoder
 * (falling back along the preference list), HEVC via VideoToolbox/x265,
 * ProRes via prores_ks. A variant with no working encoder is skipped with a reason.
 * Frames/audio are deterministic; container bytes are too for software
 * encoders (libx264/libopenh264/prores_ks) but NOT for VideoToolbox, so pass
 * `--h264 libopenh264` when byte-identical H.264 files are needed.
 * ffmpeg is spawned with argument arrays only (no shell).
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  FFMPEG_SAFE_FLAGS,
  H264_ENCODER_PREFERENCE,
  listEncoders,
  locateTool,
  pickH264Encoder,
  runTool,
} from '../apps/server/src/adapters/media/ffmpeg.ts';

export const SAMPLE = {
  h264Mp4: 'S01-001-T01.mp4',
  h264Mov: 'S01-002-T01.mov',
  timecodeMov: 'A001C003.mov',
  hevcMov: 'IMG_1234.mov',
  proresMov: 'B002C001.mov',
  vfrMp4: 'S01-003-T02.mp4',
  notes: 'notes.txt',
  appleDouble: '._S01-001-T01.mp4',
} as const;

/** Fixed metadata written into A001C003.mov so probe tests have known values. */
export const SAMPLE_TIMECODE = '01:00:00:00';
export const SAMPLE_CREATION_TIME = '2026-01-02T03:04:05.000000Z';

export interface GenOptions {
  /** 320x180 @ 1 s instead of 640x360 @ 2 s */
  small?: boolean;
  /** explicit ffmpeg path (default: locateTool) */
  ffmpeg?: string | null;
  /** preferred H.264 encoder (e.g. libopenh264 for byte-identical output); falls back when unavailable */
  h264Encoder?: string;
  log?: (line: string) => void;
}

export interface GeneratedFile {
  file: string;
  /** video encoder that produced it, null for non-media files */
  encoder: string | null;
  ms: number;
  note?: string;
}

export interface GenResult {
  ffmpeg: string;
  encoders: string[];
  h264: string | null;
  drawtext: boolean;
  seconds: number;
  size: { width: number; height: number };
  files: GeneratedFile[];
  skipped: { file: string; reason: string }[];
}

interface Attempt {
  encoder: string;
  video: string[];
  note?: string;
}

interface Variant {
  file: string;
  format: 'mp4' | 'mov';
  attempts: Attempt[];
  audio: string[];
  extra?: string[];
  videoFilter?: string;
  noEncoderReason: string;
}

function h264Args(enc: string): string[] {
  switch (enc) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '25'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', '2M', '-pix_fmt', 'yuv420p', '-g', '25'];
    default:
      return ['-c:v', enc, '-b:v', '2M', '-pix_fmt', 'yuv420p', '-g', '25'];
  }
}

/** Minimal AppleDouble header (magic 0x00051607, v2, 0 entries) as Finder writes on exFAT. */
function appleDoubleStub(): Buffer {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(0x00051607, 0);
  b.writeUInt32BE(0x00020000, 4);
  b.write('Mac OS X        ', 8, 'latin1');
  b.writeUInt16BE(0, 24);
  return b;
}

export async function generateMedia(outDir: string, opts: GenOptions = {}): Promise<GenResult> {
  const log = opts.log ?? (() => {});
  const ffmpeg = opts.ffmpeg ?? locateTool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg not found (PATH, STORYSCRIPT_FFMPEG, /opt/homebrew/bin, /usr/local/bin)');
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });

  const encoders = await listEncoders(ffmpeg);
  const has = (e: string) => encoders.includes(e);
  const filters = await runTool(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 });
  let drawtext = /\sdrawtext\s/.test(filters.stdout.toString('utf8'));

  const seconds = opts.small ? 1 : 2;
  const size = opts.small ? { width: 320, height: 180 } : { width: 640, height: 360 };
  const picked = opts.h264Encoder && has(opts.h264Encoder) ? opts.h264Encoder : pickH264Encoder(encoders);
  if (opts.h264Encoder && picked !== opts.h264Encoder) log(`H.264 编码器 ${opts.h264Encoder} 不可用，改用 ${picked ?? '无'}`);
  const h264Order = picked ? [picked, ...H264_ENCODER_PREFERENCE.filter((e) => e !== picked && has(e))] : [];
  const h264Attempts: Attempt[] = h264Order.map((e) => ({ encoder: e, video: h264Args(e) }));
  const aac = ['-c:a', 'aac', '-b:a', '128k'];

  // VFR: first 60% of source frames at 1/30 s spacing, the rest at 1/20 s (same total length)
  const n1 = 15 * seconds;
  const vfrExpr = `settb=1/12800,setpts='if(lt(N,${n1}),N/30,${seconds / 2}+(N-${n1})/20)/TB'`;

  const hevcAttempts: Attempt[] = [
    ...(has('hevc_videotoolbox')
      ? [
          {
            encoder: 'hevc_videotoolbox',
            video: ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-b:v', '2M'],
            note: 'Main10 p010le',
          },
        ]
      : []),
    ...(has('libx265')
      ? [
          {
            encoder: 'libx265',
            video: ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error'],
            note: 'Main10 yuv420p10le',
          },
        ]
      : []),
    ...(has('hevc_videotoolbox')
      ? [{ encoder: 'hevc_videotoolbox', video: ['-c:v', 'hevc_videotoolbox', '-b:v', '2M', '-pix_fmt', 'yuv420p'], note: '8-bit fallback' }]
      : []),
    ...(has('libx265')
      ? [
          {
            encoder: 'libx265',
            video: ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error'],
            note: '8-bit fallback',
          },
        ]
      : []),
  ].map((a) => ({ ...a, video: [...a.video, '-tag:v', 'hvc1'] }));

  const proresEnc = ['prores_ks', 'prores', 'prores_aw'].find(has);
  const proresAttempts: Attempt[] = proresEnc
    ? [{ encoder: proresEnc, video: ['-c:v', proresEnc, '-profile:v', '2', '-pix_fmt', 'yuv422p10le'], note: '422 10-bit' }]
    : [];

  const noH264 = `no H.264 encoder (${H264_ENCODER_PREFERENCE.join('/')})`;
  const variants: Variant[] = [
    { file: SAMPLE.h264Mp4, format: 'mp4', attempts: h264Attempts, audio: aac, noEncoderReason: noH264 },
    { file: SAMPLE.h264Mov, format: 'mov', attempts: h264Attempts, audio: aac, noEncoderReason: noH264 },
    {
      file: SAMPLE.timecodeMov,
      format: 'mov',
      attempts: h264Attempts,
      audio: aac,
      extra: ['-timecode', SAMPLE_TIMECODE, '-metadata', `creation_time=${SAMPLE_CREATION_TIME}`],
      noEncoderReason: noH264,
    },
    { file: SAMPLE.hevcMov, format: 'mov', attempts: hevcAttempts, audio: aac, noEncoderReason: 'no HEVC encoder (hevc_videotoolbox/libx265)' },
    {
      file: SAMPLE.proresMov,
      format: 'mov',
      attempts: proresAttempts,
      audio: ['-c:a', 'pcm_s16le'],
      noEncoderReason: 'no ProRes encoder (prores_ks)',
    },
    {
      file: SAMPLE.vfrMp4,
      format: 'mp4',
      attempts: h264Attempts,
      audio: aac,
      videoFilter: vfrExpr,
      extra: ['-fps_mode', 'passthrough', '-enc_time_base:v', '1/12800'],
      noEncoderReason: noH264,
    },
  ];

  const files: GeneratedFile[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const broken = new Set<string>();

  const encode = async (v: Variant, a: Attempt, label: boolean): Promise<{ ok: boolean; err: string }> => {
    let src = `testsrc2=size=${size.width}x${size.height}:rate=25:duration=${seconds}`;
    if (label) {
      src += `,drawtext=text='${v.file}':fontsize=${Math.round(size.height / 12)}:fontcolor=white:box=1:boxcolor=black@0.6:x=12:y=h-th-12`;
    }
    const part = join(dir, `${v.file}.part`);
    const args = [
      ...FFMPEG_SAFE_FLAGS,
      '-y',
      '-f',
      'lavfi',
      '-i',
      src,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      ...(v.videoFilter ? ['-vf', v.videoFilter] : []),
      ...a.video,
      ...v.audio,
      ...(v.extra ?? []),
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      '-f',
      v.format,
      part,
    ];
    const r = await runTool(ffmpeg, args, { timeoutMs: 60_000 });
    if (r.code === 0) {
      await rename(part, join(dir, v.file));
      return { ok: true, err: '' };
    }
    await rm(part, { force: true });
    return { ok: false, err: r.stderr.trim().split('\n').slice(-2).join(' | ') || `exit ${r.code}` };
  };

  for (const v of variants) {
    const attempts = v.attempts.filter((a) => !broken.has(a.video.join(' ')));
    if (attempts.length === 0) {
      const reason = v.attempts.length ? `${v.noEncoderReason}: all candidates failed earlier` : v.noEncoderReason;
      skipped.push({ file: v.file, reason });
      log(`跳过 ${v.file}：${reason}`);
      continue;
    }
    const errors: string[] = [];
    let done = false;
    for (const a of attempts) {
      const t0 = performance.now();
      let r = await encode(v, a, drawtext);
      if (!r.ok && drawtext) {
        const plain = await encode(v, a, false);
        if (plain.ok) {
          drawtext = false;
          log(`drawtext 不可用（${r.err}），后续样本不写文件名`);
        }
        r = plain;
      }
      if (r.ok) {
        const ms = Math.round(performance.now() - t0);
        files.push({ file: v.file, encoder: a.encoder, ms, ...(a.note ? { note: a.note } : {}) });
        log(`生成 ${v.file}  [${a.encoder}${a.note ? `, ${a.note}` : ''}] ${ms}ms`);
        done = true;
        break;
      }
      broken.add(a.video.join(' '));
      errors.push(`${a.encoder}${a.note ? ` ${a.note}` : ''}: ${r.err}`);
    }
    if (!done) {
      const reason = errors.join('; ');
      skipped.push({ file: v.file, reason });
      log(`跳过 ${v.file}：${reason}`);
    }
  }

  await writeFile(
    join(dir, SAMPLE.notes),
    '测试素材说明：本目录由 scripts/gen-media.ts 用 lavfi 生成（testsrc2 + sine），不含任何真实拍摄内容。\n',
  );
  await writeFile(join(dir, SAMPLE.appleDouble), appleDoubleStub());
  files.push({ file: SAMPLE.notes, encoder: null, ms: 0 }, { file: SAMPLE.appleDouble, encoder: null, ms: 0 });

  return { ffmpeg, encoders, h264: picked, drawtext, seconds, size, files, skipped };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { small: { type: 'boolean', default: false }, h264: { type: 'string' } },
  });
  const out = positionals[0];
  if (!out) {
    console.error('用法：npx tsx scripts/gen-media.ts <outdir> [--small] [--h264 <encoder>]');
    process.exit(2);
  }
  try {
    const r = await generateMedia(out, { small: values.small, h264Encoder: values.h264, log: (l) => console.log(l) });
    console.log(`ffmpeg: ${r.ffmpeg}  H.264: ${r.h264 ?? '无'}  drawtext: ${r.drawtext ? '是' : '否'}`);
    console.log(`生成 ${r.files.length} 个文件，跳过 ${r.skipped.length} 个 → ${resolve(out)}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

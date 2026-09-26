import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FFMPEG_SAFE_FLAGS, runTool } from './ffmpeg.ts';
import { ffInput } from './probe.ts';

/**
 * Poster frame: one JPEG via input-side `-ss` (seeks before decoding, so it
 * never decodes the whole clip). Output is confined to `allowedDir`
 * (the project's derivatives folder): realpath-checked, written to a temp
 * name and renamed, so a pre-planted symlink at outPath is replaced, never followed.
 */

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNotAllowedError';
  }
}

export class PosterError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'PosterError';
  }
}

function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Realpath of the nearest existing ancestor + the not-yet-existing tail. */
async function realpathLoose(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(await realpath(cur), ...tail);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `outPath` to a real path strictly inside `allowedDir`, creating
 * missing parent folders. Throws PathNotAllowedError otherwise.
 */
export async function resolveOutputPath(allowedDir: string, outPath: string): Promise<string> {
  const root = await realpath(allowedDir);
  const abs = resolve(outPath);
  // realpath the parent only: an existing symlink at outPath is replaced by rename, not followed
  const target = join(await realpathLoose(dirname(abs)), basename(abs));
  if (!isInside(root, target)) throw new PathNotAllowedError(`output outside allowed dir: ${outPath}`);
  await mkdir(dirname(target), { recursive: true });
  // re-check after mkdir: a symlinked parent could have appeared in between
  const parentReal = await realpath(dirname(target));
  const final = join(parentReal, basename(target));
  if (!isInside(root, final)) throw new PathNotAllowedError(`output outside allowed dir: ${outPath}`);
  const existing = await lstat(final).catch(() => null);
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    throw new PathNotAllowedError(`output exists and is not a file: ${outPath}`);
  }
  return final;
}

export interface PosterOptions {
  /** realpath-checked sandbox for outPath (e.g. `<project>/derivatives/posters`) */
  allowedDir: string;
  atSeconds: number;
  width?: number;
  /** ffprobe stream index; default first video stream */
  streamIndex?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PosterResult {
  path: string;
  bytes: number;
}

export async function extractPoster(
  ffmpeg: string,
  absPath: string,
  outPath: string,
  opts: PosterOptions,
): Promise<PosterResult> {
  const { allowedDir, atSeconds, width = 480, streamIndex, signal, timeoutMs = 20_000 } = opts;
  if (!Number.isFinite(atSeconds) || atSeconds < 0) throw new RangeError(`bad atSeconds: ${atSeconds}`);
  if (!Number.isInteger(width) || width < 16 || width > 4096) throw new RangeError(`bad width: ${width}`);
  if (streamIndex !== undefined && (!Number.isInteger(streamIndex) || streamIndex < 0)) {
    throw new RangeError(`bad streamIndex: ${streamIndex}`);
  }

  const final = await resolveOutputPath(allowedDir, outPath);
  const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
  const args = [
    ...FFMPEG_SAFE_FLAGS,
    '-y',
    '-ss',
    atSeconds.toFixed(3),
    '-i',
    ffInput(absPath),
    '-map',
    streamIndex === undefined ? '0:v:0' : `0:${streamIndex}`,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2`,
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    '-f',
    'image2',
    '-update',
    '1',
    tmp,
  ];
  try {
    const r = await runTool(ffmpeg, args, { timeoutMs, signal });
    if (r.code !== 0) throw new PosterError(`ffmpeg exited with ${r.code}`, r.stderr.trim());
    const s = await stat(tmp).catch(() => null);
    if (!s || s.size === 0) throw new PosterError(`no frame at ${atSeconds}s`, r.stderr.trim());
    await rename(tmp, final);
    return { path: final, bytes: s.size };
  } finally {
    await rm(tmp, { force: true });
  }
}

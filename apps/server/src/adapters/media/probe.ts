import { isAbsolute } from 'node:path';
import type { ProbeNormalized } from '@storyscript/contracts';
import { normalizeProbe } from '@storyscript/core';
import { runTool } from './ffmpeg.ts';

/** ffprobe → normalized metadata. Argument array only, no shell. */

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

/**
 * Input argument for ffmpeg/ffprobe: absolute paths only, forced through the
 * `file:` protocol so names like `http:x` or `concat:a|b` stay plain files.
 */
export function ffInput(absPath: string): string {
  if (!isAbsolute(absPath)) throw new Error(`absolute path required: ${absPath}`);
  return `file:${absPath}`;
}

export async function probeRaw(ffprobe: string, absPath: string, signal?: AbortSignal): Promise<unknown> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', ffInput(absPath)];
  const r = await runTool(ffprobe, args, { timeoutMs: 30_000, signal, maxStdoutBytes: 8 * 1024 * 1024 });
  if (r.code !== 0) throw new ProbeError(`ffprobe exited with ${r.code}`, r.stderr.trim());
  try {
    return JSON.parse(r.stdout.toString('utf8')) as unknown;
  } catch {
    throw new ProbeError('ffprobe returned invalid JSON', r.stderr.trim());
  }
}

export async function probeFile(ffprobe: string, absPath: string, signal?: AbortSignal): Promise<ProbeNormalized> {
  return normalizeProbe(await probeRaw(ffprobe, absPath, signal));
}

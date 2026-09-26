import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Locating and running user-installed ffmpeg/ffprobe.
 * - never bundled (licensing), never invoked through a shell
 * - always an argument array, fixed safety flags, timeout + AbortSignal
 */

export type ToolName = 'ffmpeg' | 'ffprobe';

export interface ToolInfo {
  path: string | null;
  version: string | null;
}

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Search order: explicit override → PATH → well-known Homebrew dirs. */
export function locateTool(name: ToolName, override?: string | null): string | null {
  if (override) return isExecutable(override) ? override : null;
  const envOverride = process.env[name === 'ffmpeg' ? 'STORYSCRIPT_FFMPEG' : 'STORYSCRIPT_FFPROBE'];
  if (envOverride) return isExecutable(envOverride) ? envOverride : null;
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** cap stdout to protect memory (default 64 MiB) */
  maxStdoutBytes?: number;
}

/** Spawn a tool with an argument array. Never uses a shell. */
export function runTool(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 60_000, signal, maxStdoutBytes = 64 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > maxStdoutBytes) {
        child.kill('SIGKILL');
        return;
      }
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 64 * 1024) err += b.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** Safety flags prepended to every ffmpeg invocation. */
export const FFMPEG_SAFE_FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'] as const;

export async function toolVersion(bin: string | null): Promise<string | null> {
  if (!bin) return null;
  try {
    const r = await runTool(bin, ['-version'], { timeoutMs: 10_000 });
    const first = r.stdout.toString('utf8').split('\n')[0] ?? '';
    const m = first.match(/version\s+(\S+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** H.264 encoders we can use, in preference order, filtered by availability. */
export const H264_ENCODER_PREFERENCE = ['libx264', 'h264_videotoolbox', 'libopenh264'] as const;

export async function listEncoders(ffmpeg: string | null): Promise<string[]> {
  if (!ffmpeg) return [];
  try {
    const r = await runTool(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 });
    const text = r.stdout.toString('utf8');
    const names = new Set<string>();
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*[VAS.][F.][S.][X.][B.][D.]\s+(\S+)/);
      if (m?.[1]) names.add(m[1]);
    }
    return [...names];
  } catch {
    return [];
  }
}

export function pickH264Encoder(encoders: string[]): string | null {
  return H264_ENCODER_PREFERENCE.find((e) => encoders.includes(e)) ?? null;
}

import { spawn } from 'node:child_process';

/**
 * Native folder picker. macOS only (osascript, argument array, no shell);
 * other platforms return null and the UI falls back to pasting a path.
 */

export const CHOOSE_FOLDER_SCRIPT = 'POSIX path of (choose folder with prompt "选择文件夹")';

export interface ChooseFolderOptions {
  platform?: NodeJS.Platform;
  /** the dialog waits for the user; default 10 minutes */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function chooseFolder(opts: ChooseFolderOptions = {}): Promise<string | null> {
  const { platform = process.platform, timeoutMs = 10 * 60_000, signal } = opts;
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', CHOOSE_FOLDER_SCRIPT], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const path = out.trim();
      if (code === 0 && path) return resolve(path.length > 1 ? path.replace(/\/+$/, '') : path);
      // -128 = user cancelled; any other failure also yields "no folder"
      if (!/-128/.test(err) && err.trim()) console.warn('[storyscript-mov] osascript:', err.trim());
      resolve(null);
    });
  });
}

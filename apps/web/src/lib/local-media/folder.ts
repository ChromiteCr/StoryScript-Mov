import { FOLDER_RECORDS_DIR } from '@storyscript/contracts';
import { MEDIA_EXTS } from '@storyscript/core';

/**
 * A project folder on this computer, opened in the browser (hosted server).
 * Two ways in:
 *  - a File System Access directory handle (Chrome, Edge): can write the
 *    folder's records under .storyscript-mov/ and be remembered;
 *  - the file list of <input webkitdirectory> (every browser): read-only.
 * Footage is only ever read. Hidden names (".*") are skipped, which also
 * skips the records folder and macOS "._" files.
 */

export interface LocalFile {
  /** "/"-separated, relative to the project folder */
  rel_path: string;
  size: number;
  mtime_ms: number;
}

export interface LocalFolder {
  readonly name: string;
  /** records can be written into .storyscript-mov/ */
  readonly writable: boolean;
  /** the directory handle, when opened that way (for the recent list) */
  readonly handle: FsDirHandle | null;
  list(signal?: AbortSignal): Promise<LocalFile[]>;
  file(relPath: string): Promise<File | null>;
  readRecord(name: string): Promise<string | null>;
  writeRecord(name: string, text: string): Promise<void>;
}

// Minimal File System Access shapes (not every TypeScript DOM lib has them).
export interface FsWritable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}
export interface FsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<FsWritable>;
}
export interface FsDirHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<FsFileHandle | FsDirHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export const MAX_FOLDER_FILES = 20_000;
const MAX_DEPTH = 16;

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** A footage file worth listing (hidden names never are). */
export function isMediaName(name: string): boolean {
  return !name.startsWith('.') && MEDIA_EXTS.has(extOf(name));
}

export class FolderTooLargeError extends Error {
  constructor() {
    super(`文件夹里的素材超过 ${MAX_FOLDER_FILES} 个，请打开范围更小的项目文件夹`);
  }
}

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
};

export function folderFromHandle(root: FsDirHandle, writable: boolean): LocalFolder {
  const walk = async (dir: FsDirHandle, prefix: string, depth: number, out: LocalFile[], signal?: AbortSignal) => {
    for await (const entry of dir.values()) {
      aborted(signal);
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (depth < MAX_DEPTH) await walk(entry, `${prefix}${entry.name}/`, depth + 1, out, signal);
      } else if (isMediaName(entry.name)) {
        const f = await entry.getFile();
        out.push({ rel_path: `${prefix}${entry.name}`, size: f.size, mtime_ms: f.lastModified });
        if (out.length > MAX_FOLDER_FILES) throw new FolderTooLargeError();
      }
    }
  };
  const records = (create: boolean) => root.getDirectoryHandle(FOLDER_RECORDS_DIR, { create });

  return {
    name: root.name,
    writable,
    handle: root,
    async list(signal) {
      const out: LocalFile[] = [];
      await walk(root, '', 0, out, signal);
      return out.sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));
    },
    async file(relPath) {
      try {
        const parts = relPath.split('/');
        let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
        return await (await dir.getFileHandle(parts.at(-1)!)).getFile();
      } catch {
        return null;
      }
    },
    async readRecord(name) {
      try {
        return await (await (await records(false)).getFileHandle(name)).getFile().then((f) => f.text());
      } catch {
        return null;
      }
    },
    async writeRecord(name, text) {
      if (!writable) throw new Error('这个文件夹是只读打开的，不能写入记录');
      const h = await (await records(true)).getFileHandle(name, { create: true });
      if (!h.createWritable) throw new Error('这个浏览器不能写入文件');
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
    },
  };
}

/** The files of an <input webkitdirectory>: webkitRelativePath is "<folder>/<rel>". */
export function folderFromFiles(files: readonly File[]): LocalFolder {
  const byRel = new Map<string, File>();
  const recordFiles = new Map<string, File>();
  let name = '';
  for (const f of files) {
    const full = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = full.split('/');
    if (!name) name = parts.length > 1 ? parts[0]! : '';
    const rel = parts.length > 1 ? parts.slice(1) : parts;
    if (rel[0] === FOLDER_RECORDS_DIR && rel.length === 2) {
      recordFiles.set(rel[1]!, f);
      continue;
    }
    if (rel.some((p) => p.startsWith('.')) || !isMediaName(rel.at(-1)!)) continue;
    byRel.set(rel.join('/'), f);
  }
  return {
    name: name || '本机文件夹',
    writable: false,
    handle: null,
    async list() {
      if (byRel.size > MAX_FOLDER_FILES) throw new FolderTooLargeError();
      return [...byRel.entries()]
        .map(([rel_path, f]) => ({ rel_path, size: f.size, mtime_ms: f.lastModified }))
        .sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));
    },
    async file(relPath) {
      return byRel.get(relPath) ?? null;
    },
    async readRecord(n) {
      return (await recordFiles.get(n)?.text()) ?? null;
    },
    async writeRecord() {
      throw new Error('用文件列表打开的文件夹是只读的：写入记录需要 Chrome 或 Edge');
    },
  };
}

import { describe, expect, it } from 'vitest';
import type { AssetFactsInput, BrowserFilesOutput, MediaAssetView, ProbeNormalized, SourceRoot } from '@storyscript/contracts';
import { folderFromFiles, folderFromHandle, type FsDirHandle, type FsFileHandle, type LocalFile, type LocalFolder } from '../src/lib/local-media/folder.ts';
import { syncFolder, type IngestDeps } from '../src/lib/local-media/ingest.ts';
import { cachedEntry, emptyIndex, INDEX_FILE, LINK_FILE, linkSituation, newLink, readIndex, readLink } from '../src/lib/local-media/records.ts';

/**
 * S1c: a project folder opened in the browser (hosted server). The walk
 * lists footage only (hidden names and .storyscript-mov/ skipped); the
 * folder's records say which project it belongs to and what was already
 * learned; a sync reports the listing, then probes, posters and hashes only
 * what the server lacks, reusing the folder's index for unchanged files.
 */

// ---- a fake directory tree with the File System Access shape ----
type Tree = { [name: string]: Tree | { bytes: string; mtime?: number } };
const isFile = (v: Tree[string]): v is { bytes: string; mtime?: number } => typeof (v as { bytes?: unknown }).bytes === 'string';

function fakeDir(name: string, tree: Tree): FsDirHandle {
  const fileHandle = (n: string, node: { bytes: string; mtime?: number }): FsFileHandle => ({
    kind: 'file',
    name: n,
    getFile: async () => new File([node.bytes], n, { lastModified: node.mtime ?? 1_700_000_000_000 }),
    createWritable: async () => {
      let text = '';
      return { write: async (d) => void (text += String(d)), close: async () => void (node.bytes = text) };
    },
  });
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const [n, v] of Object.entries(tree)) yield isFile(v) ? fileHandle(n, v) : fakeDir(n, v);
    },
    async getDirectoryHandle(n, opts) {
      if (!(n in tree)) {
        if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
        tree[n] = {};
      }
      const v = tree[n]!;
      if (isFile(v)) throw new DOMException('not a dir', 'TypeMismatchError');
      return fakeDir(n, v);
    },
    async getFileHandle(n, opts) {
      if (!(n in tree)) {
        if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
        tree[n] = { bytes: '' };
      }
      const v = tree[n]!;
      if (!isFile(v)) throw new DOMException('not a file', 'TypeMismatchError');
      return fileHandle(n, v);
    },
  };
}

const project = (): Tree => ({
  'A-roll': { 'A001C003.mov': { bytes: 'aaaa' }, '._A001C003.mov': { bytes: 'x' }, deep: { 'A002.MP4': { bytes: 'bb' } } },
  'B-roll': { 'B002C001.mov': { bytes: 'cccccc' } },
  'notes.txt': { bytes: 'hello' },
  '.storyscript-mov': { 'ignored.mov': { bytes: 'z' } },
});

describe('project folder walk', () => {
  it('lists footage only, sorted, with size and mtime', async () => {
    const f = folderFromHandle(fakeDir('我的短片', project()), true);
    expect(await f.list()).toEqual([
      { rel_path: 'A-roll/A001C003.mov', size: 4, mtime_ms: 1_700_000_000_000 },
      { rel_path: 'A-roll/deep/A002.MP4', size: 2, mtime_ms: 1_700_000_000_000 },
      { rel_path: 'B-roll/B002C001.mov', size: 6, mtime_ms: 1_700_000_000_000 },
    ]);
    expect(await (await f.file('B-roll/B002C001.mov'))!.text()).toBe('cccccc');
    expect(await f.file('B-roll/missing.mov')).toBeNull();
  });

  it('records live in .storyscript-mov/ and are written only when writable', async () => {
    const tree = project();
    const rw = folderFromHandle(fakeDir('p', tree), true);
    expect(await rw.readRecord(LINK_FILE)).toBeNull();
    await rw.writeRecord(LINK_FILE, '{"x":1}');
    expect(await rw.readRecord(LINK_FILE)).toBe('{"x":1}');
    const ro = folderFromHandle(fakeDir('p', tree), false);
    await expect(ro.writeRecord(LINK_FILE, '{}')).rejects.toThrow(/只读/);
  });

  it('a webkitdirectory file list opens read-only and still reads existing records', async () => {
    const file = (path: string, bytes = 'x') => {
      const f = new File([bytes], path.split('/').pop()!, { lastModified: 5 });
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const link = newLink('https://s.test', '00000000-0000-4000-8000-000000000001', { id: '00000000-0000-4000-8000-000000000002', label: '我的短片' } as SourceRoot, new Date(0));
    const f = folderFromFiles([
      file('我的短片/A-roll/A001.mov', 'aaa'),
      file('我的短片/A-roll/.DS_Store'),
      file('我的短片/readme.md'),
      file('我的短片/.storyscript-mov/link.json', JSON.stringify(link)),
    ]);
    expect(f.name).toBe('我的短片');
    expect(f.writable).toBe(false);
    expect(await f.list()).toEqual([{ rel_path: 'A-roll/A001.mov', size: 3, mtime_ms: 5 }]);
    expect(await readLink(f)).toEqual(link);
  });
});

describe('folder records', () => {
  const site = 'https://story.example.test';
  const pid = '00000000-0000-4000-8000-0000000000aa';
  const root = { id: '00000000-0000-4000-8000-0000000000bb', kind: 'browser', abs_path: 'browser:x', label: 'L', created_at: '2026-09-27T00:00:00.000Z' } as SourceRoot;
  const link = newLink(site, pid, root, new Date(0));

  it('decides what opening a folder needs', () => {
    expect(linkSituation(null, site, pid, [root]).kind).toBe('new');
    expect(linkSituation(link, site, pid, [root]).kind).toBe('linked');
    expect(linkSituation(link, 'https://other.test', pid, [root]).kind).toBe('other');
    expect(linkSituation(link, site, '00000000-0000-4000-8000-0000000000cc', [root]).kind).toBe('other');
    expect(linkSituation(link, site, pid, []).kind).toBe('stale');
    expect(linkSituation(link, site, pid, [{ ...root, kind: 'fs' }]).kind).toBe('stale');
  });

  it('an unreadable index is an empty one; cached entries match size and mtime exactly', async () => {
    const f = folderFromHandle(fakeDir('p', { '.storyscript-mov': { [INDEX_FILE]: { bytes: '{not json' } } }), true);
    expect(await readIndex(f)).toEqual(emptyIndex());
    const idx = emptyIndex();
    idx.files['a.mov'] = { size: 1, mtime_ms: 2, probe: null, probe_failed: true, sha256: null };
    expect(cachedEntry(idx, { rel_path: 'a.mov', size: 1, mtime_ms: 2 })).not.toBeNull();
    expect(cachedEntry(idx, { rel_path: 'a.mov', size: 1, mtime_ms: 3 })).toBeNull();
  });
});

// ---- sync with a fake server and fake browser I/O ----
const PROBE: ProbeNormalized = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration_s: 1,
  timecode: null,
  creation_time: null,
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 320, height: 180, time_base_num: 1, time_base_den: 12800, start_pts: 0, duration_ts: 12800, r_frame_rate: '25/1', avg_frame_rate: '25/1', bits_per_raw_sample: 8 },
  ],
};

function fakeServer() {
  const assets = new Map<string, { id: string; rel: string; size: number; mtime: number; probe: boolean; poster: boolean; hash: boolean }>();
  let n = 0;
  const calls = { probe: 0, poster: 0, hash: 0, facts: [] as AssetFactsInput[] };
  const deps: IngestDeps = {
    async reportFiles(_root, files: LocalFile[]): Promise<BrowserFilesOutput> {
      let added = 0;
      for (const f of files) {
        const a = assets.get(f.rel_path);
        if (!a) {
          assets.set(f.rel_path, { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, rel: f.rel_path, size: f.size, mtime: f.mtime_ms, probe: true, poster: true, hash: true });
          added++;
        } else if (a.size !== f.size || a.mtime !== f.mtime_ms) Object.assign(a, { size: f.size, mtime: f.mtime_ms, probe: true, poster: true, hash: true });
      }
      return {
        added,
        changed: 0,
        offline: 0,
        assets: files.map((f) => {
          const a = assets.get(f.rel_path)!;
          return { asset_id: a.id, rel_path: a.rel, size: a.size, mtime_ms: a.mtime, probe: a.probe, poster: a.poster, hash: a.hash };
        }),
      };
    },
    async reportFacts(id, facts) {
      calls.facts.push(facts);
      const a = [...assets.values()].find((x) => x.id === id)!;
      if (facts.probe !== undefined) a.probe = false;
      if (facts.sha256 || facts.hash_problem) a.hash = false;
      const video = facts.probe ? 0 : null;
      return { id, kind: facts.probe === null ? 'other' : 'video', video_stream_index: video, probe: facts.probe ?? null } as unknown as MediaAssetView;
    },
    async uploadPoster(id) {
      [...assets.values()].find((x) => x.id === id)!.poster = false;
    },
    async probe(_file, rel) {
      calls.probe++;
      return rel.endsWith('.mxf') ? null : PROBE;
    },
    async poster() {
      calls.poster++;
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    },
    async hash() {
      calls.hash++;
      return { sha256: 'f'.repeat(64) };
    },
  };
  return { deps, calls, assets };
}

describe('folder sync', () => {
  const tree = (): Tree => ({ 'A-roll': { 'A001.mov': { bytes: 'aaaa' }, 'B.mxf': { bytes: 'mxf' } } });

  it('first open: report, probe, poster (videos only), hash; the index is saved in the folder', async () => {
    const t = tree();
    const folder: LocalFolder = folderFromHandle(fakeDir('p', t), true);
    const s = fakeServer();
    const phases: string[] = [];
    const { index, summary } = await syncFolder({ folder, rootId: 'r', index: emptyIndex(), deps: s.deps, onProgress: (p) => phases.push(p.phase) });
    expect(summary).toMatchObject({ files: 2, added: 2, probed: 2, unreadable: 1, posters: 1, hashed: 2, from_cache: 0 });
    expect(s.calls).toMatchObject({ probe: 2, poster: 1, hash: 2 });
    expect([...new Set(phases)]).toEqual(['listing', 'probing', 'posters', 'hashing', 'done']);
    expect(index.files['A-roll/B.mxf']).toMatchObject({ probe: null, probe_failed: true, sha256: 'f'.repeat(64) });
    const saved = await readIndex(folder);
    expect(saved.files['A-roll/A001.mov']).toMatchObject({ size: 4, probe: PROBE, sha256: 'f'.repeat(64) });
  });

  it('a teammate with a copy of the folder (fresh server state) reuses the saved index: no probing or hashing', async () => {
    const t = tree();
    const folder = folderFromHandle(fakeDir('p', t), true);
    await syncFolder({ folder, rootId: 'r', index: emptyIndex(), deps: fakeServer().deps });
    const copy = fakeServer();
    const { summary } = await syncFolder({ folder, rootId: 'r', index: await readIndex(folder), deps: copy.deps });
    expect(copy.calls).toMatchObject({ probe: 0, hash: 0 });
    expect(summary.from_cache).toBe(4);
    // facts still reach the new server: probe (incl. the unreadable null) and hashes
    expect(copy.calls.facts.filter((f) => 'probe' in f)).toHaveLength(2);
    expect(copy.calls.facts.filter((f) => f.sha256)).toHaveLength(2);
    // posters are grabbed again (they live on the server, not in the folder)
    expect(copy.calls.poster).toBe(1);
  });

  it('a changed file is probed and hashed again; a vanished one leaves the index', async () => {
    const t = tree();
    const folder = folderFromHandle(fakeDir('p', t), true);
    const s = fakeServer();
    await syncFolder({ folder, rootId: 'r', index: emptyIndex(), deps: s.deps });
    const roll = t['A-roll'] as Tree;
    roll['A001.mov'] = { bytes: 'aaaaaa', mtime: 1_800_000_000_000 };
    delete roll['B.mxf'];
    const before = { ...s.calls };
    const { index } = await syncFolder({ folder, rootId: 'r', index: await readIndex(folder), deps: s.deps });
    expect(s.calls.probe - before.probe).toBe(1);
    expect(s.calls.hash - before.hash).toBe(1);
    expect(Object.keys(index.files)).toEqual(['A-roll/A001.mov']);
  });

  it('a read-only folder syncs without writing records', async () => {
    const t = tree();
    const folder = folderFromHandle(fakeDir('p', t), false);
    await syncFolder({ folder, rootId: 'r', index: emptyIndex(), deps: fakeServer().deps });
    expect('.storyscript-mov' in t).toBe(false);
  });

  it('stops when aborted', async () => {
    const folder = folderFromHandle(fakeDir('p', tree()), true);
    const ac = new AbortController();
    ac.abort();
    await expect(syncFolder({ folder, rootId: 'r', index: emptyIndex(), deps: fakeServer().deps, signal: ac.signal })).rejects.toThrow(/Abort/);
  });
});

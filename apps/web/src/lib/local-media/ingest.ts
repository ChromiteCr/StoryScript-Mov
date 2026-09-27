import type { AssetFactsInput, BrowserFilesOutput, MediaAssetView, MediaIndex, ProbeNormalized } from '@storyscript/contracts';
import { posterSeconds } from '@storyscript/core';
import type { LocalFile, LocalFolder } from './folder.ts';
import { cachedEntry, writeIndex } from './records.ts';

/**
 * Sync an opened project folder with the team's project (hosted server):
 *   1. list the folder and report the complete listing (new / changed / gone)
 *   2. probe each file the server has no facts for (cached in the folder's
 *      media-index.json when size + mtime are unchanged)
 *   3. grab and upload a poster frame for each video without one
 *   4. hash in the background, last (the library is usable before that)
 * Every step talks to the outside world through `IngestDeps`, so this is
 * tested in node with fakes.
 */

export type HashResult = { sha256: string } | { problem: 'source_changed' | 'failed' };

export interface IngestDeps {
  reportFiles(rootId: string, files: LocalFile[]): Promise<BrowserFilesOutput>;
  reportFacts(assetId: string, facts: AssetFactsInput): Promise<MediaAssetView>;
  uploadPoster(assetId: string, jpeg: Blob): Promise<void>;
  probe(file: File, relPath: string): Promise<ProbeNormalized | null>;
  poster(file: File, atSeconds: number): Promise<Blob | null>;
  hash(file: File, signal?: AbortSignal): Promise<HashResult>;
}

export type IngestPhase = 'listing' | 'probing' | 'posters' | 'hashing' | 'done';

export interface IngestProgress {
  phase: IngestPhase;
  done: number;
  total: number;
  current: string | null;
}

export interface IngestSummary {
  files: number;
  added: number;
  changed: number;
  offline: number;
  probed: number;
  unreadable: number;
  posters: number;
  hashed: number;
  from_cache: number;
}

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
};

export async function syncFolder(opts: {
  folder: LocalFolder;
  rootId: string;
  index: MediaIndex;
  deps: IngestDeps;
  onProgress?: (p: IngestProgress) => void;
  signal?: AbortSignal;
  /** save the index every N hashed files (and at every phase end) */
  saveEvery?: number;
}): Promise<{ index: MediaIndex; summary: IngestSummary }> {
  const { folder, rootId, deps, signal } = opts;
  const index: MediaIndex = { ...opts.index, files: { ...opts.index.files } };
  const progress = (phase: IngestPhase, done: number, total: number, current: string | null = null) =>
    opts.onProgress?.({ phase, done, total, current });
  const save = () => writeIndex(folder, index).catch(() => undefined);
  const summary: IngestSummary = { files: 0, added: 0, changed: 0, offline: 0, probed: 0, unreadable: 0, posters: 0, hashed: 0, from_cache: 0 };

  // 1. listing
  progress('listing', 0, 0);
  const files = await folder.list(signal);
  aborted(signal);
  const listed = await deps.reportFiles(rootId, files);
  Object.assign(summary, { files: files.length, added: listed.added, changed: listed.changed, offline: listed.offline });
  const byRel = new Map(files.map((f) => [f.rel_path, f] as const));
  // forget index entries of files that are gone
  for (const rel of Object.keys(index.files)) if (!byRel.has(rel)) delete index.files[rel];

  const entryFor = (f: LocalFile) => {
    const cached = cachedEntry(index, f);
    if (cached) return cached;
    const fresh = { size: f.size, mtime_ms: f.mtime_ms, probe: null, probe_failed: false, sha256: null };
    index.files[f.rel_path] = fresh;
    return fresh;
  };

  // 2. probe
  const views = new Map<string, MediaAssetView>();
  const toProbe = listed.assets.filter((a) => a.probe);
  for (const [i, a] of toProbe.entries()) {
    aborted(signal);
    progress('probing', i, toProbe.length, a.rel_path);
    const f = byRel.get(a.rel_path);
    if (!f) continue;
    const e = entryFor(f);
    let probe = e.probe;
    if (probe === null && !e.probe_failed) {
      const file = await folder.file(a.rel_path);
      probe = file ? await deps.probe(file, a.rel_path).catch(() => null) : null;
      e.probe = probe;
      e.probe_failed = probe === null;
      summary.probed++;
    } else summary.from_cache++;
    if (probe === null) summary.unreadable++;
    views.set(a.asset_id, await deps.reportFacts(a.asset_id, { size: f.size, mtime_ms: f.mtime_ms, probe }));
  }
  await save();

  // 3. posters (videos the server has no poster for, and that have a video stream)
  const toPoster = listed.assets.filter((a) => {
    if (!a.poster) return false;
    const v = views.get(a.asset_id);
    return v ? v.kind === 'video' && v.video_stream_index !== null : true;
  });
  for (const [i, a] of toPoster.entries()) {
    aborted(signal);
    progress('posters', i, toPoster.length, a.rel_path);
    const file = await folder.file(a.rel_path);
    if (!file) continue;
    const probe = views.get(a.asset_id)?.probe ?? cachedEntry(index, byRel.get(a.rel_path)!)?.probe ?? null;
    const jpeg = await deps.poster(file, posterSeconds({ kind: 'video', probe })).catch(() => null);
    if (!jpeg) continue;
    await deps.uploadPoster(a.asset_id, jpeg);
    summary.posters++;
  }

  // 4. hashes, last
  const toHash = listed.assets.filter((a) => a.hash);
  const saveEvery = opts.saveEvery ?? 5;
  for (const [i, a] of toHash.entries()) {
    aborted(signal);
    progress('hashing', i, toHash.length, a.rel_path);
    const f = byRel.get(a.rel_path);
    if (!f) continue;
    const e = entryFor(f);
    let result: HashResult;
    if (e.sha256) {
      result = { sha256: e.sha256 };
      summary.from_cache++;
    } else {
      const file = await folder.file(a.rel_path);
      result = file ? await deps.hash(file, signal) : { problem: 'source_changed' };
      if ('sha256' in result) e.sha256 = result.sha256;
      summary.hashed++;
    }
    await deps.reportFacts(a.asset_id, 'sha256' in result ? { size: f.size, mtime_ms: f.mtime_ms, sha256: result.sha256 } : { size: f.size, mtime_ms: f.mtime_ms, hash_problem: result.problem });
    if ((i + 1) % saveEvery === 0) await save();
  }
  await save();
  progress('done', files.length, files.length);
  return { index, summary };
}

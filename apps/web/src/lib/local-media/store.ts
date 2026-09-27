import { useSyncExternalStore } from 'react';
import type { FolderLink, MediaAssetView, SourceRoot } from '@storyscript/contracts';
import { browserIngestDeps } from './browser-deps.ts';
import type { LocalFolder } from './folder.ts';
import { syncFolder, type IngestDeps, type IngestProgress, type IngestSummary } from './ingest.ts';
import { rememberFolder } from './recent.ts';
import { linkSituation, newLink, readIndex, readLink, writeLink, type LinkSituation } from './records.ts';

/**
 * The project folder open in this tab (hosted server): one at a time, like a
 * VS Code window. Module state + useSyncExternalStore; React components only
 * render it and pass user decisions in.
 */

export interface LocalFolderState {
  folder: LocalFolder | null;
  link: FolderLink | null;
  progress: IngestProgress | null;
  summary: IngestSummary | null;
  error: unknown;
  syncing: boolean;
}

const EMPTY: LocalFolderState = { folder: null, link: null, progress: null, summary: null, error: null, syncing: false };
let state: LocalFolderState = EMPTY;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let onChanged: () => void = () => undefined;

function set(patch: Partial<LocalFolderState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useLocalFolder(): LocalFolderState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Called after each sync step that changed server data (the page refetches). */
export function setLocalFolderChanged(fn: () => void): void {
  onChanged = fn;
}

export interface OpenContext {
  site: string;
  projectId: string;
  roots: readonly SourceRoot[];
  createRoot(label: string): Promise<SourceRoot>;
  /** the user's answer for a folder that is new, stale or linked elsewhere */
  confirm(situation: Exclude<LinkSituation, { kind: 'linked' }>, folder: LocalFolder): Promise<boolean>;
}

/** Open a project folder: resolve its link (asking when needed), then sync. */
export async function openLocalFolder(folder: LocalFolder, ctx: OpenContext, deps: IngestDeps = browserIngestDeps): Promise<boolean> {
  closeLocalFolder();
  const situation = linkSituation(await readLink(folder), ctx.site, ctx.projectId, ctx.roots);
  let link: FolderLink;
  if (situation.kind === 'linked') link = situation.link;
  else {
    if (!(await ctx.confirm(situation, folder))) return false;
    const root = await ctx.createRoot(folder.name);
    link = newLink(ctx.site, ctx.projectId, root);
    await writeLink(folder, link);
  }
  if (folder.handle) await rememberFolder(ctx.projectId, folder.handle);
  set({ ...EMPTY, folder, link });
  onChanged();
  await syncLocalFolder(deps);
  return true;
}

export async function syncLocalFolder(deps: IngestDeps = browserIngestDeps): Promise<void> {
  const { folder, link } = state;
  if (!folder || !link) return;
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  set({ syncing: true, error: null, summary: null });
  try {
    const index = await readIndex(folder);
    let lastPhase: string | null = null;
    const { summary } = await syncFolder({
      folder,
      rootId: link.root_id,
      index,
      deps,
      signal: mine.signal,
      onProgress: (p) => {
        if (controller !== mine) return;
        set({ progress: p });
        // refresh the library as each phase lands (listing → probes → posters → hashes)
        if (p.phase !== lastPhase) {
          lastPhase = p.phase;
          onChanged();
        }
      },
    });
    if (controller === mine) set({ summary, syncing: false, progress: null });
  } catch (err) {
    if (controller === mine) set({ error: err instanceof DOMException && err.name === 'AbortError' ? null : err, syncing: false, progress: null });
  } finally {
    if (controller === mine) {
      controller = null;
      onChanged();
    }
  }
}

export function closeLocalFolder(): void {
  controller?.abort();
  controller = null;
  set(EMPTY);
}

/** The local file behind an asset, when its project folder is the one open in this tab. */
export async function localFileFor(asset: Pick<MediaAssetView, 'source_root_id' | 'rel_path' | 'size' | 'mtime_ms'>): Promise<File | null> {
  const { folder, link } = state;
  if (!folder || !link || link.root_id !== asset.source_root_id) return null;
  const file = await folder.file(asset.rel_path);
  return file && file.size === asset.size ? file : null;
}

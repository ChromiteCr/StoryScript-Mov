import { FolderLink, MediaIndex, type MediaIndexEntry, type SourceRoot } from '@storyscript/contracts';
import type { LocalFile, LocalFolder } from './folder.ts';

/**
 * The records a project folder keeps about itself (.storyscript-mov/):
 * link.json says which site and project its footage belongs to;
 * media-index.json remembers what was learned about each file version, so a
 * reopen — or a teammate's copy of the folder — skips unchanged files.
 */

export const LINK_FILE = 'link.json';
export const INDEX_FILE = 'media-index.json';

export function emptyIndex(): MediaIndex {
  return { format: 'storyscript-mov-media-index', version: 1, files: {} };
}

function parse<T>(text: string | null, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
  if (text === null) return null;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function readLink(folder: LocalFolder): Promise<FolderLink | null> {
  return parse(await folder.readRecord(LINK_FILE), FolderLink);
}

export async function readIndex(folder: LocalFolder): Promise<MediaIndex> {
  return parse(await folder.readRecord(INDEX_FILE), MediaIndex) ?? emptyIndex();
}

export async function writeIndex(folder: LocalFolder, index: MediaIndex): Promise<void> {
  if (folder.writable) await folder.writeRecord(INDEX_FILE, `${JSON.stringify(index, null, 1)}\n`);
}

/** The cached entry for exactly this version of the file, or null. */
export function cachedEntry(index: MediaIndex, f: LocalFile): MediaIndexEntry | null {
  const e = index.files[f.rel_path];
  return e && e.size === f.size && e.mtime_ms === f.mtime_ms ? e : null;
}

/** Why a folder needs confirming before it is used for this project. */
export type LinkSituation =
  /** linked to this site and project, and the server still has its root */
  | { kind: 'linked'; link: FolderLink }
  /** never opened for a project (or its link is unreadable) */
  | { kind: 'new' }
  /** linked to another site or project */
  | { kind: 'other'; link: FolderLink }
  /** linked here, but the server no longer has that root */
  | { kind: 'stale'; link: FolderLink };

export function linkSituation(link: FolderLink | null, site: string, projectId: string, roots: readonly SourceRoot[]): LinkSituation {
  if (!link) return { kind: 'new' };
  if (link.site !== site || link.project_id !== projectId) return { kind: 'other', link };
  const root = roots.find((r) => r.id === link.root_id);
  return root && root.kind === 'browser' ? { kind: 'linked', link } : { kind: 'stale', link };
}

export function newLink(site: string, projectId: string, root: SourceRoot, now = new Date()): FolderLink {
  return { format: 'storyscript-mov-folder', version: 1, site, project_id: projectId, root_id: root.id, label: root.label, created_at: now.toISOString() };
}

export async function writeLink(folder: LocalFolder, link: FolderLink): Promise<void> {
  if (folder.writable) await folder.writeRecord(LINK_FILE, `${JSON.stringify(link, null, 2)}\n`);
}

import type { FsDirHandle } from './folder.ts';

/**
 * Recently opened project folders, per project (Chrome/Edge keep directory
 * handles in IndexedDB; reopening asks for permission again). Everything here
 * is a convenience: any IndexedDB failure means an empty list.
 */

export interface RecentFolder {
  key: string;
  project_id: string;
  name: string;
  handle: FsDirHandle;
  opened_at: string;
}

const DB_NAME = 'storyscript-mov';
const STORE = 'recent-folders';
const MAX_RECENT = 8;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export async function listRecentFolders(projectId: string): Promise<RecentFolder[]> {
  try {
    const all = (await withStore('readonly', (s) => s.getAll())) as RecentFolder[];
    return all
      .filter((r) => r.project_id === projectId)
      .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export async function rememberFolder(projectId: string, handle: FsDirHandle, now = new Date()): Promise<void> {
  try {
    const entry: RecentFolder = { key: `${projectId}:${handle.name}`, project_id: projectId, name: handle.name, handle, opened_at: now.toISOString() };
    await withStore('readwrite', (s) => s.put(entry));
  } catch {
    // no recent list in this browser
  }
}

export async function forgetFolder(key: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(key));
  } catch {
    // nothing to forget
  }
}

/** Ask (from a click) for read-write access again; false when refused. */
export async function regainAccess(handle: FsDirHandle): Promise<boolean> {
  const mode = { mode: 'readwrite' as const };
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission(mode)) === 'granted') return true;
  return (await handle.requestPermission(mode)) === 'granted';
}

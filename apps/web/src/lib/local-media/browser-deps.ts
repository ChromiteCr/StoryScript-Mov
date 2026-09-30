import type { ProbeNormalized } from '@storyscript/contracts';
import { probeIsoFile } from '@storyscript/core';
import { api, tabHeaders } from '../api.ts';
import type { LocalFile } from './folder.ts';
import { extOf } from './folder.ts';
import type { HashReply } from './hash.worker.ts';
import type { HashResult, IngestDeps } from './ingest.ts';
import { grabPoster } from './poster.ts';

/** The real browser implementations behind IngestDeps (ingest.ts is tested with fakes). */

const ISO_EXTS = new Set(['mp4', 'mov', 'm4v']);

/** MP4/MOV header facts read in the browser (other containers: null). */
export async function probeLocalFile(file: File, relPath: string): Promise<ProbeNormalized | null> {
  if (!ISO_EXTS.has(extOf(relPath))) return null;
  const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const r = await probeIsoFile(read, file.size);
  return r.ok ? r.probe : null;
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (r: HashResult) => void>();

function hashWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<HashReply>) => {
      const m = e.data;
      if ('progress' in m) return;
      const resolve = waiting.get(m.id);
      waiting.delete(m.id);
      resolve?.('sha256' in m ? { sha256: m.sha256 } : { problem: m.problem });
    };
  }
  return worker;
}

export function hashLocalFile(file: File, signal?: AbortSignal): Promise<HashResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const id = nextId++;
    waiting.set(id, resolve);
    signal?.addEventListener('abort', () => {
      if (!waiting.delete(id)) return;
      // a hash in flight cannot be interrupted: start a fresh worker for the next one
      worker?.terminate();
      worker = null;
      for (const [, r] of waiting) r({ problem: 'failed' });
      waiting.clear();
      reject(new DOMException('Aborted', 'AbortError'));
    });
    hashWorker().postMessage({ id, file });
  });
}

async function uploadPoster(assetId: string, jpeg: Blob): Promise<void> {
  const res = await fetch(`/api/v1/media/assets/${encodeURIComponent(assetId)}/poster`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'image/jpeg', Accept: 'application/json', ...tabHeaders() },
    body: jpeg,
  });
  if (!res.ok) throw new Error(`海报上传失败（HTTP ${res.status}）`);
}

export const browserIngestDeps: IngestDeps = {
  reportFiles: (rootId, files: LocalFile[]) => api.call('reportBrowserFiles', { files }, { params: { id: rootId } }),
  reportFacts: (assetId, facts) => api.call('reportAssetFacts', facts, { params: { id: assetId } }),
  uploadPoster,
  probe: probeLocalFile,
  poster: (file, at) => grabPoster(file, at),
  hash: hashLocalFile,
};

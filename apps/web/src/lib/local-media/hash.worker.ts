/// <reference lib="webworker" />
import { createSha256 } from '@storyscript/core';

/**
 * SHA-256 of a local file off the main thread, streamed in chunks. A File is a
 * snapshot: if the file changes on disk while it is read, the browser throws
 * NotReadableError, reported as source_changed.
 */

export type HashRequest = { id: number; file: File };
export type HashReply = { id: number; sha256: string } | { id: number; problem: 'source_changed' | 'failed' } | { id: number; progress: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<HashRequest>) => {
  const { id, file } = e.data;
  try {
    const h = createSha256();
    const reader = file.stream().getReader();
    let read = 0;
    let lastReport = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      h.update(value);
      read += value.length;
      if (read - lastReport > 32 * 1024 * 1024) {
        lastReport = read;
        scope.postMessage({ id, progress: file.size ? read / file.size : 1 } satisfies HashReply);
      }
    }
    scope.postMessage({ id, sha256: h.digest() } satisfies HashReply);
  } catch (err) {
    const changed = err instanceof DOMException && err.name === 'NotReadableError';
    scope.postMessage({ id, problem: changed ? 'source_changed' : 'failed' } satisfies HashReply);
  }
};

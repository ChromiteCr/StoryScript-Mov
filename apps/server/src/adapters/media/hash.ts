import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/**
 * Streaming SHA-256 of an original clip (read-only). size/mtime are compared
 * before and after the read; any change (growing file, re-copy, edit) yields
 * `source_changed` instead of a hash that describes no stable content.
 */

export const HASH_CHUNK_BYTES = 1024 * 1024;

export type HashResult =
  | { status: 'done'; sha256: string; size: number; mtimeMs: number }
  | { status: 'source_changed' };

export interface HashOptions {
  signal?: AbortSignal;
  /** size/mtime recorded at scan time; a mismatch before reading is also `source_changed` */
  expect?: { size: number; mtimeMs: number };
}

export async function hashFile(absPath: string, opts: HashOptions = {}): Promise<HashResult> {
  const before = await stat(absPath);
  if (!before.isFile()) throw new Error(`not a regular file: ${absPath}`);
  if (opts.expect && (opts.expect.size !== before.size || opts.expect.mtimeMs !== before.mtimeMs)) {
    return { status: 'source_changed' };
  }

  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    createReadStream(absPath, { highWaterMark: HASH_CHUNK_BYTES }),
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    },
    { signal: opts.signal },
  );

  const after = await stat(absPath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes !== before.size) {
    return { status: 'source_changed' };
  }
  return { status: 'done', sha256: hash.digest('hex'), size: before.size, mtimeMs: before.mtimeMs };
}

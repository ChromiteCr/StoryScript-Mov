import type { ShotFields } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';

/**
 * S3: `camera_notes` is optional; an empty note is the same as none, so it is
 * dropped (and a note is trimmed). Shots written before S3 therefore keep
 * their content hash.
 */
export function cleanShotFields<T extends Pick<ShotFields, 'camera_notes'>>(fields: T): T {
  const { camera_notes, ...rest } = fields;
  const notes = typeof camera_notes === 'string' ? camera_notes.trim() : '';
  return (notes ? { ...rest, camera_notes: notes } : rest) as T;
}

/** Shot.content_hash: hash of `fields` only (code / narrative_pos excluded). */
export function shotContentHash(fields: ShotFields): string {
  return contentHash(cleanShotFields(fields));
}

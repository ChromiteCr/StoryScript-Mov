import type { ShotFields, ShotSubject } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';

/**
 * S3: `camera_notes` is optional; an empty note is the same as none, so it is
 * dropped (and a note is trimmed). S5b: so is an empty `object_name`, and a
 * subject's `emotion` left to the action text (null). Shots written before
 * S3 / S5b therefore keep their content hash.
 */
export function cleanShotFields<T extends Pick<ShotFields, 'camera_notes'> & { object_name?: string | null; subjects?: readonly ShotSubject[] }>(fields: T): T {
  const { camera_notes, object_name, ...rest } = fields;
  const notes = typeof camera_notes === 'string' ? camera_notes.trim() : '';
  const name = typeof object_name === 'string' ? object_name.trim() : '';
  const out = { ...rest, ...(notes ? { camera_notes: notes } : {}), ...(name ? { object_name: name } : {}) } as unknown as T;
  if (Array.isArray(fields.subjects) && fields.subjects.some((s) => s.emotion === null || (s.emotion === undefined && 'emotion' in s))) {
    return { ...out, subjects: fields.subjects.map(cleanSubject) };
  }
  return out;
}

function cleanSubject(s: ShotSubject): ShotSubject {
  if (s.emotion !== null && s.emotion !== undefined) return s;
  const { emotion: _e, ...rest } = s;
  return rest;
}

/** Shot.content_hash: hash of `fields` only (code / narrative_pos excluded). */
export function shotContentHash(fields: ShotFields): string {
  return contentHash(cleanShotFields(fields));
}

import type { ShotFields } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';

/** Shot.content_hash: hash of `fields` only (code / narrative_pos excluded). */
export function shotContentHash(fields: ShotFields): string {
  return contentHash(fields);
}

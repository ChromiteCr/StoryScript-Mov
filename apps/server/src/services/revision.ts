import { AppError } from '../http/errors.ts';

/**
 * S4a: an update that names the revision it started from is refused when a
 * teammate has changed the row since (409 REVISION_CONFLICT), instead of
 * silently overwriting their change. Updates that name none keep the old
 * last-write-wins behaviour (older clients, internal writes).
 */
export function assertExpectedRevision(what: string, current: number | undefined, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = current ?? 0;
  if (now !== expected) {
    throw new AppError('REVISION_CONFLICT', `${what}刚被组员改过，请刷新后再改`, 409, { expected_revision: expected, current_revision: now });
  }
}

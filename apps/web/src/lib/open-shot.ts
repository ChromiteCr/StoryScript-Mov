/**
 * Ask the script page to open a shot (S4b: the 提到我的 bell, and the badge on
 * a shot row). The bell lives in the title bar, the script workspace may not
 * be mounted yet (another page, a lazy chunk still loading), so a request is
 * kept until the workspace picks it up, and dropped if nobody does within
 * `OPEN_SHOT_TTL_MS` — a stale request must never open a shot later.
 *
 * A window CustomEvent 'ssm-open-shot' ({ shotId, comments, commentId })
 * tells a mounted workspace to look; the pending request is the source of
 * truth. Once the shot is open, `comments` asks the comments section to
 * scroll into view (and to the one comment, when given).
 */

export const OPEN_SHOT_EVENT = 'ssm-open-shot';
export const OPEN_SHOT_TTL_MS = 15_000;

export interface OpenShotRequest {
  shotId: string;
  /** bring the shot's comments into view once it is open */
  comments: boolean;
  /** the comment to scroll to */
  commentId: string | null;
}

interface Stamped<T> {
  value: T;
  at: number;
}

let pending: Stamped<OpenShotRequest> | null = null;
let focus: Stamped<{ shotId: string; commentId: string | null }> | null = null;
const focusListeners = new Set<() => void>();

const fresh = <T>(s: Stamped<T> | null, now: number): T | null => (s && now - s.at <= OPEN_SHOT_TTL_MS ? s.value : null);

/** Ask for a shot to be opened. Notifies a mounted workspace; otherwise waits for the next one. */
export function requestOpenShot(req: { shotId: string; comments?: boolean; commentId?: string | null }, now: number = Date.now()): void {
  const value: OpenShotRequest = { shotId: req.shotId, comments: req.comments ?? false, commentId: req.commentId ?? null };
  pending = { value, at: now };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_SHOT_EVENT, { detail: value }));
}

/** The waiting request, if it is still fresh (stays until taken). */
export function peekOpenShot(now: number = Date.now()): OpenShotRequest | null {
  return fresh(pending, now);
}

/** Take the waiting request: the caller opens the shot. Null when there is none or it has expired. */
export function takeOpenShot(now: number = Date.now()): OpenShotRequest | null {
  const req = fresh(pending, now);
  pending = null;
  return req;
}

// ---------------------------------------------------------- comments focus

/** Set once a shot is open: its comments section should scroll into view. */
export function setCommentsFocus(f: { shotId: string; commentId?: string | null }, now: number = Date.now()): void {
  focus = { value: { shotId: f.shotId, commentId: f.commentId ?? null }, at: now };
  for (const l of [...focusListeners]) l();
}

export function commentsFocusFor(shotId: string, now: number = Date.now()): { shotId: string; commentId: string | null } | null {
  const f = fresh(focus, now);
  return f && f.shotId === shotId ? f : null;
}

/** The section that scrolled calls this so it does not scroll again on the next render. */
export function clearCommentsFocus(): void {
  focus = null;
  for (const l of [...focusListeners]) l();
}

export function subscribeCommentsFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

/** A stable snapshot for useSyncExternalStore: the focus object itself (or null), so it only changes when set or cleared. */
export function commentsFocusSnapshot(): { shotId: string; commentId: string | null } | null {
  return focus ? focus.value : null;
}

/** Test helper: forget everything. */
export function resetOpenShot(): void {
  pending = null;
  focus = null;
  focusListeners.clear();
}

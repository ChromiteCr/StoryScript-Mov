import { useEffect, useState } from 'react';
import { useShots } from '../../lib/queries.ts';
import { OPEN_SHOT_EVENT, peekOpenShot, setCommentsFocus, takeOpenShot } from '../../lib/open-shot.ts';
import { useWorkspace } from './context.ts';

/**
 * Open the shot somebody asked for (S4b: the 提到我的 bell, a row's comment
 * badge). A request is waiting when this mounts (the bell navigated here
 * first) or arrives as the window event 'ssm-open-shot'. It waits for the
 * shot list, since the request may come before the shots have loaded, and
 * expires by itself (lib/open-shot.ts) so a stale one never opens a shot later.
 */
export function useOpenShotRequests(): void {
  const ws = useWorkspace();
  const shots = useShots();
  const [tick, setTick] = useState(0);
  const list = shots.data;
  const { selectShot } = ws;

  useEffect(() => {
    const onRequest = () => setTick((n) => n + 1);
    window.addEventListener(OPEN_SHOT_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_SHOT_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (!list) return;
    const req = peekOpenShot();
    if (!req) return;
    const shot = list.find((s) => s.id === req.shotId && !s.archived);
    if (!shot) return; // not in the list (yet): it may still arrive before the request expires
    takeOpenShot();
    if (req.comments) setCommentsFocus({ shotId: shot.id, commentId: req.commentId });
    selectShot(shot, { reveal: true });
  }, [tick, list, selectShot]);
}

/**
 * Renders nothing; mount it once inside the script workspace's context so a
 * request is answered whatever is showing (the inspector body only exists
 * while a shot is open, or on a narrow screen while the drawer is).
 */
export function OpenShotBridge() {
  useOpenShotRequests();
  return null;
}

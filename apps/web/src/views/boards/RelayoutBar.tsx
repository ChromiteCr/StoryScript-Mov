import type { BoardView } from '@storyscript/contracts';
import { LayoutTemplate } from 'lucide-react';
import { relayoutOffer, relayoutResultLine } from '../../lib/relayout.ts';
import { useRelayoutBoards } from '../../lib/queries-boards.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice } from '../../components/ui.tsx';

/**
 * S4c "用新画法重排": boards laid out by an older renderer have none of the new
 * sets and compositions (the figures themselves need no relayout: they are
 * drawn at render time). The notice offers one button for the shown shot's
 * scene and one for every scene (relayoutOffer), counts only what the server
 * would lay out (hand-edited boards, boards wearing an adopted AI picture and
 * boards already on the current renderer are not counted), and after the
 * answer says how many were laid out and how many were left alone. The mutation refetches the list, so the
 * notice disappears once nothing is left; the result line stays until
 * dismissed.
 */
export function RelayoutBar({ boards, sceneId }: { boards: readonly BoardView[]; sceneId: string }) {
  const relayout = useRelayoutBoards();
  const offer = relayoutOffer(boards, sceneId);
  const busy = relayout.isPending;

  const error = relayout.isError ? <ErrorNotice error={relayout.error} /> : null;
  const result = relayout.data ? (
    <Notice tone="info" title={relayoutResultLine(relayout.data)} role="status">
      {relayout.data.relaid > 0 ? <p>新版本已经排好，旧版本留在各分镜的版本历史里。</p> : null}
      <div className="mt-2">
        <Button size="sm" variant="ghost" onClick={() => relayout.reset()}>
          知道了
        </Button>
      </div>
    </Notice>
  ) : null;

  return (
    <>
      {error}
      {result}
      {offer ? (
        <Notice tone="info" title={`有 ${offer.relayable} 个分镜还是旧画法排的版`} role="note">
          <p>新画法会补上门窗、课桌、树这些布景，单人镜头也按视线放在三分线上。重排会给分镜新排一个版本，旧版本留在版本历史里；手改过的和用了 AI 图的分镜不动。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {offer.buttons.map((b) => {
              // the pressed button spins, the other waits (variables is the scene id, null = every scene)
              const pressed = busy && relayout.variables === b.target;
              return (
                <Button key={b.target ?? 'all'} size="sm" busy={pressed} disabled={busy} onClick={() => relayout.mutate(b.target)}>
                  {pressed ? null : <LayoutTemplate aria-hidden className="size-3.5" />}
                  {b.label}
                </Button>
              );
            })}
          </div>
        </Notice>
      ) : null}
    </>
  );
}

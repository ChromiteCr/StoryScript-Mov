import type { BoardView } from '@storyscript/contracts';
import { LayoutTemplate } from 'lucide-react';
import { relayoutCounts, relayoutLabel, relayoutResultLine } from '../../lib/relayout.ts';
import { useRelayoutBoards } from '../../lib/queries-boards.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice } from '../../components/ui.tsx';

/**
 * S4c "用新画法重排": boards laid out by an older renderer have none of the new
 * sets and compositions (the figures themselves need no relayout: they are
 * drawn at render time). The notice offers one button for the shown shot's
 * scene and one for every scene, counts only what the server would lay out
 * (hand-edited boards and boards already on the current renderer are not
 * counted), and after the answer says how many were laid out and how many
 * edited ones were left alone. The mutation refetches the list, so the notice
 * disappears once nothing is left; the result line stays until dismissed.
 */
export function RelayoutBar({ boards, sceneId }: { boards: readonly BoardView[]; sceneId: string }) {
  const relayout = useRelayoutBoards();
  const scene = relayoutCounts(boards, sceneId);
  const all = relayoutCounts(boards, null);
  const run = (target: string | null) => relayout.mutate(target);
  const busy = relayout.isPending;
  // which button was pressed: the other one waits (variables is the scene id, null = all)
  const sceneBusy = busy && relayout.variables === sceneId;

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

  if (all.relayable === 0) {
    return error || result ? (
      <>
        {error}
        {result}
      </>
    ) : null;
  }

  // two buttons only when this scene's share is not already all of it
  const both = scene.relayable > 0 && all.relayable > scene.relayable;
  return (
    <>
      {error}
      {result}
      <Notice tone="info" title={`有 ${all.relayable} 个分镜还是旧画法排的版`} role="note">
        <p>新画法会补上门窗、课桌、树这些布景，单人镜头也按视线放在三分线上。重排会给分镜新排一个版本，旧版本留在版本历史里，手改过的分镜不动。</p>
        {all.withAiPicture > 0 ? <p>其中 {all.withAiPicture} 个已采用 AI 图：重排后当前版本显示铅笔稿，AI 图留在旧版本里。</p> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {both ? (
            <Button size="sm" busy={sceneBusy} disabled={busy} onClick={() => run(sceneId)}>
              {sceneBusy ? null : <LayoutTemplate aria-hidden className="size-3.5" />}
              {relayoutLabel(scene.relayable, 'scene')}
            </Button>
          ) : null}
          <Button size="sm" busy={busy && !sceneBusy} disabled={busy} onClick={() => run(null)}>
            {busy && !sceneBusy ? null : <LayoutTemplate aria-hidden className="size-3.5" />}
            {relayoutLabel(all.relayable, both ? 'all' : 'only')}
          </Button>
        </div>
      </Notice>
    </>
  );
}

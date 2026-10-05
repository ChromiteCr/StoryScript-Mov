import type { BoardView, RelayoutBoardsResult } from '@storyscript/contracts';
import { RENDERER_VERSION } from '@storyscript/core';

/**
 * "用新画法重排" (S4c): which boards the button would lay out again. Pure, so
 * it can be tested with any renderer version. The count is the server's own
 * rule (services/boards relayoutBoards), applied to the list the page already
 * has: the newest board of every live shot is skipped when it was edited by
 * hand or already drawn by the current renderer.
 */

type BoardLike = Pick<BoardView, 'scene_id' | 'renderer_version' | 'user_edited' | 'adopted_raster_id'>;

export interface RelayoutCounts {
  /** would get a new version */
  relayable: number;
  /** of those, how many wear an adopted AI picture (it stays with the old version) */
  withAiPicture: number;
  /** newest board edited by hand: left alone */
  edited: number;
  /** already laid out by the current renderer */
  current: number;
}

/** sceneId null = every scene */
export function relayoutCounts(boards: readonly BoardLike[], sceneId: string | null, version: string = RENDERER_VERSION): RelayoutCounts {
  const out: RelayoutCounts = { relayable: 0, withAiPicture: 0, edited: 0, current: 0 };
  for (const b of boards) {
    if (sceneId !== null && b.scene_id !== sceneId) continue;
    if (b.user_edited) out.edited += 1;
    else if (b.renderer_version === version) out.current += 1;
    else {
      out.relayable += 1;
      if (b.adopted_raster_id) out.withAiPicture += 1;
    }
  }
  return out;
}

/**
 * The button text. `scope` says what the count covers: 'scene' and 'all' when
 * both buttons are shown (so they can be told apart), 'only' when one button
 * covers everything.
 */
export function relayoutLabel(n: number, scope: 'only' | 'scene' | 'all'): string {
  const lead = scope === 'scene' ? '本场 ' : scope === 'all' ? '全部 ' : ' ';
  return `用新画法重排${lead}${n} 个分镜（手改过的不动）`;
}

/** After the server answered: "重排了 5 个，跳过手改的 1 个" */
export function relayoutResultLine(r: RelayoutBoardsResult): string {
  return `重排了 ${r.relaid} 个，跳过手改的 ${r.kept_edited} 个`;
}

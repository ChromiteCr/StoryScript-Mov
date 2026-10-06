import type { BoardView, RelayoutBoardsResult } from '@storyscript/contracts';
import { RENDERER_VERSION } from '@storyscript/core';

/**
 * "用新画法重排" (S4c): which boards the button would lay out again. Pure, so
 * it can be tested with any renderer version. The count is the server's own
 * rule (services/boards relayoutBoards), applied to the list the page already
 * has: the newest board of every live shot is skipped when it was edited by
 * hand, wears an adopted AI picture, or was already drawn by the current
 * renderer.
 */

type BoardLike = Pick<BoardView, 'scene_id' | 'renderer_version' | 'user_edited' | 'adopted_raster_id'>;

export interface RelayoutCounts {
  /** would get a new version */
  relayable: number;
  /** newest board edited by hand or wearing an adopted AI picture: left alone */
  kept: number;
  /** already laid out by the current renderer */
  current: number;
}

/** sceneId null = every scene */
export function relayoutCounts(boards: readonly BoardLike[], sceneId: string | null, version: string = RENDERER_VERSION): RelayoutCounts {
  const out: RelayoutCounts = { relayable: 0, kept: 0, current: 0 };
  for (const b of boards) {
    if (sceneId !== null && b.scene_id !== sceneId) continue;
    if (b.user_edited || b.adopted_raster_id) out.kept += 1;
    else if (b.renderer_version === version) out.current += 1;
    else out.relayable += 1;
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
  // what is left alone is said once, in the notice above the buttons
  return `用新画法重排${lead}${n} 个分镜`;
}

export interface RelayoutButton {
  /** scene id, null = every scene */
  target: string | null;
  label: string;
}

export interface RelayoutOffer {
  /** boards the buttons together can lay out again */
  relayable: number;
  buttons: RelayoutButton[];
}

/**
 * What the boards page offers, null when there is nothing to lay out again. One
 * button when this scene holds all of it (or none of it: the button then covers
 * the other scenes), two (this scene, every scene) when both are different.
 */
export function relayoutOffer(boards: readonly BoardLike[], sceneId: string, version: string = RENDERER_VERSION): RelayoutOffer | null {
  const all = relayoutCounts(boards, null, version);
  if (all.relayable === 0) return null;
  const scene = relayoutCounts(boards, sceneId, version);
  const both = scene.relayable > 0 && all.relayable > scene.relayable;
  const buttons: RelayoutButton[] = both
    ? [
        { target: sceneId, label: relayoutLabel(scene.relayable, 'scene') },
        { target: null, label: relayoutLabel(all.relayable, 'all') },
      ]
    : [{ target: null, label: relayoutLabel(all.relayable, 'only') }];
  return { relayable: all.relayable, buttons };
}

/** After the server answered: "重排了 5 个，跳过手改过和用了 AI 图的 1 个" */
export function relayoutResultLine(r: RelayoutBoardsResult): string {
  return `重排了 ${r.relaid} 个，跳过手改过和用了 AI 图的 ${r.kept_edited} 个`;
}

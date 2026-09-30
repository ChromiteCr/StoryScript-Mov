import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { CoverageDecision, CoverageDecisionInput, CoverageResult } from '@storyscript/contracts';
import { computeCoverageAll, type CoverageInput, type CoverageShot } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { insertDecision, lastDecisionAt, listDecisions } from '../../db/repos/coverage.ts';
import { listLinks } from '../../db/repos/link.ts';
import { listAllAssets } from '../../db/repos/media.ts';
import { listActiveShots, getShot } from '../../db/repos/shot.ts';
import { listTakes } from '../../db/repos/take.ts';
import { AppError } from '../../http/errors.ts';
import { isRangeExact } from '../media/links.ts';

/**
 * Coverage (SPEC FR-09, invariant COV): never stored; this module only
 * gathers the facts and calls core computeCoverageAll — the same function the
 * web and the CSV export use. Decisions are append-only.
 */

/** The exact inputs computeCoverageAll receives for the open project. */
export function coverageInputs(db: DbPort): { shots: CoverageShot[]; rest: Omit<CoverageInput, 'shot'> } {
  const shots = listActiveShots(db).map((s) => ({ id: s.id, required_status: s.required_status, content_hash: s.content_hash }));
  return {
    shots,
    rest: {
      takes: listTakes(db),
      links: listLinks(db),
      assets: listAllAssets(db).map((a) => ({ id: a.id, availability: a.availability, probe: a.probe })),
      decisions: listDecisions(db),
    },
  };
}

export function projectCoverage(db: DbPort): CoverageResult[] {
  const { shots, rest } = coverageInputs(db);
  return computeCoverageAll(shots, rest);
}

/** ISO time strictly after `prev` (decisions of one shot replay in `at` order). */
function nextInstant(now: string, prev: string | null): string {
  if (prev === null || Date.parse(now) > Date.parse(prev)) return now;
  return new Date(Date.parse(prev) + 1).toISOString();
}

export function addCoverageDecision(
  db: DbPort,
  shotId: string,
  input: z.infer<typeof CoverageDecisionInput>,
  now = new Date().toISOString(),
): CoverageDecision {
  return db.tx(() => {
    const shot = getShot(db, shotId);
    if (!shot) throw new AppError('NOT_FOUND', '镜头不存在', 404);
    if (shot.archived) throw new AppError('VALIDATION_ERROR', '镜头已归档，不能再做覆盖决定', 400);
    const reason = input.reason.trim();
    if (!reason) throw new AppError('VALIDATION_ERROR', '覆盖决定必须填写原因', 400);

    let selected: string[] = [];
    if (input.decision === 'usable') {
      selected = [...new Set(input.selected_link_ids)];
      if (selected.length === 0) throw new AppError('VALIDATION_ERROR', '设为可用时至少要选一条已确认的素材关联', 400);
      const links = new Map(listLinks(db).map((l) => [l.id, l] as const));
      const assets = new Map(listAllAssets(db).map((a) => [a.id, a] as const));
      for (const id of selected) {
        const l = links.get(id);
        const problem =
          !l || l.shot_id !== shotId
            ? '不是这个镜头的关联'
            : l.status !== 'confirmed'
              ? '还没有确认'
              : assets.get(l.media_asset_id)?.availability !== 'online'
                ? '原片不在线'
                : !isRangeExact(db, l, assets.get(l.media_asset_id) ?? null)
                  ? '片段区间不精确或与素材的流信息不符'
                  : null;
        if (problem) {
          throw new AppError('VALIDATION_ERROR', `所选关联${problem}：设为可用只能选本镜头已确认、原片在线、区间精确的关联`, 400, {
            link_id: id,
          });
        }
      }
    } else if (input.selected_link_ids.length > 0) {
      throw new AppError('VALIDATION_ERROR', '只有"设为可用"需要选择素材关联', 400);
    }

    const decision: CoverageDecision = {
      id: randomUUID(),
      shot_id: shotId,
      decision: input.decision,
      selected_link_ids: selected,
      reason,
      basis_content_hash: shot.content_hash,
      at: nextInstant(now, lastDecisionAt(db, shotId)),
    };
    insertDecision(db, decision);
    return listDecisions(db).find((d) => d.id === decision.id) ?? decision;
  });
}

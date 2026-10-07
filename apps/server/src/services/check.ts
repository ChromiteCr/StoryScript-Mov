import type { Project, ScriptCheckView, ScriptRisk } from '@storyscript/contracts';
import { anchorQuote, estimateScript } from '@storyscript/core';
import { actorResolver } from '../collab/actor.ts';
import { checkVersionOf, getRisk, latestCheck, listRisks, setRiskHandledRow, type RiskRow } from '../db/repos/check.ts';
import type { DbPort } from '../db/port.ts';
import { latestScriptVersion, listScenes } from '../db/repos/script.ts';
import { listSceneShots } from '../db/repos/shot.ts';
import { AppError } from '../http/errors.ts';

/**
 * S5 剧本体检 view: the rule-based length estimate of the current script, and
 * the latest check's difficulties placed in the current version (a check of
 * an older version finds each quote again; one no longer there is stale).
 */

interface Placement {
  paragraphs: readonly { id: string; text: string }[] | null;
  /** the check is of the current version: quotes stay where they were */
  current: boolean;
  sceneOf: ReadonlyMap<string, string>;
}

function placement(db: DbPort, checkVersionId: string | null): Placement {
  const version = latestScriptVersion(db);
  if (!version) return { paragraphs: null, current: false, sceneOf: new Map() };
  const sceneOf = new Map<string, string>();
  for (const s of listScenes(db, version.id)) for (const pid of s.paragraph_ids) sceneOf.set(pid, s.id);
  return { paragraphs: version.paragraphs, current: version.id === checkVersionId, sceneOf };
}

function riskView(r: RiskRow, at: Placement, who: ReturnType<typeof actorResolver>): ScriptRisk {
  const pid = !at.paragraphs ? null : at.current ? r.paragraph_id : anchorQuote(r.quote, r.paragraph_id, at.paragraphs);
  return {
    id: r.id,
    category: r.category,
    severity: r.severity,
    quote: r.quote,
    problem: r.problem,
    alternative: r.alternative,
    paragraph_id: pid,
    scene_id: pid ? (at.sceneOf.get(pid) ?? null) : null,
    stale: pid === null,
    handled: r.handled_at ? { at: r.handled_at, actor: who(r.handled_by) } : null,
  };
}

export function scriptCheckView(db: DbPort, project: Project): ScriptCheckView {
  const version = latestScriptVersion(db);
  let estimate: ScriptCheckView['estimate'] = null;
  if (version) {
    const scenes = listScenes(db, version.id);
    const shotSeconds = new Map<string, number>();
    for (const s of scenes) {
      const live = listSceneShots(db, s.id);
      if (live.length) shotSeconds.set(s.id, live.reduce((n, shot) => n + shot.fields.est_seconds, 0));
    }
    estimate = estimateScript(version.paragraphs, scenes, { shotSeconds, target_seconds: project.target_duration_s });
  }
  const check = latestCheck(db);
  if (!check) return { estimate, check: null, risks: [] };
  const who = actorResolver(db);
  const at = placement(db, check.script_version_id);
  return {
    estimate,
    check: {
      id: check.id,
      script_version_id: check.script_version_id,
      current: at.current,
      status: check.status,
      model: check.model,
      prompt_version: check.prompt_version,
      issues: check.issues,
      created_at: check.created_at,
      actor: who(check.actor_id),
    },
    risks: listRisks(db, check.id).map((r) => riskView(r, at, who)),
  };
}

/** Tick a difficulty off (or back on); any member may. */
export function setRiskHandled(db: DbPort, id: string, handled: boolean): ScriptRisk {
  const row = getRisk(db, id);
  if (!row) throw new AppError('NOT_FOUND', '找不到这条难点，可能已经重新体检过了', 404, { risk_id: id });
  if (Boolean(row.handled_at) !== handled) setRiskHandledRow(db, id, handled ? new Date().toISOString() : null);
  return riskView(getRisk(db, id)!, placement(db, checkVersionOf(db, row.check_id)), actorResolver(db));
}

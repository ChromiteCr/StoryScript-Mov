import { z } from 'zod';
import {
  Board,
  BoardRaster,
  Constraint,
  CoverageDecision,
  Entity,
  MediaAsset,
  Plan,
  PROJECT_EXPORT_FORMAT,
  PROJECT_EXPORT_VERSION,
  PROJECT_SCHEMA_VERSION,
  ProjectExport,
  Resource,
  Scene,
  ScriptVersion,
  Setup,
  Shot,
  ShotMediaLink,
  ShotRevision,
  Take,
  Technique,
} from '@storyscript/contracts';
import type { DbPort } from '../../db/port.ts';
import { listShotBoards } from '../../db/repos/board.ts';
import { listDecisions } from '../../db/repos/coverage.ts';
import { listConstraints } from '../../db/repos/constraint.ts';
import { listEntities } from '../../db/repos/entity.ts';
import { listLinks } from '../../db/repos/link.ts';
import { listAllAssets } from '../../db/repos/media.ts';
import { listPlans } from '../../db/repos/plan.ts';
import { getProject } from '../../db/repos/project.ts';
import { listBoardRasters } from '../../db/repos/raster.ts';
import { listResources } from '../../db/repos/resource.ts';
import { listRoots } from '../../db/repos/root.ts';
import { getScriptVersion, listScenes, stripSort } from '../../db/repos/script.ts';
import { listSetups } from '../../db/repos/setup.ts';
import { getShot, listShotRevisions } from '../../db/repos/shot.ts';
import { listTakes } from '../../db/repos/take.ts';
import { AppError } from '../../http/errors.ts';

/**
 * Project JSON export (SPEC FR-10, contracts ProjectExport). Everything
 * needed to understand and re-link the project, and nothing private:
 *   - no original media (assets carry root label + relative path + sha256);
 *   - no absolute paths (source roots export only id + label);
 *   - no API keys (they never live in the project), no job rows, no model
 *     drafts / raw outputs, no correction audit logs.
 * Every collection is read through the typed repos and re-validated with its
 * contract schema, then the whole object with ProjectExport.
 */

interface TechniqueRow {
  id: string;
  version: number;
  name: string;
  intended_effect: string;
  shot_grammar: string;
  camera_defaults_json: string;
  applicable_scenes: string;
  resource_cost_notes: string;
  low_budget_alternative: string;
  sources_json: string;
  limitations: string;
  builtin: number;
}

function userTechniques(db: DbPort): Technique[] {
  return db
    .all<TechniqueRow>('SELECT * FROM technique ORDER BY id')
    .map((r) =>
      Technique.parse({
        id: r.id,
        version: r.version,
        name: r.name,
        intended_effect: r.intended_effect,
        shot_grammar: r.shot_grammar,
        camera_defaults: JSON.parse(r.camera_defaults_json),
        applicable_scenes: r.applicable_scenes,
        resource_cost_notes: r.resource_cost_notes,
        low_budget_alternative: r.low_budget_alternative,
        sources: JSON.parse(r.sources_json),
        limitations: r.limitations,
        builtin: r.builtin === 1,
      }),
    );
}

const ids = (db: DbPort, sql: string) => db.all<{ id: string }>(sql).map((r) => r.id);

export interface ProjectExportOptions {
  appVersion: string;
  /** ISO instant of the export */
  now: string;
}

export function buildProjectExport(db: DbPort, opts: ProjectExportOptions): ProjectExport {
  const project = getProject(db);
  if (!project) throw new AppError('INTERNAL', '项目数据库缺少 project 记录', 500);

  const versions = ids(db, 'SELECT id FROM script_version ORDER BY created_at, rowid')
    .map((id) => getScriptVersion(db, id))
    .filter((v): v is ScriptVersion => v !== null);
  const scenes: Scene[] = versions.flatMap((v) => listScenes(db, v.id).map(stripSort));
  // every shot, archived ones included (their history explains the project)
  const shots = ids(db, 'SELECT id FROM shot ORDER BY created_at, rowid')
    .map((id) => getShot(db, id))
    .filter((s): s is Shot => s !== null);
  const revisions: ShotRevision[] = shots.flatMap((s) => listShotRevisions(db, s.id));
  const boards: Board[] = shots.flatMap((s) => listShotBoards(db, s.id));
  const rasters: BoardRaster[] = boards.flatMap((b) => listBoardRasters(db, b.id).reverse());

  const out = {
    format: PROJECT_EXPORT_FORMAT,
    export_version: PROJECT_EXPORT_VERSION,
    schema_version: PROJECT_SCHEMA_VERSION,
    exported_at: opts.now,
    app_version: opts.appVersion,
    project,
    script_versions: z.array(ScriptVersion).parse(versions),
    scenes: z.array(Scene).parse(scenes),
    entities: z.array(Entity).parse(listEntities(db)),
    shots: z.array(Shot).parse(shots),
    shot_revisions: z.array(ShotRevision).parse(revisions),
    boards: z.array(Board).parse(boards),
    board_rasters: z.array(BoardRaster).parse(rasters),
    techniques: z.array(Technique).parse(userTechniques(db)),
    resources: z.array(Resource).parse(listResources(db)),
    setups: z.array(Setup).parse(listSetups(db)),
    constraints: z.array(Constraint).parse(listConstraints(db)),
    plans: z.array(Plan).parse(listPlans(db)),
    takes: z.array(Take).parse(listTakes(db)),
    // label only: the absolute path of a user's disk is private
    source_roots: listRoots(db).map((r) => ({ id: r.id, label: r.label })),
    media_assets: z.array(MediaAsset).parse(listAllAssets(db)),
    shot_media_links: z.array(ShotMediaLink).parse(listLinks(db)),
    coverage_decisions: z.array(CoverageDecision).parse(listDecisions(db)),
  };
  const parsed = ProjectExport.safeParse(out);
  if (!parsed.success) {
    throw new AppError('INTERNAL', '项目导出数据不符合 ProjectExport 契约', 500, {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

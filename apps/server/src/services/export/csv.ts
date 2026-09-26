import type { Plan } from '@storyscript/contracts';
import {
  buildPlanLookup,
  callSheetCsv,
  coverageCsv,
  EXPORT_CSV_TITLE,
  exportFileStem,
  exportPlanChoice,
  exportShotRefs,
  shotListCsv,
  takeMediaCsv,
  utcToLocal,
  type ExportCsvKind,
} from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { listEntities } from '../../db/repos/entity.ts';
import { listLinks } from '../../db/repos/link.ts';
import { getPlan, listPlans } from '../../db/repos/plan.ts';
import { getProject } from '../../db/repos/project.ts';
import { listResources } from '../../db/repos/resource.ts';
import { latestScriptVersion, listScenes } from '../../db/repos/script.ts';
import { listSetups } from '../../db/repos/setup.ts';
import { listActiveShots } from '../../db/repos/shot.ts';
import { listTakes } from '../../db/repos/take.ts';
import { AppError } from '../../http/errors.ts';
import { projectCoverage } from '../coverage/coverage.ts';
import { listAssetViews } from '../media/assets.ts';

/**
 * CSV exports (SPEC FR-10) for GET /api/v1/export/csv/:kind. The tables are
 * built by the same core/export functions the pages use (same columns, same
 * rows, same formula neutralisation and five integer source_range columns),
 * from the same data the pages read: active shots of the current script in
 * narrative order, coverage from core computeCoverage (COV).
 */

export interface CsvExport {
  kind: ExportCsvKind;
  /** download name, e.g. 旧书-镜头表-2026-10-05.csv */
  filename: string;
  text: string;
}

export interface CsvExportOptions {
  bom: boolean;
  /** callsheet only; default: exportPlanChoice */
  planId?: string | null;
  now?: Date;
}

export function buildCsvExport(db: DbPort, kind: ExportCsvKind, opts: CsvExportOptions): CsvExport {
  const project = getProject(db);
  if (!project) throw new AppError('INTERNAL', '项目数据库缺少 project 记录', 500);
  const version = latestScriptVersion(db);
  const scenes = version ? listScenes(db, version.id) : [];
  const shots = listActiveShots(db);
  const refs = exportShotRefs(shots, scenes);
  const today = utcToLocal((opts.now ?? new Date()).toISOString(), project.timezone).date;
  const name = (what: string, date = today) => `${exportFileStem(project.name, what, date)}.csv`;
  const csv = { bom: opts.bom };

  switch (kind) {
    case 'shots': {
      const characterNames = new Map(listEntities(db).filter((e) => e.type === 'character').map((e) => [e.alias, e.name] as const));
      return { kind, filename: name(EXPORT_CSV_TITLE.shots), text: shotListCsv({ refs, characterNames }, csv) };
    }
    case 'callsheet': {
      let plan: Plan | null;
      if (opts.planId) {
        plan = getPlan(db, opts.planId);
        if (!plan) throw new AppError('NOT_FOUND', '计划不存在', 404);
      } else {
        plan = exportPlanChoice(listPlans(db));
        if (!plan) throw new AppError('NOT_FOUND', '还没有拍摄计划：先在"计划"页新建一个拍摄日', 404);
      }
      const lookup = buildPlanLookup({
        timezone: plan.timezone,
        date: plan.date,
        setups: listSetups(db),
        shots,
        resources: listResources(db),
        scenes,
      });
      const draft = plan.status === 'approved' ? '' : '-草案';
      return { kind, filename: name(`${EXPORT_CSV_TITLE.callsheet}${draft}`, plan.date), text: callSheetCsv(plan, lookup, opts.bom) };
    }
    case 'takes-media': {
      const assets = new Map(listAssetViews(db).map((a) => [a.id, a] as const));
      return {
        kind,
        filename: name(EXPORT_CSV_TITLE['takes-media']),
        text: takeMediaCsv({ refs, takes: listTakes(db), links: listLinks(db), assets }, csv),
      };
    }
    case 'coverage':
      return { kind, filename: name(EXPORT_CSV_TITLE.coverage), text: coverageCsv(projectCoverage(db), refs, csv) };
  }
}

/**
 * Content-Disposition for a download with a non-ASCII name (RFC 6266 /
 * RFC 5987): an ASCII fallback plus filename* in UTF-8.
 */
export function attachmentHeader(filename: string, asciiFallback: string): string {
  const safeAscii = asciiFallback.replace(/[^A-Za-z0-9._-]+/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

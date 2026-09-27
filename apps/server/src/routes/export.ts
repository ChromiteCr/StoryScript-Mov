import type { Hono } from 'hono';
import { exportFileStem, isExportCsvKind, utcToLocal } from '@storyscript/core';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { attachmentHeader, buildCsvExport } from '../services/export/csv.ts';
import { buildProjectExport } from '../services/export/project-json.ts';
import { APP_VERSION } from '../version.ts';

/**
 * Exports (SPEC FR-10) as file downloads (not the { data } envelope):
 *
 *   GET /api/v1/export/project.json      contracts ProjectExport, validated
 *   GET /api/v1/export/csv/:kind[?bom=1]  kind = shots | callsheet | takes-media | coverage
 *                                         (callsheet: &plan_id=<uuid>, default = exportPlanChoice)
 *
 * Both sit under /api/ so authGuard requires the session cookie; the page
 * links to them with <a download>. Nothing is written to disk.
 */

export const EXPORT_PATHS = {
  projectJson: '/api/v1/export/project.json',
  csv: '/api/v1/export/csv/:kind',
} as const;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function registerExportRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(EXPORT_PATHS.projectJson, (c) => {
    const now = new Date();
    const data = buildProjectExport(db(), { appVersion: APP_VERSION, now: now.toISOString() });
    const date = utcToLocal(now.toISOString(), data.project.timezone).date;
    const name = `${exportFileStem(data.project.name, '项目', date)}.json`;
    const body = `${JSON.stringify(data, null, 2)}\n`;
    return c.body(body, 200, {
      ...NO_STORE,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': attachmentHeader(name, `storyscript-project-${date}.json`),
    });
  });

  app.get(EXPORT_PATHS.csv, (c) => {
    const kind = c.req.param('kind');
    if (!kind || !isExportCsvKind(kind)) {
      throw new AppError('NOT_FOUND', '没有这种导出：可选 shots、callsheet、takes-media、coverage', 404, { kind });
    }
    const bomParam = c.req.query('bom');
    if (bomParam !== undefined && bomParam !== '0' && bomParam !== '1') {
      throw new AppError('VALIDATION_ERROR', 'bom 只能是 0 或 1', 400, { bom: bomParam });
    }
    const planId = c.req.query('plan_id') ?? null;
    if (planId !== null && !/^[0-9a-f-]{36}$/i.test(planId)) throw new AppError('NOT_FOUND', '计划不存在', 404);
    if (planId !== null && kind !== 'callsheet') throw new AppError('VALIDATION_ERROR', 'plan_id 只用于拍摄单导出', 400);
    const out = buildCsvExport(db(), kind, { bom: bomParam === '1', planId });
    const date = /(\d{4}-\d{2}-\d{2})\.csv$/.exec(out.filename)?.[1] ?? 'export';
    return c.body(out.text, 200, {
      ...NO_STORE,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachmentHeader(out.filename, `storyscript-${kind}-${date}.csv`),
    });
  });
}

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Board, BoardRaster, Job } from '@storyscript/contracts';
import { buildImagePrompt, RASTER_POST_VERSION, stableStringify, structureHash, type CanvasPlan, type ImagePrompt } from '@storyscript/core';
import { callImage, type CallOutcome } from '../../adapters/image/call.ts';
import { sha256Hex } from '../../adapters/image/payload.ts';
import { imageInfo } from '../../adapters/image/sniff.ts';
import type { ImageEndpoint, ImageQuality, ImageRequest } from '../../adapters/image/types.ts';
import { redactSecrets } from '../../adapters/llm/redact.ts';
import { projectContext } from '../../ai/runtime.ts';
import type { ImageClientConfig } from '../../config/image-provider.ts';
import type { DbPort } from '../../db/port.ts';
import { getJobByKey } from '../../db/repos/job.ts';
import { countRasters, getRaster, insertRaster, kvRead, kvWrite, readBoard } from '../../db/repos/raster.ts';
import { getShot } from '../../db/repos/shot.ts';
import type { AppDeps } from '../../deps.ts';
import { AppError } from '../../http/errors.ts';
import type { JobQueue, JobRunContext, JobRunResult } from '../../jobs/queue.ts';
import { canvasFor, postProcess, renderControl, type ControlImage } from './imaging.ts';
import { KV_RASTER_CAP, redrawOptions } from './options.ts';
import { imageOverrides, requireImageClient, USER_AGENT } from './runtime.ts';
import {
  absPath,
  controlFileRel,
  rasterFileRel,
  rawFileRel,
  SIDECAR_SCHEMA,
  sidecarRel,
  writeProjectFile,
  type RasterSidecar,
} from './storage.ts';

/**
 * requestRedraw (SPEC FR-11, FR-12 — experimental):
 *
 *   confirmed=false → 400 MISSING_CONFIRMATION; no image provider (or an
 *   address that cannot take reference images) → 409 PROVIDER_NOT_CONFIGURED;
 *   nothing is sent in either case.
 *
 *   control image (resvg, no text) + compiled prompt → cache key
 *   hash(dialect, host, model, prompt, control sha256, reference, size,
 *   quality). A stored candidate/adopted raster with that key is returned
 *   without sending anything. Otherwise the project soft cap is checked and a
 *   remote image_redraw job is queued (lane 'image': one paid image request at
 *   a time, independent of the text-model lane).
 *
 *   The job stores one candidate: raster-<id>.png (post-processed),
 *   raw-<id>.<ext>, control-<id>.png and the raster-<id>.json sidecar, then a
 *   board_raster row (status candidate; outcome ok / refused /
 *   outcome_unknown — the job itself then ends as outcome_unknown, never
 *   re-sent). A result that arrives after the job was cancelled is kept
 *   as outcome late_after_cancel and never adopted automatically. Board spec
 *   and shot fields are never written (INV-09).
 */

export const cacheKvKey = (boardId: string, cacheKey: string) => `raster_cache:${boardId}:${cacheKey}`;
export const redrawJobKey = (boardId: string, cacheKey: string) => `image_redraw:${boardId}:${cacheKey}`;

export interface RedrawPlan {
  board: Board;
  cfg: ImageClientConfig;
  prompt: ImagePrompt;
  plan: CanvasPlan;
  control: ControlImage;
  requested_quality: ImageQuality;
  /** quality actually sent (null: the dialect has no quality parameter) */
  quality: ImageQuality | null;
  structure_hash: string;
  prompt_sha256: string;
  cache_key: string;
}

export async function planRedraw(deps: AppDeps, db: DbPort, board: Board, requested: ImageQuality): Promise<RedrawPlan> {
  const cfg = requireImageClient(deps, { forRedraw: true });
  const shot = getShot(db, board.shot_id);
  const opts = redrawOptions(db);
  const plan = canvasFor(cfg.dialect, cfg.preset, board.spec.frame.aspect, opts.pixel_window);
  const prompt = buildImagePrompt({
    spec: board.spec,
    shot: shot ? shot.fields : null,
    lang: opts.prompt_lang,
    padded: plan.padded,
    style_anchor: false,
    // names and aliases never leave the machine (INV: characters become "Person k")
    roster: db
      .all<{ id: string; name: string; aliases_json: string }>(`SELECT id, name, aliases_json FROM entity WHERE type = 'character'`)
      .map((e) => ({ entity_id: e.id, name: e.name, aliases: JSON.parse(e.aliases_json) as string[] })),
  });
  const control = await renderControl(board.spec, opts.control_mode, plan);
  const quality = cfg.dialect === 'openai-edits' ? requested : null;
  const cache_key = sha256Hex(
    new TextEncoder().encode(
      stableStringify({
        v: 1,
        dialect: cfg.dialect,
        host: cfg.host,
        model: cfg.model,
        preset: cfg.preset?.id ?? null,
        prompt: prompt.text,
        control: control.sha256,
        reference: null,
        size: plan.request_size,
        // the quality actually sent (generations-ref has none, so low/high share one key)
        quality,
      }),
    ),
  );
  return {
    board,
    cfg,
    prompt,
    plan,
    control,
    requested_quality: requested,
    quality,
    structure_hash: structureHash(board.spec),
    prompt_sha256: sha256Hex(new TextEncoder().encode(prompt.text)),
    cache_key,
  };
}

/** Stored candidate for this key (same board, not rejected, file on disk). */
function cachedRaster(db: DbPort, projectDir: string, boardId: string, cacheKey: string): BoardRaster | null {
  const entry = kvRead<{ raster_id?: unknown }>(db, cacheKvKey(boardId, cacheKey));
  if (!entry || typeof entry.raster_id !== 'string') return null;
  const r = getRaster(db, entry.raster_id);
  if (!r || r.board_id !== boardId || !r.file || r.status === 'rejected') return null;
  return existsSync(absPath(projectDir, r.file)) ? r : null;
}

function cacheHitJob(jobs: JobQueue, db: DbPort, key: string, cacheKey: string, raster: BoardRaster): Job {
  const job = getJobByKey(db, key);
  if (job && job.status === 'succeeded' && job.result_ref === raster.id) return job;
  // e.g. a late_after_cancel candidate: settle through a job that sends nothing
  return jobs.enqueue({
    kind: 'image_redraw',
    idempotency_key: key,
    input_hash: cacheKey,
    remote: false,
    lane: 'local',
    run: async () => ({ status: 'succeeded', attempts: 0, usage: null, error: null, commit: () => raster.id }),
  });
}

export async function requestRedraw(deps: AppDeps, boardId: string, input: { confirmed: boolean; quality: ImageQuality }): Promise<Job> {
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const board = readBoard(db, boardId);
  if (!board) throw new AppError('NOT_FOUND', '分镜不存在', 404);
  if (!input.confirmed) {
    throw new AppError('MISSING_CONFIRMATION', '请先确认：将把控制图（不含文字）和镜头文字发送到图像服务，费用以服务商账单为准', 400);
  }
  const rp = await planRedraw(deps, db, board, input.quality);
  const key = redrawJobKey(board.id, rp.cache_key);

  const hit = cachedRaster(db, project.dir, board.id, rp.cache_key);
  if (hit) return cacheHitJob(jobs, db, key, rp.cache_key, hit);
  const inflight = getJobByKey(db, key);
  if (inflight && (inflight.status === 'queued' || inflight.status === 'running')) return inflight;

  const cap = redrawOptions(db).raster_cap;
  const used = countRasters(db) + jobs.listActive().filter((j) => j.kind === 'image_redraw' && j.remote).length;
  if (used >= cap) {
    throw new AppError(
      'VALIDATION_ERROR',
      `本项目的 AI 候选图已达软上限 ${cap} 张，已停止发送；如确需继续，请调高项目设置 ${KV_RASTER_CAP}`,
      409,
      { cap, used, kv_key: KV_RASTER_CAP },
    );
  }

  const endpoint: ImageEndpoint = { base_url: rp.cfg.base_url, api_key: rp.cfg.api_key, model: rp.cfg.model, dialect: rp.cfg.dialect, preset: rp.cfg.preset, host: rp.cfg.host };
  return jobs.enqueue({
    kind: 'image_redraw',
    idempotency_key: key,
    input_hash: rp.cache_key,
    remote: true,
    lane: 'image',
    run: (ctx) => runRedraw(deps, db, project.dir, endpoint, rp, ctx),
  });
}

// ---------------------------------------------------------------------------
// job body
// ---------------------------------------------------------------------------

type Stored = { row: BoardRaster; sidecar: RasterSidecar; postError: string | null };

async function store(
  projectDir: string,
  rp: RedrawPlan,
  jobId: string,
  res: Exclude<CallOutcome, { outcome: 'failed' } | { outcome: 'cancelled' }>,
  late: boolean,
): Promise<Stored> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const b = rp.board;
  const controlRel = controlFileRel(b.id, id);
  writeProjectFile(projectDir, controlRel, rp.control.png);

  let raw: RasterSidecar['raw'] = null;
  let output: RasterSidecar['output'] = null;
  let postError: string | null = null;
  if (res.outcome === 'ok') {
    const img = res.image;
    const ext = imageInfo(img.bytes)?.ext ?? 'bin';
    const rawRel = rawFileRel(b.id, id, ext);
    writeProjectFile(projectDir, rawRel, img.bytes);
    raw = { file: rawRel, sha256: img.sha256, mime: img.mime, width: img.width, height: img.height, delivery: img.delivery };
    try {
      const post = await postProcess(img, rp.plan, b.spec.frame.aspect);
      const outRel = rasterFileRel(b.id, id);
      writeProjectFile(projectDir, outRel, post.png);
      output = { file: outRel, sha256: sha256Hex(post.png), width: post.width, height: post.height, post_version: RASTER_POST_VERSION };
    } catch (err) {
      postError = `后处理失败：${err instanceof Error ? err.message : String(err)}（原图已保存为 ${rawRel}）`;
    }
  }
  const outcome: BoardRaster['outcome'] = late ? 'late_after_cancel' : res.outcome === 'ok' ? 'ok' : res.outcome;
  const usage = res.outcome === 'ok' ? res.usage : null;
  const row: BoardRaster = {
    id,
    board_id: b.id,
    structure_hash: rp.structure_hash,
    dialect: rp.cfg.dialect,
    host: rp.cfg.host,
    model: rp.cfg.model,
    preset_id: rp.cfg.preset?.id ?? null,
    size: rp.plan.request_size,
    quality: rp.quality,
    prompt_hash: rp.prompt_sha256,
    control_sha256: rp.control.sha256,
    file: output?.file ?? null,
    sha256: output?.sha256 ?? null,
    status: 'candidate',
    outcome,
    usage,
    ai_label_on: true,
    source_type: 'model_generated',
    created_at: now,
  };
  const sidecar: RasterSidecar = {
    schema: SIDECAR_SCHEMA,
    raster_id: id,
    board_id: b.id,
    board_version: b.version,
    shot_id: b.shot_id,
    job_id: jobId,
    created_at: now,
    source_type: 'model_generated',
    ai_label: true,
    outcome,
    provider: {
      dialect: rp.cfg.dialect,
      host: rp.cfg.host,
      model: rp.cfg.model,
      preset_id: rp.cfg.preset?.id ?? null,
      preset_verified: rp.cfg.preset?.verified ?? false,
    },
    request: {
      size: rp.plan.request_size,
      requested_quality: rp.requested_quality,
      quality: rp.quality,
      n: 1,
      prompt_version: rp.prompt.version,
      prompt_lang: rp.prompt.lang,
      prompt_hash: rp.prompt_sha256,
      prompt: rp.prompt.text,
      removed_terms: rp.prompt.removed,
      optional_params_stripped: res.outcome === 'ok' ? res.stripped : false,
      attempts: res.attempts,
      cache_key: rp.cache_key,
    },
    structure_hash: rp.structure_hash,
    control: { mode: rp.control.mode, sha256: rp.control.sha256, file: controlRel, width: rp.control.width, height: rp.control.height },
    reference: null,
    canvas: rp.plan,
    raw,
    output,
    postprocess_error: postError,
    usage,
    error: res.outcome === 'ok' ? null : { code: res.error.code, message: res.error.message },
  };
  writeProjectFile(projectDir, sidecarRel(b.id, id), `${JSON.stringify(sidecar, null, 2)}\n`);
  return { row, sidecar, postError };
}

function persist(db: DbPort, s: Stored, boardId: string, cacheKey: string): string {
  insertRaster(db, s.row);
  if (s.row.file) kvWrite(db, cacheKvKey(boardId, cacheKey), { raster_id: s.row.id }, s.row.created_at);
  return s.row.id;
}

async function runRedraw(deps: AppDeps, db: DbPort, projectDir: string, endpoint: ImageEndpoint, rp: RedrawPlan, ctx: JobRunContext): Promise<JobRunResult> {
  const o = imageOverrides(deps);
  const req: ImageRequest = {
    prompt: rp.prompt.text,
    images: [{ bytes: rp.control.png, mime: 'image/png', name: 'control.png' }],
    size: rp.plan.request_size,
    quality: rp.quality,
  };
  const res = await callImage(endpoint, req, {
    timeoutMs: o.timeoutMs,
    sleep: o.sleep,
    retryAfterCapMs: o.retryAfterCapMs,
    defaultRetryAfterMs: o.defaultRetryAfterMs,
    signal: ctx.signal,
    onAttempt: ctx.markSent,
    userAgent: USER_AGENT,
    attempt: o.attempt,
  });
  if (res.outcome === 'cancelled') return { status: 'failed', attempts: res.attempts, usage: null, error: { code: 'CANCELLED', message: '已取消' } };
  if (res.outcome === 'failed') return { status: 'failed', attempts: res.attempts, usage: null, error: res.error };

  const late = ctx.signal.aborted;
  if (late && res.outcome !== 'ok') return { status: 'failed', attempts: res.attempts, usage: null, error: res.error };

  let stored: Stored;
  try {
    stored = await store(projectDir, rp, ctx.job_id, res, late);
  } catch (err) {
    return {
      status: 'failed',
      attempts: res.attempts,
      usage: res.outcome === 'ok' ? res.usage : null,
      error: { code: 'INTERNAL', message: redactSecrets(`保存结果失败：${err instanceof Error ? err.message : String(err)}`, [endpoint.api_key]) },
    };
  }

  if (late) {
    // the queue drops results of cancelled jobs; a late image is still kept as a candidate
    try {
      db.tx(() => persist(db, stored, rp.board.id, rp.cache_key));
    } catch (err) {
      console.error('[storyscript-mov] 晚到的 AI 候选写入失败：', redactSecrets(err instanceof Error ? err.message : String(err), [endpoint.api_key]));
    }
    return { status: 'failed', attempts: res.attempts, usage: stored.row.usage, error: null };
  }

  const commit = () => persist(db, stored, rp.board.id, rp.cache_key);
  if (res.outcome === 'ok') {
    if (stored.postError) {
      return { status: 'failed', attempts: res.attempts, usage: res.usage, error: { code: 'PROVIDER_ERROR', message: stored.postError }, commit };
    }
    return { status: 'succeeded', attempts: res.attempts, usage: res.usage, error: null, commit };
  }
  // timeout / 5xx / dropped connection after sending: the paid call may have gone through
  return { status: res.outcome === 'outcome_unknown' ? 'outcome_unknown' : 'failed', attempts: res.attempts, usage: null, error: res.error, commit };
}

import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type {
  BuildCandidatesInput,
  BuildCandidatesOutput,
  CreateLinkInput,
  LinkCandidate,
  MediaAsset,
  ReviewLinkInput,
  ShotMediaLink,
  SourceRange,
} from '@storyscript/contracts';
import { buildCandidates, validateSourceRange, wholeAssetSourceRange, type CandidateShot } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { getProject } from '../../db/repos/project.ts';
import { deleteLink, findLink, getLink, insertLink, listLinks, updateLinkRow } from '../../db/repos/link.ts';
import { getAsset, listAllAssets } from '../../db/repos/media.ts';
import { listTakes } from '../../db/repos/take.ts';
import { AppError } from '../../http/errors.ts';
import { kvDelete, kvGet, kvPut, linkInexactKey } from './kv.ts';
import { requireTake } from './takes.ts';

/**
 * Shot ↔ media links (SPEC FR-09, INV-06). Candidates from core rules R1–R3
 * and manual links all start as `candidate`; only a person confirms. A link
 * covers the whole clip: [start_pts, start_pts + duration_ts) of the chosen
 * stream in its own time base (SR). When the probe lacks start_pts or
 * duration_ts the range is estimated; such links are still created (so the
 * clip can be reviewed) but carry an "inexact" note and can never be picked
 * for a usable coverage decision.
 */

type Output = z.infer<typeof BuildCandidatesOutput>;

export interface WholeRange {
  range: SourceRange;
  exact: boolean;
}

/** Whole-clip range on the video stream, or the first audio stream for sound files. */
export function wholeRangeFor(asset: Pick<MediaAsset, 'probe' | 'video_stream_index'>): WholeRange | null {
  if (!asset.probe) return null;
  const idx = asset.video_stream_index ?? asset.probe.streams.find((s) => s.codec_type === 'audio')?.index ?? null;
  if (idx === null) return null;
  return wholeAssetSourceRange(asset.probe, idx);
}

/** A link range whose bounds can be verified exactly against the probed stream. */
export function isRangeExact(db: DbPort, link: Pick<ShotMediaLink, 'id' | 'source_range'>, asset: Pick<MediaAsset, 'probe'> | null): boolean {
  if (!asset?.probe) return false;
  if (!validateSourceRange(link.source_range, asset).ok) return false;
  const s = asset.probe.streams.find((x) => x.index === link.source_range.stream_index);
  if (!s || s.start_pts === null || s.duration_ts === null) return false;
  return kvGet(db, linkInexactKey(link.id)) === null;
}

export function requireLink(db: DbPort, id: string): ShotMediaLink {
  const l = getLink(db, id);
  if (!l) throw new AppError('NOT_FOUND', '关联不存在', 404);
  return l;
}

function candidateShots(db: DbPort): CandidateShot[] {
  return db.all<CandidateShot>(
    `SELECT s.id AS id, s.code AS code, sc.display_no AS scene_display_no
       FROM shot s JOIN scene sc ON sc.id = s.scene_id WHERE s.archived = 0 ORDER BY sc.sort, s.narrative_pos`,
  );
}

const EVIDENCE_RANK: Record<LinkCandidate['evidence'], number> = { R2: 0, R1: 1, R3: 2 };

/** One link per shot+asset: prefer a claim that names a take, then R2 > R1 > R3. */
function pickClaim(list: readonly LinkCandidate[]): LinkCandidate {
  return [...list].sort(
    (a, b) => Number(a.take_id === null) - Number(b.take_id === null) || EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence],
  )[0]!;
}

export function buildLinkCandidates(db: DbPort, input: z.infer<typeof BuildCandidatesInput>, now = new Date().toISOString()): Output {
  return db.tx(() => {
    const project = getProject(db);
    if (!project) throw new AppError('INTERNAL', '项目数据库缺少 project 记录', 500);
    const assets = listAllAssets(db);
    const byAsset = new Map(assets.map((a) => [a.id, a] as const));
    const result = buildCandidates({
      assets: assets.map((a) => ({ id: a.id, rel_path: a.rel_path })),
      shots: candidateShots(db),
      takes: listTakes(db),
      codeFormat: project.code_format,
      userRegex: input.user_regex?.trim() ? input.user_regex : null,
    });
    const errors: Output['errors'] = result.errors.map((e) => ({ code: e.code, message: e.message }));

    const groups = new Map<string, LinkCandidate[]>();
    for (const c of result.candidates) {
      const key = `${c.shot_id}|${c.media_asset_id}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }

    const created: ShotMediaLink[] = [];
    const inexactAssets = new Set<string>();
    const noRange = new Set<string>();
    for (const list of groups.values()) {
      const claim = pickClaim(list);
      if (findLink(db, claim.shot_id, claim.media_asset_id)) continue;
      const asset = byAsset.get(claim.media_asset_id)!;
      const whole = wholeRangeFor(asset);
      if (!whole) {
        noRange.add(asset.id);
        continue;
      }
      const link: ShotMediaLink = {
        id: randomUUID(),
        shot_id: claim.shot_id,
        media_asset_id: asset.id,
        take_id: claim.take_id,
        source_range: whole.range,
        evidence: claim.evidence,
        status: 'candidate',
        confirmed_at: null,
        revision: 0,
        created_at: now,
      };
      insertLink(db, link);
      if (!whole.exact) {
        kvPut(db, linkInexactKey(link.id), { reason: 'probe lacks start_pts or duration_ts; range estimated' }, now);
        inexactAssets.add(asset.id);
      }
      created.push(link);
    }
    for (const id of noRange) {
      const a = byAsset.get(id)!;
      errors.push({
        code: 'NO_SOURCE_RANGE',
        message: `「${a.rel_path}」没有可用的时间范围（未读到元数据、是静态图片或没有时长），没有生成关联`,
      });
    }
    const candidates = result.candidates.map((c) =>
      inexactAssets.has(c.media_asset_id) ? { ...c, detail: `${c.detail} (range inexact: estimated from format duration)` } : c,
    );
    return { created, candidates, errors };
  });
}

export interface CreateLinkResult {
  link: ShotMediaLink;
  created: boolean;
}

export function createManualLink(db: DbPort, input: z.infer<typeof CreateLinkInput>, now = new Date().toISOString()): CreateLinkResult {
  return db.tx(() => {
    const shot = db.get<{ archived: number }>('SELECT archived FROM shot WHERE id = ?', input.shot_id);
    if (!shot) throw new AppError('NOT_FOUND', '镜头不存在', 404);
    if (shot.archived === 1) throw new AppError('VALIDATION_ERROR', '镜头已归档，不能再关联素材', 400);
    const asset = getAsset(db, input.media_asset_id);
    if (!asset) throw new AppError('NOT_FOUND', '素材不存在', 404);
    if (input.take_id !== null) {
      const take = requireTake(db, input.take_id);
      if (!take.shot_ids.includes(input.shot_id)) {
        throw new AppError('VALIDATION_ERROR', '所选条次没有记录这个镜头', 400, { take_id: take.id, shot_id: input.shot_id });
      }
    }
    const existing = findLink(db, input.shot_id, asset.id);
    if (existing && existing.status !== 'rejected') return { link: existing, created: false };
    const whole = wholeRangeFor(asset);
    if (!whole) {
      throw new AppError('UNSUPPORTED_MEDIA', '这条素材没有可用的时间范围（未读取元数据、静态图片或没有时长），不能关联到镜头', 415, {
        asset_id: asset.id,
      });
    }
    if (existing) {
      const revived: ShotMediaLink = {
        ...existing,
        take_id: input.take_id,
        source_range: whole.range,
        evidence: 'manual',
        status: 'candidate',
        confirmed_at: null,
        revision: existing.revision + 1,
      };
      updateLinkRow(db, revived);
      if (whole.exact) kvDelete(db, linkInexactKey(existing.id));
      else kvPut(db, linkInexactKey(existing.id), { reason: 'probe lacks start_pts or duration_ts; range estimated' }, now);
      return { link: revived, created: false };
    }
    const link: ShotMediaLink = {
      id: randomUUID(),
      shot_id: input.shot_id,
      media_asset_id: asset.id,
      take_id: input.take_id,
      source_range: whole.range,
      evidence: 'manual',
      status: 'candidate',
      confirmed_at: null,
      revision: 0,
      created_at: now,
    };
    insertLink(db, link);
    if (!whole.exact) kvPut(db, linkInexactKey(link.id), { reason: 'probe lacks start_pts or duration_ts; range estimated' }, now);
    return { link, created: true };
  });
}

/** confirm / reject / unlink. Unlink deletes this one row only (no file, no other link — INV-06). */
export function reviewLink(db: DbPort, id: string, input: z.infer<typeof ReviewLinkInput>, now = new Date().toISOString()): ShotMediaLink {
  return db.tx(() => {
    const link = requireLink(db, id);
    if (link.revision !== input.expected_revision) {
      throw new AppError('REVISION_CONFLICT', '关联已被修改，请刷新后再试', 409, {
        link_id: id,
        expected_revision: input.expected_revision,
        current_revision: link.revision,
      });
    }
    if (input.action === 'unlink') {
      deleteLink(db, id);
      kvDelete(db, linkInexactKey(id));
      return link;
    }
    const next: ShotMediaLink =
      input.action === 'confirm'
        ? { ...link, status: 'confirmed', confirmed_at: now, revision: link.revision + 1 }
        : { ...link, status: 'rejected', confirmed_at: null, revision: link.revision + 1 };
    if (next.status === link.status) return link;
    updateLinkRow(db, next);
    return next;
  });
}

export { listLinks };

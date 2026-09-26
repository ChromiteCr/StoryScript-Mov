import type {
  CoverageResult,
  MediaAssetView,
  MissingReason,
  ShotMediaLink,
  StreamInfo,
  Take,
} from '@storyscript/contracts';
import {
  coverageCsv as coreCoverageCsv,
  takeMediaCsv as coreTakeMediaCsv,
  validateSourceRange,
  type TakeMediaInput,
} from '@storyscript/core';
import { MISSING_ORDER } from '../../lib/labels-media.ts';
import type { ShotRef } from '../set/model.ts';

/**
 * Pure helpers of the media page (FR-08/09/10): clip facts for display,
 * candidate conflicts, usable-link choices, the missing-shot list and the two
 * CSV exports. Coverage itself is never computed here: it comes from the API,
 * which runs core computeCoverage (COV).
 */

// ------------------------------------------------------------ clip facts

export function videoStream(a: Pick<MediaAssetView, 'probe' | 'video_stream_index'>): StreamInfo | null {
  if (!a.probe || a.video_stream_index === null) return null;
  return a.probe.streams.find((s) => s.index === a.video_stream_index) ?? null;
}

/** 2.04 → "0:02"; 3725 → "1:02:05"; null → "" */
export function formatClipDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 1536 → "1.5 KB"; bytes as 1024 steps. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "25/1" → "25"; "30000/1001" → "29.97" */
export function formatRate(rate: string | null): string {
  const m = rate ? /^(\d+)\/(\d+)$/.exec(rate) : null;
  if (!m || Number(m[2]) === 0) return '';
  const v = Number(m[1]) / Number(m[2]);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** "h264 High · 1920×1080 · 25 fps" style summary parts. */
export function clipSummary(a: MediaAssetView): { codec: string; resolution: string; fps: string } {
  const v = videoStream(a);
  const audio = a.probe?.streams.find((s) => s.codec_type === 'audio') ?? null;
  const s = v ?? audio;
  const codec = s?.codec_name ? `${s.codec_name}${s.profile ? ` ${s.profile}` : ''}` : '';
  return {
    codec,
    resolution: v?.width && v.height ? `${v.width}×${v.height}` : '',
    fps: v ? formatRate(v.avg_frame_rate ?? v.r_frame_rate) : '',
  };
}

export function fileName(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

// ------------------------------------------------------------ links

/** A link whose whole-clip range can be checked exactly against the probed stream. */
export function isRangeExact(link: Pick<ShotMediaLink, 'source_range'>, asset: Pick<MediaAssetView, 'probe'> | undefined): boolean {
  if (!asset?.probe) return false;
  if (!validateSourceRange(link.source_range, asset).ok) return false;
  const s = asset.probe.streams.find((x) => x.index === link.source_range.stream_index);
  return Boolean(s && s.start_pts !== null && s.duration_ts !== null);
}

/**
 * Assets whose open links cannot all be true at once: more than one take, or
 * shots not explained by one multi-shot take (mirror of core's rule, applied
 * to the stored candidate/confirmed links).
 */
export function conflictedAssets(links: readonly ShotMediaLink[], takes: readonly Pick<Take, 'id' | 'shot_ids'>[]): Set<string> {
  const takeShots = new Map(takes.map((t) => [t.id, new Set(t.shot_ids)] as const));
  const byAsset = new Map<string, ShotMediaLink[]>();
  for (const l of links) {
    if (l.status === 'rejected') continue;
    byAsset.set(l.media_asset_id, [...(byAsset.get(l.media_asset_id) ?? []), l]);
  }
  const out = new Set<string>();
  for (const [asset, list] of byAsset) {
    const takeIds = new Set(list.map((l) => l.take_id).filter((t): t is string => t !== null));
    const shots = new Set(list.map((l) => l.shot_id));
    let conflict: boolean;
    if (takeIds.size > 1) conflict = true;
    else if (takeIds.size === 1) {
      const covered = takeShots.get([...takeIds][0]!) ?? new Set<string>();
      conflict = [...shots].some((s) => !covered.has(s));
    } else conflict = shots.size > 1;
    if (conflict) out.add(asset);
  }
  return out;
}

export interface CandidateGroup {
  shotId: string;
  ref: ShotRef | undefined;
  links: ShotMediaLink[];
}

/** Candidate links grouped by shot, in the shots' narrative order. */
export function candidateGroups(links: readonly ShotMediaLink[], refs: readonly ShotRef[]): CandidateGroup[] {
  const order = new Map(refs.map((r, i) => [r.shot.id, i] as const));
  const refById = new Map(refs.map((r) => [r.shot.id, r] as const));
  const groups = new Map<string, ShotMediaLink[]>();
  for (const l of links) if (l.status === 'candidate') groups.set(l.shot_id, [...(groups.get(l.shot_id) ?? []), l]);
  return [...groups.entries()]
    .map(([shotId, list]) => ({ shotId, ref: refById.get(shotId), links: list }))
    .sort((a, b) => (order.get(a.shotId) ?? Infinity) - (order.get(b.shotId) ?? Infinity));
}

/** Links that may back a usable decision: this shot, confirmed, file online, exact range. */
export function usableChoices(shotId: string, links: readonly ShotMediaLink[], assets: ReadonlyMap<string, MediaAssetView>): ShotMediaLink[] {
  return links.filter((l) => {
    if (l.shot_id !== shotId || l.status !== 'confirmed') return false;
    const a = assets.get(l.media_asset_id);
    return a?.availability === 'online' && isRangeExact(l, a);
  });
}

// ------------------------------------------------------------ missing list

export interface MissingReport {
  byReason: Record<MissingReason, { ref: ShotRef; result: CoverageResult }[]>;
  /** optional or waived shots: listed apart, never counted as missing */
  notCounted: { ref: ShotRef; result: CoverageResult }[];
  total: number;
}

export function missingReport(coverage: readonly CoverageResult[], refs: readonly ShotRef[]): MissingReport {
  const byId = new Map(refs.map((r) => [r.shot.id, r] as const));
  const byReason = Object.fromEntries(MISSING_ORDER.map((r) => [r, []])) as unknown as MissingReport['byReason'];
  const notCounted: MissingReport['notCounted'] = [];
  const ordered = [...coverage].sort((a, b) => (byId.get(a.shot_id)?.order ?? Infinity) - (byId.get(b.shot_id)?.order ?? Infinity));
  for (const c of ordered) {
    const ref = byId.get(c.shot_id);
    if (!ref) continue;
    if (c.required_status !== 'required') {
      if (c.status !== 'usable') notCounted.push({ ref, result: c });
      continue;
    }
    if (c.missing_reason) byReason[c.missing_reason].push({ ref, result: c });
  }
  return { byReason, notCounted, total: MISSING_ORDER.reduce((n, r) => n + byReason[r].length, 0) };
}

// ------------------------------------------------------------ CSV (FR-10)
// Columns and row builders live in core/export: the server's
// /api/v1/export/csv/{takes-media,coverage} writes the same tables.

export { TAKE_MEDIA_COLUMNS, COVERAGE_COLUMNS, takeMediaRows, coverageRows, type TakeMediaInput } from '@storyscript/core';

/** Set log × clips, with BOM (Excel reads the Chinese headers as UTF-8). */
export function takeMediaCsv(input: TakeMediaInput): string {
  return coreTakeMediaCsv(input, { bom: true });
}

export function coverageCsv(coverage: readonly CoverageResult[], refs: readonly ShotRef[]): string {
  return coreCoverageCsv(coverage, refs, { bom: true });
}

/** File name stem safe on every OS: "周末短片-场记与素材-2026-09-26". */
export function exportName(project: string, what: string, date: Date = new Date()): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${project}-${what}-${d}`.replace(/[\\/:*?"<>|]+/g, '_');
}

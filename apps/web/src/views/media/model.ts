import type {
  CoverageResult,
  MediaAssetView,
  MissingReason,
  ShotMediaLink,
  StreamInfo,
  Take,
} from '@storyscript/contracts';
import { sourceRangeColumns, toCsv, validateSourceRange, type CsvColumn } from '@storyscript/core';
import {
  AVAILABILITY_LABEL,
  COVERAGE_STATUS_LABEL,
  EVIDENCE_LABEL,
  FLAG_LABEL,
  LINK_STATUS_LABEL,
  MISSING_ORDER,
  MISSING_REASON_LABEL,
  RATING_LABEL,
  REQUIRED_LABEL,
} from '../../lib/labels-media.ts';
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

const SR_COLUMNS: CsvColumn[] = [
  { key: 'stream_index', header: 'stream_index' },
  { key: 'in_pts', header: 'in_pts' },
  { key: 'out_pts', header: 'out_pts' },
  { key: 'time_base_num', header: 'time_base_num' },
  { key: 'time_base_den', header: 'time_base_den' },
];

export const TAKE_MEDIA_COLUMNS: CsvColumn[] = [
  { key: 'scene', header: '场' },
  { key: 'shot', header: '镜' },
  { key: 'take', header: '条次' },
  { key: 'camera', header: '机位' },
  { key: 'rating', header: '评级' },
  { key: 'clip_hint', header: '机内文件名' },
  { key: 'notes', header: '备注' },
  { key: 'logged_at', header: '记录时间' },
  { key: 'unresolved', header: '未对上的镜号' },
  { key: 'root', header: '素材目录' },
  { key: 'file', header: '文件' },
  { key: 'link_status', header: '关联状态' },
  { key: 'evidence', header: '关联依据' },
  { key: 'availability', header: '可用性' },
  { key: 'sha256', header: 'sha256' },
  ...SR_COLUMNS,
];

export interface TakeMediaInput {
  refs: readonly ShotRef[];
  takes: readonly Take[];
  links: readonly ShotMediaLink[];
  assets: ReadonlyMap<string, MediaAssetView>;
}

type Row = Record<string, unknown>;

/**
 * One row per take × shot × linked clip (a take without media still gets a
 * row), then clips linked to a shot without a take, then takes whose shot
 * labels could not be resolved. Rejected links are left out. source_range is
 * written as five integer columns.
 */
export function takeMediaRows({ refs, takes, links, assets }: TakeMediaInput): Row[] {
  const rows: Row[] = [];
  const open = links.filter((l) => l.status !== 'rejected');
  const media = (l: ShotMediaLink): Row => {
    const a = assets.get(l.media_asset_id);
    return {
      root: a?.root_label ?? '',
      file: a?.rel_path ?? l.media_asset_id,
      link_status: LINK_STATUS_LABEL[l.status],
      evidence: EVIDENCE_LABEL[l.evidence],
      availability: a ? AVAILABILITY_LABEL[a.availability] : '',
      sha256: a?.sha256 ?? '',
      ...sourceRangeColumns(l.source_range),
    };
  };
  const takeCells = (t: Take): Row => ({
    take: t.take_no,
    camera: t.camera_label ?? '',
    rating: RATING_LABEL[t.rating],
    clip_hint: t.clip_hint ?? '',
    notes: t.notes,
    logged_at: t.logged_at,
    unresolved: t.unresolved_labels.join('、'),
  });
  for (const ref of refs) {
    const shotCells = { scene: ref.scene_no, shot: ref.shot.code };
    const mine = takes.filter((t) => t.shot_ids.includes(ref.shot.id)).sort((a, b) => a.take_no - b.take_no);
    for (const t of mine) {
      const linked = open.filter((l) => l.shot_id === ref.shot.id && l.take_id === t.id);
      if (linked.length === 0) rows.push({ ...shotCells, ...takeCells(t) });
      for (const l of linked) rows.push({ ...shotCells, ...takeCells(t), ...media(l) });
    }
    for (const l of open.filter((x) => x.shot_id === ref.shot.id && (x.take_id === null || !mine.some((t) => t.id === x.take_id)))) {
      rows.push({ ...shotCells, ...media(l) });
    }
  }
  for (const t of takes.filter((x) => x.shot_ids.length === 0)) rows.push({ scene: '', shot: '', ...takeCells(t) });
  return rows;
}

export function takeMediaCsv(input: TakeMediaInput): string {
  return toCsv(takeMediaRows(input), TAKE_MEDIA_COLUMNS, { bom: true });
}

export const COVERAGE_COLUMNS: CsvColumn[] = [
  { key: 'scene', header: '场' },
  { key: 'shot', header: '镜' },
  { key: 'action', header: '内容' },
  { key: 'required', header: '必拍状态' },
  { key: 'status', header: '覆盖状态' },
  { key: 'missing', header: '漏拍原因' },
  { key: 'takes', header: '条次数' },
  { key: 'links', header: '关联数' },
  { key: 'confirmed', header: '已确认' },
  { key: 'offline', header: '离线关联' },
  { key: 'flags', header: '提示' },
];

export function coverageRows(coverage: readonly CoverageResult[], refs: readonly ShotRef[]): Row[] {
  const byShot = new Map(coverage.map((c) => [c.shot_id, c] as const));
  const rows: Row[] = [];
  for (const ref of refs) {
    const c = byShot.get(ref.shot.id);
    if (!c) continue;
    rows.push({
      scene: ref.scene_no,
      shot: ref.shot.code,
      action: ref.shot.fields.action,
      required: REQUIRED_LABEL[c.required_status],
      status: COVERAGE_STATUS_LABEL[c.status],
      missing: c.missing_reason ? MISSING_REASON_LABEL[c.missing_reason] : '',
      takes: c.facts.take_count,
      links: c.facts.link_count,
      confirmed: c.facts.confirmed_link_count,
      offline: c.facts.offline_link_count,
      flags: c.flags.map((f) => FLAG_LABEL[f]).join('、'),
    });
  }
  return rows;
}

export function coverageCsv(coverage: readonly CoverageResult[], refs: readonly ShotRef[]): string {
  return toCsv(coverageRows(coverage, refs), COVERAGE_COLUMNS, { bom: true });
}

/** File name stem safe on every OS: "周末短片-场记与素材-2026-09-26". */
export function exportName(project: string, what: string, date: Date = new Date()): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${project}-${what}-${d}`.replace(/[\\/:*?"<>|]+/g, '_');
}

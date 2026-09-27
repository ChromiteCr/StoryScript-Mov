import type {
  CoverageResult,
  MediaAssetView,
  Plan,
  Resource,
  Scene,
  ScheduleBlock,
  Setup,
  Shot,
  ShotMediaLink,
  Take,
} from '@storyscript/contracts';
import { ZH_CAMERA_ANGLE, ZH_LENS_CLASS, ZH_MOVEMENT, ZH_SHOT_SIZE } from '../i18n/zh.ts';
import { utcToLocal } from '../schedule/time.ts';
import { sourceRangeColumns, toCsv, type CsvColumn, type CsvOptions } from './csv.ts';
import {
  CSV_AVAILABILITY_LABEL,
  CSV_BLOCK_KIND_LABEL,
  CSV_COVERAGE_STATUS_LABEL,
  CSV_EVIDENCE_LABEL,
  CSV_FLAG_LABEL,
  CSV_LINK_STATUS_LABEL,
  CSV_MISSING_REASON_LABEL,
  CSV_ORIGIN_LABEL,
  CSV_QUOTE_MATCH_LABEL,
  CSV_RATING_LABEL,
  CSV_REQUIRED_LABEL,
} from './labels.ts';

/**
 * The CSV tables of FR-10 — column definitions and row builders, shared by
 * the browser (plan, set, media and deliver pages) and the server
 * (GET /api/v1/export/csv/:kind), so a file downloaded from either side is
 * byte-for-byte the same for the same data. Pure: every input is passed in.
 *
 *   shots        the shot list in narrative order
 *   callsheet    one row per scheduled block of a plan (idle gaps are screen-only)
 *   takes-media  one row per take × shot × linked clip, source_range as five integer columns
 *   coverage     one row per active shot, status from core computeCoverage (COV)
 *   take log     the pre-filled take-log template of a plan (plan page)
 */

type Row = Record<string, unknown>;

// ------------------------------------------------------------ shot refs

/** A shot with its scene's display number, in narrative order. */
export interface ExportShotRef {
  shot: Shot;
  /** "1" — the scene's display number, "?" when the scene is not in the current script */
  scene_no: string;
  /** sort key in narrative order */
  order: number;
}

/**
 * Active shots in narrative order: scene order (as listed), then
 * narrative_pos, then input order. Shots of scenes outside the list go last
 * with scene number "?". Same order as the set and media pages.
 */
export function exportShotRefs(shots: readonly Shot[], scenes: readonly Pick<Scene, 'id' | 'display_no'>[]): ExportShotRef[] {
  const sceneIndex = new Map(scenes.map((s, i) => [s.id, { scene: s, i }] as const));
  return shots
    .filter((s) => !s.archived)
    .map((shot, idx) => {
      const sc = sceneIndex.get(shot.scene_id);
      return {
        shot,
        scene_no: sc?.scene.display_no ?? '?',
        order: (sc ? sc.i : scenes.length) * 1_000_000 + shot.narrative_pos * 1000 + idx / 1000,
      };
    })
    .sort((a, b) => a.order - b.order);
}

/** Minimal shot reference the row builders read. */
export type ShotRefLike = { shot: Pick<Shot, 'id' | 'code' | 'fields'>; scene_no: string };

// ------------------------------------------------------------ shots

export const SHOT_LIST_COLUMNS: CsvColumn[] = [
  { key: 'scene', header: '场' },
  { key: 'shot', header: '镜' },
  { key: 'size', header: '景别' },
  { key: 'angle', header: '角度' },
  { key: 'lens', header: '镜头' },
  { key: 'focal_mm', header: '焦段mm' },
  { key: 'movement', header: '运镜' },
  { key: 'people', header: '人物' },
  { key: 'action', header: '内容' },
  { key: 'dialogue', header: '对白' },
  { key: 'purpose', header: '叙事目的' },
  { key: 'seconds', header: '预估秒数' },
  { key: 'required', header: '必拍状态' },
  { key: 'requirement_reason', header: '必拍说明' },
  { key: 'locked', header: '锁定' },
  { key: 'origin', header: '来源' },
  { key: 'paragraph', header: '剧本段落' },
  { key: 'quote_match', header: '引用' },
  { key: 'needs_relink', header: '待重新关联' },
  { key: 'revision', header: '修订' },
];

export interface ShotListInput {
  refs: readonly { shot: Shot; scene_no: string }[];
  /** character alias (c1) → display name */
  characterNames?: ReadonlyMap<string, string>;
}

export function shotListRows({ refs, characterNames }: ShotListInput): Row[] {
  return refs.map(({ shot, scene_no }) => {
    const f = shot.fields;
    return {
      scene: scene_no,
      shot: shot.code,
      size: ZH_SHOT_SIZE[f.shot_size],
      angle: ZH_CAMERA_ANGLE[f.angle],
      lens: ZH_LENS_CLASS[f.lens],
      focal_mm: f.focal_mm,
      movement: ZH_MOVEMENT[f.movement],
      people: f.subjects.map((s) => characterNames?.get(s.alias) ?? s.alias).join('、'),
      action: f.action,
      dialogue: f.dialogue_quote ?? '',
      purpose: f.narrative_purpose,
      seconds: f.est_seconds,
      required: CSV_REQUIRED_LABEL[shot.required_status],
      requirement_reason: shot.requirement_reason ?? '',
      locked: shot.locked ? '是' : '',
      origin: CSV_ORIGIN_LABEL[shot.origin],
      paragraph: shot.source_anchor?.paragraph_id ?? f.source.paragraph_id,
      quote_match: shot.source_anchor ? CSV_QUOTE_MATCH_LABEL[shot.source_anchor.match] : '',
      needs_relink: shot.needs_relink ? '是' : '',
      revision: shot.revision,
    };
  });
}

export function shotListCsv(input: ShotListInput, options: CsvOptions = {}): string {
  return toCsv(shotListRows(input), SHOT_LIST_COLUMNS, options);
}

// ------------------------------------------------------------ plan: call sheet + take log

export interface PlanLookup {
  timezone: string;
  /** the plan's local shooting date, YYYY-MM-DD */
  date: string;
  setups: ReadonlyMap<string, Setup>;
  shots: ReadonlyMap<string, Shot>;
  resources: ReadonlyMap<string, Resource>;
  /** scene id → display number ("1", "12A") */
  sceneNos: ReadonlyMap<string, string>;
}

export function buildPlanLookup(input: {
  timezone: string;
  date: string;
  setups: readonly Setup[];
  shots: readonly Shot[];
  resources: readonly Resource[];
  scenes: readonly { id: string; display_no: string }[];
}): PlanLookup {
  return {
    timezone: input.timezone,
    date: input.date,
    setups: new Map(input.setups.map((s) => [s.id, s])),
    shots: new Map(input.shots.map((s) => [s.id, s])),
    resources: new Map(input.resources.map((r) => [r.id, r])),
    sceneNos: new Map(input.scenes.map((s) => [s.id, s.display_no])),
  };
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "09:30" on the plan date, "次日 01:30" after it, "10-04 23:00" before it. */
export function planLocalTime(iso: string, timezone: string, date: string): string {
  const l = utcToLocal(iso, timezone);
  if (l.date === date) return l.time;
  if (l.date === nextDate(date)) return `次日 ${l.time}`;
  return `${l.date.slice(5)} ${l.time}`;
}

export const blockMinutes = (b: Pick<ScheduleBlock, 'start_utc' | 'end_utc'>) => Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60_000);

/** "1-003", or "（已删除）" for a shot no longer in the project. */
export function planShotRef(l: PlanLookup, id: string): string {
  const s = l.shots.get(id);
  if (!s) return '（已删除）';
  return `${l.sceneNos.get(s.scene_id) ?? '?'}-${s.code}`;
}

export interface CallSheetRow {
  block_id: string;
  kind: ScheduleBlock['kind'];
  setup_id: string | null;
  start: string;
  end: string;
  minutes: number;
  kind_label: string;
  setup: string;
  shots: string;
  performers: string;
  location: string;
  equipment: string;
}

export interface IdleRow {
  kind: 'idle';
  start: string;
  end: string;
  minutes: number;
}

const byStart = (a: ScheduleBlock, b: ScheduleBlock) => Date.parse(a.start_utc) - Date.parse(b.start_utc) || (a.id < b.id ? -1 : 1);

function blockRow(b: ScheduleBlock, l: PlanLookup): CallSheetRow {
  const setup = b.setup_id ? l.setups.get(b.setup_id) : undefined;
  const names = (type: Resource['type']) =>
    b.resource_ids
      .map((id) => l.resources.get(id))
      .filter((r): r is Resource => r !== undefined && r.type === type)
      .map((r) => r.name)
      .join('、');
  return {
    block_id: b.id,
    kind: b.kind,
    setup_id: b.setup_id,
    start: planLocalTime(b.start_utc, l.timezone, l.date),
    end: planLocalTime(b.end_utc, l.timezone, l.date),
    minutes: blockMinutes(b),
    kind_label: CSV_BLOCK_KIND_LABEL[b.kind],
    setup: setup?.label ?? '',
    shots: b.shot_ids.map((id) => planShotRef(l, id)).join('、'),
    performers: b.kind === 'shoot' ? names('performer') : '',
    location: names('location'),
    equipment: names('equipment'),
  };
}

/** One row per block in time order, with gaps ≥ 1 min as idle rows (screen/print only). */
export function callSheetRows(plan: Pick<Plan, 'result'>, l: PlanLookup): (CallSheetRow | IdleRow)[] {
  const out: (CallSheetRow | IdleRow)[] = [];
  let cursor: string | null = null;
  for (const b of [...plan.result.blocks].sort(byStart)) {
    if (cursor !== null && Date.parse(b.start_utc) - Date.parse(cursor) >= 60_000) {
      out.push({
        kind: 'idle',
        start: planLocalTime(cursor, l.timezone, l.date),
        end: planLocalTime(b.start_utc, l.timezone, l.date),
        minutes: blockMinutes({ start_utc: cursor, end_utc: b.start_utc }),
      });
    }
    if (cursor === null || Date.parse(b.end_utc) > Date.parse(cursor)) cursor = b.end_utc;
    out.push(blockRow(b, l));
  }
  return out;
}

export const isIdleRow = (r: CallSheetRow | IdleRow): r is IdleRow => r.kind === 'idle';

export const CALL_SHEET_COLUMNS: CsvColumn[] = [
  { key: 'start', header: '开始' },
  { key: 'end', header: '结束' },
  { key: 'minutes', header: '分钟' },
  { key: 'kind_label', header: '类型' },
  { key: 'setup', header: 'setup' },
  { key: 'shots', header: '镜头' },
  { key: 'performers', header: '演员' },
  { key: 'location', header: '场地' },
  { key: 'equipment', header: '设备' },
];

export function callSheetCsv(plan: Pick<Plan, 'result'>, l: PlanLookup, bom: boolean): string {
  const rows = callSheetRows(plan, l).filter((r): r is CallSheetRow => !isIdleRow(r));
  return toCsv(rows as unknown as Row[], CALL_SHEET_COLUMNS, { bom });
}

/**
 * The plan a delivery exports by default: the most recently updated approved
 * plan, else the plan with the latest shooting date (newest created first).
 */
export function exportPlanChoice<P extends Pick<Plan, 'id' | 'date' | 'status' | 'created_at' | 'updated_at'>>(plans: readonly P[]): P | null {
  const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  const approved = plans.filter((p) => p.status === 'approved').sort((a, b) => desc(a.updated_at, b.updated_at));
  if (approved[0]) return approved[0];
  return [...plans].sort((a, b) => desc(a.date, b.date) || desc(a.created_at, b.created_at))[0] ?? null;
}

/** Shots of the plan in shooting order (shoot blocks by start time, setup order inside). */
export function shotsInShootingOrder(plan: Pick<Plan, 'result'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [...plan.result.blocks].filter((x) => x.kind === 'shoot').sort(byStart)) {
    for (const id of b.shot_ids) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export const TAKE_LOG_COLUMNS = ['scene', 'shot', 'take', 'camera', 'roll', 'clip', 'good', 'rating', 'tc_in', 'logged_at', 'notes'] as const;

/** Pre-filled take log: one row per planned shot (shooting order), scene/shot filled, the rest blank. */
export function takeLogCsv(plan: Pick<Plan, 'result'>, l: PlanLookup, bom: boolean): string {
  const rows = shotsInShootingOrder(plan).flatMap((id) => {
    const s = l.shots.get(id);
    return s ? [{ scene: l.sceneNos.get(s.scene_id) ?? '', shot: s.code }] : [];
  });
  return toCsv(
    rows,
    TAKE_LOG_COLUMNS.map((k) => ({ key: k, header: k })),
    { bom },
  );
}

// ------------------------------------------------------------ takes × media

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

/** What a CSV row needs to know about a clip (a MediaAssetView satisfies it). */
export type ExportAsset = Pick<MediaAssetView, 'root_label' | 'rel_path' | 'availability' | 'sha256'>;

export interface TakeMediaInput {
  refs: readonly ShotRefLike[];
  takes: readonly Take[];
  links: readonly ShotMediaLink[];
  assets: ReadonlyMap<string, ExportAsset>;
}

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
      link_status: CSV_LINK_STATUS_LABEL[l.status],
      evidence: CSV_EVIDENCE_LABEL[l.evidence],
      availability: a ? CSV_AVAILABILITY_LABEL[a.availability] : '',
      sha256: a?.sha256 ?? '',
      ...sourceRangeColumns(l.source_range),
    };
  };
  const takeCells = (t: Take): Row => ({
    take: t.take_no,
    camera: t.camera_label ?? '',
    rating: CSV_RATING_LABEL[t.rating],
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

export function takeMediaCsv(input: TakeMediaInput, options: CsvOptions = {}): string {
  return toCsv(takeMediaRows(input), TAKE_MEDIA_COLUMNS, options);
}

// ------------------------------------------------------------ coverage

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

/** One row per shot in `refs` order; `coverage` comes from core computeCoverage (COV). */
export function coverageRows(coverage: readonly CoverageResult[], refs: readonly ShotRefLike[]): Row[] {
  const byShot = new Map(coverage.map((c) => [c.shot_id, c] as const));
  const rows: Row[] = [];
  for (const ref of refs) {
    const c = byShot.get(ref.shot.id);
    if (!c) continue;
    rows.push({
      scene: ref.scene_no,
      shot: ref.shot.code,
      action: ref.shot.fields.action,
      required: CSV_REQUIRED_LABEL[c.required_status],
      status: CSV_COVERAGE_STATUS_LABEL[c.status],
      missing: c.missing_reason ? CSV_MISSING_REASON_LABEL[c.missing_reason] : '',
      takes: c.facts.take_count,
      links: c.facts.link_count,
      confirmed: c.facts.confirmed_link_count,
      offline: c.facts.offline_link_count,
      flags: c.flags.map((f) => CSV_FLAG_LABEL[f]).join('、'),
    });
  }
  return rows;
}

export function coverageCsv(coverage: readonly CoverageResult[], refs: readonly ShotRefLike[], options: CsvOptions = {}): string {
  return toCsv(coverageRows(coverage, refs), COVERAGE_COLUMNS, options);
}

// ------------------------------------------------------------ kinds + names

/** CSV tables the server exports (GET /api/v1/export/csv/:kind). */
export const EXPORT_CSV_KINDS = ['shots', 'callsheet', 'takes-media', 'coverage'] as const;
export type ExportCsvKind = (typeof EXPORT_CSV_KINDS)[number];

export const EXPORT_CSV_TITLE: Record<ExportCsvKind, string> = {
  shots: '镜头表',
  callsheet: '拍摄单',
  'takes-media': '场记与素材',
  coverage: '覆盖状态',
};

export function isExportCsvKind(v: string): v is ExportCsvKind {
  return (EXPORT_CSV_KINDS as readonly string[]).includes(v);
}

/** File name stem safe on every OS: "周末短片-场记与素材-2026-09-26" (date as YYYY-MM-DD). */
export function exportFileStem(project: string, what: string, date: string): string {
  return `${project}-${what}-${date}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
}

import type { Plan, Resource, ScheduleBlock, Setup, Shot } from '@storyscript/contracts';
import { compileSlateFormat, toCsv, utcToLocal, type CsvColumn } from '@storyscript/core';
import { BLOCK_KIND_LABEL } from './labels-plan.ts';

/**
 * Plan exports built in the browser (FR-06 / FR-10): call sheet rows and
 * CSV, slate cards, and the pre-filled take-log CSV template. Pure: every
 * input is passed in, CSV goes through core toCsv (formula-safe, optional BOM).
 */

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

export function buildLookup(input: {
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

/** "09:30" on the plan date, "次日 01:30" after it, "10-04 23:00" before it. */
export function localTime(iso: string, timezone: string, date: string): string {
  const l = utcToLocal(iso, timezone);
  if (l.date === date) return l.time;
  const next = nextDate(date);
  if (l.date === next) return `次日 ${l.time}`;
  return `${l.date.slice(5)} ${l.time}`;
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export const minutesOf = (b: Pick<ScheduleBlock, 'start_utc' | 'end_utc'>) => Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60_000);

export function shotRef(l: PlanLookup, id: string): string {
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

/** One row per block in time order, with gaps ≥ 1 min as idle rows (screen/print only). */
export function callSheetRows(plan: Plan, l: PlanLookup): (CallSheetRow | IdleRow)[] {
  const out: (CallSheetRow | IdleRow)[] = [];
  let cursor: string | null = null;
  for (const b of [...plan.result.blocks].sort(byStart)) {
    if (cursor !== null && Date.parse(b.start_utc) - Date.parse(cursor) >= 60_000) {
      out.push({
        kind: 'idle',
        start: localTime(cursor, l.timezone, l.date),
        end: localTime(b.start_utc, l.timezone, l.date),
        minutes: minutesOf({ start_utc: cursor, end_utc: b.start_utc }),
      });
    }
    if (cursor === null || Date.parse(b.end_utc) > Date.parse(cursor)) cursor = b.end_utc;
    out.push(blockRow(b, l));
  }
  return out;
}

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
    start: localTime(b.start_utc, l.timezone, l.date),
    end: localTime(b.end_utc, l.timezone, l.date),
    minutes: minutesOf(b),
    kind_label: BLOCK_KIND_LABEL[b.kind],
    setup: setup?.label ?? '',
    shots: b.shot_ids.map((id) => shotRef(l, id)).join('、'),
    performers: b.kind === 'shoot' ? names('performer') : '',
    location: names('location'),
    equipment: names('equipment'),
  };
}

export const isIdle = (r: CallSheetRow | IdleRow): r is IdleRow => r.kind === 'idle';

const CALL_SHEET_COLUMNS: CsvColumn[] = [
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

export function callSheetCsv(plan: Plan, l: PlanLookup, bom: boolean): string {
  const rows = callSheetRows(plan, l).filter((r): r is CallSheetRow => !isIdle(r));
  return toCsv(rows as unknown as Record<string, unknown>[], CALL_SHEET_COLUMNS, { bom });
}

/** Shots of the plan in shooting order (shoot blocks by start time, setup order inside). */
export function shotsInShootingOrder(plan: Plan): string[] {
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

// ------------------------------------------------------------------ slates ---

/** Leading number of a scene display number: "12A" → 12. */
export function sceneNumber(displayNo: string): number | null {
  const m = /\d+/.exec(displayNo);
  return m ? Number.parseInt(m[0], 10) : null;
}

/** Trailing number of a shot code: "003" → 3, "A12" → 12. */
export function shotNumber(code: string): number | null {
  const m = /(\d+)\s*$/.exec(code);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * Slate code with the take left blank for handwriting, e.g. "S01-003-T__"
 * for "S{scene:02}-{shot:03}-T{take:02}". Null when the format is invalid
 * or the numbers cannot be read.
 */
export function slateCodeBlankTake(format: string, scene: number | null, shot: number | null): string | null {
  if (scene === null || shot === null) return null;
  const compiled = compileSlateFormat(format);
  if (!compiled.ok) return null;
  let out = '';
  for (const t of compiled.tokens) {
    if (t.kind !== 'field') out += t.text;
    else if (t.name === 'take') out += '_'.repeat(Math.max(2, t.width));
    else out += String(t.name === 'scene' ? scene : shot).padStart(t.width, '0');
  }
  return out;
}

export interface SlateCard {
  shot_id: string;
  scene: string;
  shot: string;
  /** formatted slate code with a blank take, null when it cannot be formatted */
  code: string | null;
  setup: string;
  description: string;
}

export function slateCards(plan: Plan, l: PlanLookup, codeFormat: string): SlateCard[] {
  return shotsInShootingOrder(plan).flatMap((id) => {
    const s = l.shots.get(id);
    if (!s) return [];
    const sceneNo = l.sceneNos.get(s.scene_id) ?? '?';
    const setup = s.setup_id ? l.setups.get(s.setup_id) : undefined;
    return [
      {
        shot_id: id,
        scene: sceneNo,
        shot: s.code,
        code: slateCodeBlankTake(codeFormat, sceneNumber(sceneNo), shotNumber(s.code)),
        setup: setup?.label ?? '',
        description: s.fields.action,
      },
    ];
  });
}

// --------------------------------------------------------- take log (CSV) ---

export const TAKE_LOG_COLUMNS = ['scene', 'shot', 'take', 'camera', 'roll', 'clip', 'good', 'rating', 'tc_in', 'logged_at', 'notes'] as const;

/** Pre-filled take log: one row per planned shot (shooting order), scene/shot filled, the rest blank. */
export function takeLogCsv(plan: Plan, l: PlanLookup, bom: boolean): string {
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

export function exportFileName(kind: '拍摄单' | '场记模板', date: string): string {
  return `${kind}-${date}.csv`;
}

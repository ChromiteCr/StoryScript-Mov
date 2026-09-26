import type { Plan } from '@storyscript/contracts';
import { compileSlateFormat, shotsInShootingOrder, type PlanLookup } from '@storyscript/core';

/**
 * Plan exports built in the browser (FR-06 / FR-10): call sheet rows and
 * CSV, slate cards, and the pre-filled take-log CSV template. Pure: every
 * input is passed in. The CSV tables (columns and row builders) live in
 * core/export so the server's /api/v1/export/csv/callsheet writes the same
 * file; they are re-exported here under the page's names.
 */

export {
  buildPlanLookup as buildLookup,
  planLocalTime as localTime,
  blockMinutes as minutesOf,
  planShotRef as shotRef,
  callSheetRows,
  isIdleRow as isIdle,
  callSheetCsv,
  shotsInShootingOrder,
  TAKE_LOG_COLUMNS,
  takeLogCsv,
  type PlanLookup,
  type CallSheetRow,
  type IdleRow,
} from '@storyscript/core';

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

export function exportFileName(kind: '拍摄单' | '场记模板', date: string): string {
  return `${kind}-${date}.csv`;
}

import type { Paragraph, Scene, Shot, ShotFields, ShotSubject } from '@storyscript/contracts';
import { SHOT_FIELD_LABEL } from './labels.ts';
import { stableKey } from './stable.ts';

/** Pure helpers for the shot table. No DOM. */

export function byNarrative(a: Shot, b: Shot): number {
  return a.narrative_pos - b.narrative_pos || a.created_at.localeCompare(b.created_at);
}

/** Shots grouped by scene id, each group in narrative order. */
export function groupShotsByScene(shots: readonly Shot[]): Map<string, Shot[]> {
  const out = new Map<string, Shot[]>();
  for (const s of shots) {
    const list = out.get(s.scene_id);
    if (list) list.push(s);
    else out.set(s.scene_id, [s]);
  }
  for (const list of out.values()) list.sort(byNarrative);
  return out;
}

/** Move one id within an ordered list; returns a new list (unchanged when out of range). */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/**
 * Id list for PUT /shots/narrative-order: exactly the scene's live shots in
 * the new order (the server rejects the list unless it is precisely the set
 * of unarchived shots of the scene). Ids not in the scene are dropped, live
 * shots missing from `liveOrder` keep their relative order at the end.
 */
export function narrativeOrderIds(sceneShots: readonly Shot[], liveOrder: readonly string[]): string[] {
  const live = sceneShots.filter((s) => !s.archived).sort(byNarrative);
  const liveIds = new Set(live.map((s) => s.id));
  const ordered = liveOrder.filter((id, i) => liveIds.has(id) && liveOrder.indexOf(id) === i);
  const seen = new Set(ordered);
  return [...ordered, ...live.filter((s) => !seen.has(s.id)).map((s) => s.id)];
}

/** Apply a new order locally (optimistic update) by rewriting narrative_pos. */
export function reorderLocally(all: readonly Shot[], orderedIds: readonly string[]): Shot[] {
  const pos = new Map(orderedIds.map((id, i) => [id, i + 1] as const));
  return all.map((s) => {
    const p = pos.get(s.id);
    return p === undefined ? s : { ...s, narrative_pos: p };
  });
}

/** Replace shots in a cached list by id, appending unknown ones. */
export function mergeShots(all: readonly Shot[] | undefined, updated: readonly Shot[]): Shot[] {
  const byId = new Map(updated.map((s) => [s.id, s] as const));
  const seen = new Set<string>();
  const out = (all ?? []).map((s) => {
    const u = byId.get(s.id);
    if (u) seen.add(s.id);
    return u ?? s;
  });
  for (const u of updated) if (!seen.has(u.id)) out.push(u);
  return out;
}

export type SourceState =
  | { kind: 'relink' }
  | { kind: 'manual'; paragraphId: string | null; quote: string | null }
  | { kind: 'anchored'; paragraphId: string; quote: string; match: 'exact' | 'fuzzy' | 'manual' }
  | { kind: 'none' };

/** What the "来源" cell shows for a shot. */
export function sourceState(shot: Shot): SourceState {
  if (shot.needs_relink) return { kind: 'relink' };
  const a = shot.source_anchor;
  if (shot.origin === 'manual' || a?.match === 'manual') {
    const q = a?.quote.trim() ? a.quote : null;
    return { kind: 'manual', paragraphId: q ? (a?.paragraph_id ?? null) : null, quote: q };
  }
  if (a) return { kind: 'anchored', paragraphId: a.paragraph_id, quote: a.quote, match: a.match };
  return { kind: 'none' };
}

/**
 * Paragraph to highlight for a source anchor: the same id when the anchor is
 * on the current version, else the first paragraph that contains the quote.
 */
export function locateParagraph(
  paragraphs: readonly Pick<Paragraph, 'id' | 'text'>[],
  anchor: { paragraph_id: string; quote: string; script_version_id?: string } | null,
  currentVersionId: string,
): string | null {
  if (!anchor) return null;
  const quote = anchor.quote.trim();
  if (anchor.script_version_id === undefined || anchor.script_version_id === currentVersionId) {
    if (paragraphs.some((p) => p.id === anchor.paragraph_id)) return anchor.paragraph_id;
  }
  if (!quote) return null;
  return paragraphs.find((p) => p.text.includes(quote))?.id ?? null;
}

/** Split paragraph text around the first occurrence of `quote` for <mark>. */
export function splitAroundQuote(text: string, quote: string | null): [string, string, string] | null {
  const q = quote?.trim();
  if (!q) return null;
  const i = text.indexOf(q);
  if (i < 0) return null;
  return [text.slice(0, i), q, text.slice(i + q.length)];
}

/** Default fields for a new manual shot in `scene`. */
export function emptyShotFields(scene: Pick<Scene, 'paragraph_ids'>): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: [],
    props: [],
    env: null,
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 3,
    narrative_purpose: '',
    action: '',
    dialogue_quote: null,
    source: { paragraph_id: scene.paragraph_ids[0] ?? 'p-001', quote: '' },
    assumptions: [],
    questions: [],
  };
}

export function emptySubject(alias: string): ShotSubject {
  return { alias, screen: null, depth: null, facing: null, pose: null };
}

/** ShotFields keys that differ between two revisions (label order, see SHOT_FIELD_LABEL). */
export function changedFieldKeys(prev: ShotFields | null, next: ShotFields): (keyof ShotFields)[] {
  if (!prev) return [];
  // camera_notes / object_name: a missing key, null and '' all mean "none"; a subject's
  // emotion: missing and null both mean "read from the action" (S5b)
  const val = (f: ShotFields, k: keyof ShotFields): unknown =>
    k === 'camera_notes'
      ? f.camera_notes?.trim() || null
      : k === 'object_name'
        ? f.object_name?.trim() || null
        : k === 'subjects'
          ? f.subjects.map(({ emotion, ...rest }) => (emotion ? { ...rest, emotion } : rest))
          : f[k];
  return (Object.keys(SHOT_FIELD_LABEL) as (keyof ShotFields)[]).filter((k) => stableKey(val(prev, k)) !== stableKey(val(next, k)));
}

/** Names of ShotFields keys that differ between two revisions. */
export function changedFieldLabels(prev: ShotFields | null, next: ShotFields): string[] {
  return changedFieldKeys(prev, next).map((k) => SHOT_FIELD_LABEL[k]);
}

/** Lines of a textarea list editor → trimmed, non-empty items. */
export function linesToList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface NumberParse {
  value: number | null;
  error: string | null;
}

/** "" → null (when allowed); "35" → 35; anything else → error. */
export function parseNumberField(raw: string, opts: { allowEmpty: boolean; min?: number; max?: number; label: string }): NumberParse {
  const t = raw.trim();
  if (t === '') return opts.allowEmpty ? { value: null, error: null } : { value: null, error: `请填写${opts.label}` };
  const n = Number(t);
  if (!Number.isFinite(n)) return { value: null, error: `${opts.label}需要是数字` };
  if (opts.min !== undefined && n < opts.min) return { value: null, error: `${opts.label}不能小于 ${opts.min}` };
  if (opts.max !== undefined && n > opts.max) return { value: null, error: `${opts.label}不能大于 ${opts.max}` };
  return { value: n, error: null };
}

/** Shot.revision as shown to people: 0 is the version as created. */
export function revisionLabel(revision: number): string {
  return revision === 0 ? '初版' : `修订 ${revision}`;
}

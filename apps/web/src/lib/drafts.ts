import {
  BreakdownOutput,
  EntitiesOutput,
  type DraftDetail,
  type DraftIssue,
  type EntityType,
  type Shot,
  type ShotDraft,
  type ShotFields,
} from '@storyscript/contracts';
import type { InputOf } from './api.ts';

/**
 * Pure helpers for AI drafts (INV-03: AI output lives in shot_draft until
 * apply). No DOM, no fetch.
 *
 * `ShotDraft.parsed` is `unknown` in the contract, so the shapes below are
 * read defensively: BreakdownOutput / EntitiesOutput via the contract schemas,
 * plus an optional per-item quote match level that the server may attach
 * (see `quoteMatchOf`).
 */

export type ItemMatch = 'exact' | 'fuzzy' | 'rejected';

export interface ClaimFlagView {
  item: number | null;
  kind: string;
  text: string;
}

export interface BreakdownItem {
  index: number;
  fields: ShotFields;
  match: ItemMatch | null;
  issues: DraftIssue[];
  claims: ClaimFlagView[];
  selectable: boolean;
  /** why the checkbox is disabled, for the tooltip */
  blockedReason: string | null;
}

export type BreakdownParse =
  | { ok: true; items: BreakdownItem[]; draftIssues: DraftIssue[]; draftClaims: ClaimFlagView[] }
  | { ok: false; draftIssues: DraftIssue[]; draftClaims: ClaimFlagView[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asMatch(v: unknown): ItemMatch | null {
  return v === 'exact' || v === 'fuzzy' || v === 'rejected' ? v : null;
}

/**
 * Quote match level of item `i`, from whichever place the server put it:
 * `parsed.shots[i].match | quote_match`, `parsed.matches[i] | quote_matches[i]`,
 * or an issue about the quote on that item (code mentioning fuzzy/reject).
 */
export function quoteMatchOf(parsed: unknown, i: number, issues: readonly DraftIssue[]): ItemMatch | null {
  if (isRecord(parsed)) {
    const shots = parsed.shots;
    if (Array.isArray(shots) && isRecord(shots[i])) {
      const s = shots[i] as Record<string, unknown>;
      const m = asMatch(s.match) ?? asMatch(s.quote_match) ?? (isRecord(s.source) ? asMatch(s.source.match) : null);
      if (m) return m;
    }
    for (const key of ['matches', 'quote_matches'] as const) {
      const arr = parsed[key];
      if (Array.isArray(arr)) {
        const m = asMatch(arr[i]);
        if (m) return m;
      }
    }
  }
  const own = issues.filter((x) => x.item === i);
  if (own.some((x) => /reject/i.test(x.code))) return 'rejected';
  if (own.some((x) => /fuzzy/i.test(x.code))) return 'fuzzy';
  if (own.some((x) => /exact/i.test(x.code))) return 'exact';
  return null;
}

/** INV-03 / FR-03: an item with any error-level issue (or a rejected quote) can never be applied. */
export function isItemSelectable(item: Pick<BreakdownItem, 'issues' | 'match'>): boolean {
  if (item.match === 'rejected') return false;
  return !item.issues.some((x) => x.level === 'error');
}

function blockedReasonOf(item: Pick<BreakdownItem, 'issues' | 'match'>): string | null {
  const err = item.issues.find((x) => x.level === 'error');
  if (err) return `有错误，不能应用：${err.message}`;
  if (item.match === 'rejected') return '引用原文在剧本里找不到，不能应用';
  return null;
}

export function parseBreakdownDraft(draft: Pick<ShotDraft, 'parsed' | 'issues'>, claims: DraftDetail['claim_flags'] = []): BreakdownParse {
  const draftIssues = draft.issues.filter((x) => x.item === null);
  const draftClaims = claims.filter((c) => c.item === null);
  const parsed = BreakdownOutput.safeParse(draft.parsed);
  if (!parsed.success) return { ok: false, draftIssues: draft.issues, draftClaims: claims };
  const items = parsed.data.shots.map((fields, index): BreakdownItem => {
    const issues = draft.issues.filter((x) => x.item === index);
    const match = quoteMatchOf(draft.parsed, index, draft.issues);
    const base = { issues, match };
    return {
      index,
      fields,
      match,
      issues,
      claims: claims.filter((c) => c.item === index),
      selectable: isItemSelectable(base),
      blockedReason: blockedReasonOf(base),
    };
  });
  return { ok: true, items, draftIssues, draftClaims };
}

/** Default ticks: every selectable item except fuzzy quotes, which the user confirms by hand. */
export function defaultSelection(items: readonly BreakdownItem[]): Set<number> {
  return new Set(items.filter((i) => i.selectable && i.match !== 'fuzzy').map((i) => i.index));
}

/** Toggle one index; unselectable items are never added. */
export function toggleSelection(selected: ReadonlySet<number>, item: Pick<BreakdownItem, 'index' | 'selectable'>): Set<number> {
  const next = new Set(selected);
  if (next.has(item.index)) next.delete(item.index);
  else if (item.selectable) next.add(item.index);
  return next;
}

/** Existing shots an apply with `replace_existing` would archive: unlocked, live, AI-made. */
export function archiveCandidates(currentShots: readonly Shot[]): Shot[] {
  return currentShots.filter((s) => !s.archived && !s.locked && s.origin === 'ai');
}

export type ApplyBreakdownBody = InputOf<'applyBreakdown'>;

/**
 * Request body for POST /drafts/:id/apply. `expected_revisions` carries the
 * revision of every shot that may be archived, so a concurrent edit to any of
 * them returns 409 instead of being silently archived (INV-03).
 * Unselectable indices are dropped defensively.
 */
export function buildApplyBreakdownInput(args: {
  items: readonly Pick<BreakdownItem, 'index' | 'selectable'>[];
  selected: ReadonlySet<number>;
  replaceExisting: boolean;
  currentShots: readonly Shot[];
}): ApplyBreakdownBody {
  const allowed = new Set(args.items.filter((i) => i.selectable).map((i) => i.index));
  const selected = [...args.selected].filter((i) => allowed.has(i)).sort((a, b) => a - b);
  const expected_revisions: Record<string, number> = {};
  if (args.replaceExisting) {
    for (const s of archiveCandidates(args.currentShots)) expected_revisions[s.id] = s.revision;
  }
  return { selected, replace_existing: args.replaceExisting, expected_revisions };
}

/** How many live shots stay in the scene after apply (locked and manual ones always stay). */
export function keptShotCount(currentShots: readonly Shot[], replaceExisting: boolean): number {
  const live = currentShots.filter((s) => !s.archived);
  return replaceExisting ? live.length - archiveCandidates(live).length : live.length;
}

/**
 * Tentative display code for a new shot, derived from the project's slate
 * `code_format` without its take part: "S{scene:02}-{shot:03}-T{take:02}" →
 * "S03-005". The server assigns the real code on apply.
 */
export function previewShotCode(codeFormat: string, sceneDisplayNo: string, shotNo: number): string {
  const takeAt = codeFormat.search(/[^{}]*\{take(?::\d+)?\}/);
  let fmt = takeAt >= 0 ? codeFormat.slice(0, takeAt) : codeFormat;
  fmt = fmt.replace(/[-_\s.]+$/, '');
  if (!/\{shot(?::\d+)?\}/.test(fmt)) fmt = '{scene}-{shot:02}';
  const pad = (v: string | number, width: string | undefined) => {
    const s = String(v);
    const w = width ? Number(width) : 0;
    return /^\d+$/.test(s) ? s.padStart(w, '0') : s;
  };
  return fmt
    .replace(/\{scene(?::(\d+))?\}/g, (_m, w: string | undefined) => pad(sceneDisplayNo, w))
    .replace(/\{shot(?::(\d+))?\}/g, (_m, w: string | undefined) => pad(shotNo, w));
}

// ---------------------------------------------------------------- entities --

export type EntityDraftKind = 'characters' | 'locations' | 'props';

export const ENTITY_DRAFT_KINDS: readonly EntityDraftKind[] = ['characters', 'locations', 'props'];

export const ENTITY_KIND_TYPE: Record<EntityDraftKind, EntityType> = {
  characters: 'character',
  locations: 'location',
  props: 'prop',
};

export interface EntityDraftRow {
  kind: EntityDraftKind;
  index: number;
  name: string;
  aliases: string[];
  selected: boolean;
  /** an entity of the same type already has this name or alias */
  duplicateOf: string | null;
}

export function parseEntityDraft(
  draft: Pick<ShotDraft, 'parsed'>,
  existing: readonly { type: EntityType; name: string; aliases: string[]; alias: string }[],
): EntityDraftRow[] | null {
  const parsed = EntitiesOutput.safeParse(draft.parsed);
  if (!parsed.success) return null;
  const rows: EntityDraftRow[] = [];
  for (const kind of ENTITY_DRAFT_KINDS) {
    parsed.data[kind].forEach((e, index) => {
      const type = ENTITY_KIND_TYPE[kind];
      const names = [e.name, ...e.aliases].map((n) => n.trim()).filter(Boolean);
      const dup = existing.find((x) => x.type === type && [x.name, ...x.aliases].some((n) => names.includes(n.trim())));
      rows.push({
        kind,
        index,
        name: e.name.trim(),
        aliases: e.aliases.map((a) => a.trim()).filter(Boolean),
        selected: dup === undefined && e.name.trim() !== '',
        duplicateOf: dup ? `${dup.alias} ${dup.name}` : null,
      });
    });
  }
  return rows;
}

export function buildEntitySelection(rows: readonly EntityDraftRow[]): InputOf<'applyEntityDraft'> {
  return {
    items: rows
      .filter((r) => r.selected && r.name.trim() !== '')
      .map((r) => ({ kind: r.kind, index: r.index, name: r.name.trim(), aliases: r.aliases.map((a) => a.trim()).filter(Boolean) })),
  };
}

/** "老周、周先生" / "老周, 周先生" → ["老周", "周先生"] */
export function parseAliasInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\n]/)) {
    const t = part.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function formatAliases(aliases: readonly string[]): string {
  return aliases.join('、');
}

/** Scene id of a breakdown draft, from its free-form scope. */
export function draftSceneId(draft: Pick<ShotDraft, 'scope'>): string | null {
  const v = draft.scope.scene_id;
  return typeof v === 'string' ? v : null;
}

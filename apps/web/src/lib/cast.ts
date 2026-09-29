import { ACTOR_NAME_MAX, type CastApplyInput, type CastSuggestion, type CastSyncChange, type TimeWindow } from '@storyscript/contracts';
import type { LocalWindow } from '../views/plan/data.ts';

/**
 * S3b web logic, pure: what the 填入演员 dialog starts with and sends, and how
 * the plan's 同步 dialog groups the server's preview. Names are only ever
 * shown here and in the plan; nothing in this file leaves the machine.
 */

const CHARACTER_NAME_MAX = 40;

// ------------------------------------------------------------ cast list ---

/** What one row of the 填入演员 dialog holds while it is open. */
export interface CastRowState {
  checked: boolean;
  /** the actor, editable */
  actor: string;
  /** a line with no character: the name of the character to create, editable */
  newName: string;
}

/**
 * Lines that already match a character and are not filled in yet start
 * checked. A line with no character would create one, so it starts unchecked;
 * a line that is already filled in has nothing to do.
 */
export function defaultCastRows(list: readonly CastSuggestion[]): CastRowState[] {
  return list.map((s) => ({ checked: !s.current && s.match !== 'none', actor: s.actor_name, newName: s.character_label }));
}

/** Lines that still need filling in (the banner counts these). */
/**
 * Characters the dialog can still fill in: lines with no matching character
 * (crew, a role the script lacks) are not counted, and a character counts once.
 */
export function pendingCastCount(list: readonly CastSuggestion[]): number {
  const open = new Set<string>();
  for (const s of list) {
    if (s.current || s.match === 'none') continue;
    open.add(castTargetName(s));
  }
  return open.size;
}

/** The character the actor goes to: a split alias becomes its own character. */
export function castTargetName(s: CastSuggestion): string {
  return s.split_alias ?? s.entity_name ?? s.character_label;
}

/** The tag beside a line, or null when the match is exact and there is nothing to say. */
export function castMatchNote(s: CastSuggestion): string | null {
  if (s.match === 'exact') return null;
  if (s.match === 'none') return '没有这个角色';
  if (s.split_alias) return `拆成新角色「${s.split_alias}」`;
  return s.match === 'alias' ? `别名：写的是「${s.character_label}」` : `近似：写的是「${s.character_label}」`;
}

/** Why a ticked row cannot be applied yet (null: fine, or not ticked). */
export function castRowProblem(s: CastSuggestion, row: CastRowState): string | null {
  if (!row.checked || s.current) return null;
  const actor = row.actor.trim();
  if (actor === '') return '请填写演员姓名';
  if (actor.length > ACTOR_NAME_MAX) return `演员姓名不超过 ${ACTOR_NAME_MAX} 个字`;
  if (s.entity_id === null) {
    const name = row.newName.trim();
    if (name === '') return '请填写新角色的名字';
    if (name.length > CHARACTER_NAME_MAX) return `角色名不超过 ${CHARACTER_NAME_MAX} 个字`;
  }
  return null;
}

export interface CastSelection {
  items: CastApplyInput['items'];
  /** ticked rows that are not complete */
  problems: number;
}

/** The request body for the ticked rows, in list order; incomplete rows are counted, not sent. */
export function castSelection(list: readonly CastSuggestion[], rows: readonly CastRowState[]): CastSelection {
  const items: CastApplyInput['items'] = [];
  let problems = 0;
  list.forEach((s, i) => {
    const row = rows[i];
    if (!row || s.current || !row.checked) return;
    if (castRowProblem(s, row)) {
      problems += 1;
      return;
    }
    items.push({
      entity_id: s.entity_id,
      actor_name: row.actor.trim(),
      split_alias: s.split_alias,
      new_character_name: s.entity_id === null ? row.newName.trim() : null,
    });
  });
  return { items, problems };
}

// ------------------------------------------------------------ plan sync ---

export interface CastPerson {
  /** the performer's name */
  name: string;
  /** characters, in the order the preview lists them */
  characters: string[];
}

export interface CastMove {
  character: string;
  /** the performer who played it until now */
  from: string;
  /** the performer who plays it now */
  to: string;
}

export interface CastPlace {
  /** the location resource (new, or the one that gets the location added) */
  resource: string;
  /** the script's location */
  location: string;
  isNew: boolean;
}

export interface CastSyncGroups {
  /** create_performer: performers the plan does not have yet */
  newPerformers: CastPerson[];
  /** add_cast on a performer: an existing performer takes one more character */
  addedRoles: CastPerson[];
  /** move_cast: the script gives the character to someone else */
  moved: CastMove[];
  /** create_location, and add_cast on a location resource */
  places: CastPlace[];
}

/** A change about a location, not a performer. `locationIds` are the script's location entities. */
export function isPlaceChange(c: CastSyncChange, locationIds: ReadonlySet<string>): boolean {
  return c.kind === 'create_location' || (c.kind === 'add_cast' && locationIds.has(c.entity_id));
}

function personFor(list: CastPerson[], name: string): CastPerson {
  let p = list.find((x) => x.name === name);
  if (!p) {
    p = { name, characters: [] };
    list.push(p);
  }
  return p;
}

/** Group the preview for reading; one performer appears once however many characters they get. */
export function groupCastSync(changes: readonly CastSyncChange[], locationIds: ReadonlySet<string>): CastSyncGroups {
  const out: CastSyncGroups = { newPerformers: [], addedRoles: [], moved: [], places: [] };
  for (const c of changes) {
    if (isPlaceChange(c, locationIds)) {
      out.places.push({ resource: c.resource_name, location: c.entity_name, isNew: c.kind === 'create_location' });
    } else if (c.kind === 'create_performer') {
      const p = personFor(out.newPerformers, c.resource_name);
      if (!p.characters.includes(c.entity_name)) p.characters.push(c.entity_name);
    } else if (c.kind === 'add_cast') {
      const p = personFor(out.addedRoles, c.resource_name);
      if (!p.characters.includes(c.entity_name)) p.characters.push(c.entity_name);
    } else if (c.kind === 'move_cast') {
      out.moved.push({ character: c.entity_name, from: c.from_resource_name ?? '原演员', to: c.resource_name });
    }
  }
  return out;
}

/** The changes that will be applied: everything, or everything but the locations. */
export function appliedChanges(changes: readonly CastSyncChange[], locationIds: ReadonlySet<string>, includeLocations: boolean): CastSyncChange[] {
  return includeLocations ? [...changes] : changes.filter((c) => !isPlaceChange(c, locationIds));
}

/** Performers and locations the sync would create (each once); those get the availability the user sets. */
export function newResourceNames(changes: readonly CastSyncChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const key = `${c.kind === 'create_location' ? 'l' : 'p'}:${c.resource_name}`;
    if (c.resource_id === null && !out.includes(key)) out.push(key);
  }
  return out.map((k) => k.slice(2));
}

/** Availability the new performers and locations start with: the plan's date, 08:00–20:00. */
export function defaultSyncWindow(refDate: string): LocalWindow {
  return { date: refDate, start: '08:00', end: '20:00' };
}

/** The request body. An empty window list would mean "never available", so one window always goes. */
export function buildCastSyncInput(v: { hash: string; includeLocations: boolean; window: TimeWindow; confirmed: boolean }) {
  return { hash: v.hash, include_locations: v.includeLocations, windows: [v.window], confirmed: v.confirmed };
}

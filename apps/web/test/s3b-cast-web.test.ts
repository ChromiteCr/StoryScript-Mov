import { describe, expect, it } from 'vitest';
import type { CastSuggestion, CastSyncChange } from '@storyscript/contracts';
import {
  appliedChanges,
  buildCastSyncInput,
  castMatchNote,
  castRowProblem,
  castSelection,
  castTargetName,
  defaultCastRows,
  defaultSyncWindow,
  groupCastSync,
  isPlaceChange,
  newResourceNames,
  pendingCastCount,
} from '../src/lib/cast.ts';
import { fromLocalWindow, toLocalWindow } from '../src/views/plan/data.ts';
import { uuid } from './fixtures.ts';

// S3b web logic: which cast-list lines start ticked, what the apply request
// carries, and how the plan's sync preview is grouped for reading. Names are
// made up.

const CHAR_A = uuid();
const CHAR_B = uuid();
const PLACE = uuid();
const PLACE_2 = uuid();

const line = (over: Partial<CastSuggestion>): CastSuggestion => ({
  line: '周远：裴明远：主角',
  actor_name: '周远',
  character_label: '裴明远',
  entity_id: CHAR_A,
  entity_name: '裴明远',
  match: 'exact',
  split_alias: null,
  current: false,
  ...over,
});

const LIST: CastSuggestion[] = [
  line({}),
  line({ line: '孙晴：林川长大后', actor_name: '孙晴', character_label: '林川长大后', entity_id: CHAR_B, entity_name: '林川', match: 'alias', split_alias: '林川长大后' }),
  line({ line: '沈乐：林川的母亲', actor_name: '沈乐', character_label: '林川的母亲', entity_id: null, entity_name: null, match: 'none' }),
  line({ line: '安老师：裴明远', actor_name: '安老师', match: 'near', character_label: '裴明源' }),
  line({ line: '林川：吴桐', actor_name: '吴桐', character_label: '林川', entity_id: CHAR_B, entity_name: '林川', current: true }),
];

describe('cast list rows', () => {
  it('start ticked when they match a character and are not filled in; a line with no character starts unticked', () => {
    expect(defaultCastRows(LIST).map((r) => r.checked)).toEqual([true, true, false, true, false]);
  });

  it('start with the actor as written and the character label as the new name', () => {
    const rows = defaultCastRows(LIST);
    expect(rows[2]).toEqual({ checked: false, actor: '沈乐', newName: '林川的母亲' });
  });

  it('count the characters that can still be filled in (not lines; no-character lines excluded)', () => {
    // 裴明远 (two lines, counted once) and 林川长大后; the 林川的母亲 line has no character
    expect(pendingCastCount(LIST)).toBe(2);
    expect(pendingCastCount([LIST[4]!])).toBe(0);
    expect(pendingCastCount([])).toBe(0);
  });

  it('say how the line was matched: nothing for an exact match', () => {
    expect(castMatchNote(LIST[0]!)).toBeNull();
    expect(castMatchNote(LIST[1]!)).toBe('拆成新角色「林川长大后」');
    expect(castMatchNote(LIST[2]!)).toBe('没有这个角色');
    expect(castMatchNote(LIST[3]!)).toBe('近似：写的是「裴明源」');
    expect(castMatchNote(line({ match: 'alias', character_label: '老裴' }))).toBe('别名：写的是「老裴」');
  });

  it('name the character the actor goes to', () => {
    expect(castTargetName(LIST[0]!)).toBe('裴明远');
    expect(castTargetName(LIST[1]!)).toBe('林川长大后');
    expect(castTargetName(LIST[2]!)).toBe('林川的母亲');
  });
});

describe('cast apply request', () => {
  it('sends the ticked rows in list order; a split keeps the alias, a new character carries its name', () => {
    const rows = defaultCastRows(LIST);
    rows[2] = { ...rows[2]!, checked: true, newName: '林母' };
    expect(castSelection(LIST, rows)).toEqual({
      problems: 0,
      items: [
        { entity_id: CHAR_A, actor_name: '周远', split_alias: null, new_character_name: null },
        { entity_id: CHAR_B, actor_name: '孙晴', split_alias: '林川长大后', new_character_name: null },
        { entity_id: null, actor_name: '沈乐', split_alias: null, new_character_name: '林母' },
        { entity_id: CHAR_A, actor_name: '安老师', split_alias: null, new_character_name: null },
      ],
    });
  });

  it('sends the edited actor, trimmed', () => {
    const rows = defaultCastRows(LIST);
    rows[0] = { ...rows[0]!, actor: '  周 远 ' };
    expect(castSelection(LIST, rows).items[0]!.actor_name).toBe('周 远');
  });

  it('never sends unticked rows or lines that are already filled in, even if ticked', () => {
    const rows = defaultCastRows(LIST).map((r) => ({ ...r, checked: false }));
    expect(castSelection(LIST, rows)).toEqual({ items: [], problems: 0 });
    rows[4] = { ...rows[4]!, checked: true };
    expect(castSelection(LIST, rows).items).toEqual([]);
  });

  it('counts an incomplete ticked row instead of sending it', () => {
    const rows = defaultCastRows(LIST);
    rows[0] = { ...rows[0]!, actor: '   ' };
    rows[2] = { ...rows[2]!, checked: true, newName: '' };
    const sel = castSelection(LIST, rows);
    expect(sel.problems).toBe(2);
    expect(sel.items.map((i) => i.actor_name)).toEqual(['孙晴', '安老师']);
    expect(castRowProblem(LIST[0]!, rows[0]!)).toBe('请填写演员姓名');
    expect(castRowProblem(LIST[2]!, rows[2]!)).toBe('请填写新角色的名字');
  });

  it('limits the actor name to 40 characters and ignores rows that are not ticked', () => {
    const rows = defaultCastRows(LIST);
    rows[0] = { ...rows[0]!, actor: '演'.repeat(41) };
    expect(castRowProblem(LIST[0]!, rows[0]!)).toBe('演员姓名不超过 40 个字');
    expect(castRowProblem(LIST[2]!, { checked: false, actor: '', newName: '' })).toBeNull();
  });
});

const change = (over: Partial<CastSyncChange>): CastSyncChange => ({
  kind: 'create_performer',
  resource_id: null,
  resource_name: '孙晴',
  entity_id: CHAR_B,
  entity_name: '林川',
  from_resource_id: null,
  from_resource_name: null,
  ...over,
});

const PERFORMER = uuid();
const OLD_PERFORMER = uuid();
const PLACE_RESOURCE = uuid();
const LOCATIONS = new Set([PLACE, PLACE_2]);

const CHANGES: CastSyncChange[] = [
  change({}),
  change({ resource_name: '孙晴', entity_id: uuid(), entity_name: '苏禾' }),
  change({ resource_name: '周远', entity_id: CHAR_A, entity_name: '裴明远', kind: 'create_performer' }),
  change({ kind: 'add_cast', resource_id: PERFORMER, resource_name: '沈乐', entity_id: uuid(), entity_name: '林母' }),
  change({ kind: 'move_cast', resource_id: null, resource_name: '吴桐', entity_id: uuid(), entity_name: '老师', from_resource_id: OLD_PERFORMER, from_resource_name: '张三' }),
  change({ kind: 'create_location', resource_name: '教室', entity_id: PLACE, entity_name: '教室' }),
  change({ kind: 'add_cast', resource_id: PLACE_RESOURCE, resource_name: '校园', entity_id: PLACE_2, entity_name: '操场' }),
];

describe('cast sync preview', () => {
  it('groups by kind; a new performer appears once with all their characters', () => {
    const g = groupCastSync(CHANGES, LOCATIONS);
    expect(g.newPerformers).toEqual([
      { name: '孙晴', characters: ['林川', '苏禾'] },
      { name: '周远', characters: ['裴明远'] },
    ]);
    expect(g.addedRoles).toEqual([{ name: '沈乐', characters: ['林母'] }]);
    expect(g.moved).toEqual([{ character: '老师', from: '张三', to: '吴桐' }]);
    expect(g.places).toEqual([
      { resource: '教室', location: '教室', isNew: true },
      { resource: '校园', location: '操场', isNew: false },
    ]);
  });

  it('tells a location resource that gets one more place from a performer that gets one more role', () => {
    const [performerAdd, placeAdd] = [CHANGES[3]!, CHANGES[6]!];
    expect(isPlaceChange(performerAdd, LOCATIONS)).toBe(false);
    expect(isPlaceChange(placeAdd, LOCATIONS)).toBe(true);
    expect(isPlaceChange(CHANGES[5]!, LOCATIONS)).toBe(true);
  });

  it('leaves the locations out when they are not ticked', () => {
    expect(appliedChanges(CHANGES, LOCATIONS, true)).toHaveLength(7);
    const without = appliedChanges(CHANGES, LOCATIONS, false);
    expect(without).toHaveLength(5);
    expect(without.some((c) => isPlaceChange(c, LOCATIONS))).toBe(false);
  });

  it('counts the people and places it would create, once each (a move to a new performer creates them too)', () => {
    expect(newResourceNames(CHANGES).sort()).toEqual(['吴桐', '周远', '孙晴', '教室'].sort());
    expect(newResourceNames(appliedChanges(CHANGES, LOCATIONS, false)).sort()).toEqual(['吴桐', '周远', '孙晴'].sort());
    expect(newResourceNames([CHANGES[3]!, CHANGES[6]!])).toEqual([]);
  });

  it('starts with the plan date, 08:00–20:00', () => {
    expect(defaultSyncWindow('2026-10-05')).toEqual({ date: '2026-10-05', start: '08:00', end: '20:00' });
  });

  it('always sends exactly one window: an empty list would mean never available', () => {
    const tz = 'Asia/Shanghai';
    const window = fromLocalWindow(defaultSyncWindow('2026-10-05'), tz)!;
    expect(window).toEqual({ start_utc: '2026-10-05T00:00:00.000Z', end_utc: '2026-10-05T12:00:00.000Z' });
    expect(toLocalWindow(window, tz)).toEqual(defaultSyncWindow('2026-10-05'));
    expect(buildCastSyncInput({ hash: 'h1', includeLocations: false, window, confirmed: true })).toEqual({
      hash: 'h1',
      include_locations: false,
      windows: [window],
      confirmed: true,
    });
  });
});

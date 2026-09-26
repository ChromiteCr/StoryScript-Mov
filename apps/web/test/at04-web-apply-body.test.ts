import { describe, expect, it } from 'vitest';
import { Api } from '@storyscript/contracts';
import {
  archiveCandidates,
  buildApplyBreakdownInput,
  buildEntitySelection,
  keptShotCount,
  parseAliasInput,
  parseEntityDraft,
  previewShotCodes,
} from '../src/lib/drafts.ts';
import { draft, shot } from './fixtures.ts';

// AT-04 (web side): apply carries expected_revisions for every shot it may
// archive; locked and manual shots are never candidates.

const items = [
  { index: 0, selectable: true },
  { index: 1, selectable: false },
  { index: 2, selectable: true },
];

describe('apply request body', () => {
  const aiOpen = shot({ revision: 3 });
  const aiOpen2 = shot({ revision: 7, narrative_pos: 2 });
  const aiLocked = shot({ locked: true, revision: 5 });
  const manual = shot({ origin: 'manual', revision: 2 });
  const archived = shot({ archived: true, revision: 9 });
  const current = [aiOpen, aiOpen2, aiLocked, manual, archived];

  it('archive candidates are live, unlocked, AI-made shots only', () => {
    expect(archiveCandidates(current).map((s) => s.id)).toEqual([aiOpen.id, aiOpen2.id]);
  });

  it('with replace_existing, expected_revisions covers exactly the shots that may be archived', () => {
    const body = buildApplyBreakdownInput({ items, selected: new Set([2, 0]), replaceExisting: true, currentShots: current });
    expect(body.replace_existing).toBe(true);
    expect(body.selected).toEqual([0, 2]);
    expect(body.expected_revisions).toEqual({ [aiOpen.id]: 3, [aiOpen2.id]: 7 });
    expect(body.expected_revisions).not.toHaveProperty(aiLocked.id);
    expect(body.expected_revisions).not.toHaveProperty(manual.id);
    expect(body.expected_revisions).not.toHaveProperty(archived.id);
  });

  it('without replace_existing nothing is archived, so no revisions are sent', () => {
    const body = buildApplyBreakdownInput({ items, selected: new Set([0]), replaceExisting: false, currentShots: current });
    expect(body).toEqual({ selected: [0], replace_existing: false, expected_revisions: {} });
  });

  it('drops unselectable indices even if they slipped into the selection', () => {
    const body = buildApplyBreakdownInput({ items, selected: new Set([0, 1, 5]), replaceExisting: false, currentShots: [] });
    expect(body.selected).toEqual([0]);
  });

  it('matches the ApplyBreakdownInput contract', () => {
    const body = buildApplyBreakdownInput({ items, selected: new Set([0, 2]), replaceExisting: true, currentShots: current });
    expect(Api.applyBreakdown.input.safeParse(body).success).toBe(true);
  });

  it('counts the shots that remain after apply', () => {
    expect(keptShotCount(current, false)).toBe(4);
    expect(keptShotCount(current, true)).toBe(2);
  });
});

describe('shot code preview', () => {
  it('mirrors the server: max trailing number of the shots that stay, plus one, three digits', () => {
    const a = shot({ code: '003' });
    const b = shot({ code: '1A-007' });
    const locked = shot({ code: '012', locked: true });
    expect(previewShotCodes([a, b], false, 2)).toEqual(['008', '009']);
    // replacing archives a and b first; the locked 012 stays
    expect(previewShotCodes([a, b, locked], true, 2)).toEqual(['013', '014']);
    expect(previewShotCodes([a, b], true, 1)).toEqual(['001']);
    expect(previewShotCodes([], false, 0)).toEqual([]);
  });
});

describe('entity draft selection', () => {
  const existing = [{ type: 'character' as const, alias: 'c1', name: '林小满', aliases: ['小满'] }];
  const d = draft(
    {
      characters: [
        { name: '小满', aliases: [] },
        { name: '周远', aliases: ['老周'] },
      ],
      locations: [{ name: '旧书店', aliases: [] }],
      props: [],
    },
    [],
    { kind: 'entities', scope: {} },
  );

  it('pre-selects new names and leaves likely duplicates unticked', () => {
    const rows = parseEntityDraft(d, existing);
    expect(rows).not.toBeNull();
    expect(rows?.map((r) => [r.kind, r.index, r.selected])).toEqual([
      ['characters', 0, false],
      ['characters', 1, true],
      ['locations', 0, true],
    ]);
    expect(rows?.[0]?.duplicateOf).toContain('c1');
    expect(rows?.[0]?.mergeInto).toBeNull();
  });

  it('an exact name match is merged by the server, so it stays ticked', () => {
    const same = draft({ characters: [{ name: '林小满', aliases: ['满满'] }], locations: [], props: [] }, [], { kind: 'entities', scope: {} });
    const rows = parseEntityDraft(same, existing) ?? [];
    expect(rows[0]?.selected).toBe(true);
    expect(rows[0]?.mergeInto).toBe('c1 林小满');
    expect(rows[0]?.duplicateOf).toBeNull();
  });

  it('sends the user-edited name and aliases of ticked rows', () => {
    const rows = parseEntityDraft(d, existing) ?? [];
    const edited = rows.map((r) => (r.kind === 'characters' && r.index === 1 ? { ...r, name: ' 周远航 ', aliases: parseAliasInput('老周， 周师傅、老周') } : r));
    const body = buildEntitySelection(edited);
    expect(body.items).toEqual([
      { kind: 'characters', index: 1, name: '周远航', aliases: ['老周', '周师傅'] },
      { kind: 'locations', index: 0, name: '旧书店', aliases: [] },
    ]);
    expect(Api.applyEntityDraft.input.safeParse(body).success).toBe(true);
  });
});

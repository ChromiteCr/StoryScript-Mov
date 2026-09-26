import { describe, expect, it } from 'vitest';
import {
  defaultSelection,
  isItemSelectable,
  parseBreakdownDraft,
  quoteMatchOf,
  toggleSelection,
} from '../src/lib/drafts.ts';
import { draft, fields, issue } from './fixtures.ts';

// AT-03 (web side): draft items with an error (bad alias, rejected quote,
// over the cap…) can never be ticked, so they never reach apply.

const THREE = { shots: [fields(), fields({ action: '门铃响' }), fields({ action: '店主抬头' })] };

describe('draft item selectability', () => {
  it('an item with an error-level issue is not selectable', () => {
    const p = parseBreakdownDraft(draft(THREE, [issue('error', 1, 'UNKNOWN_ALIAS', '角色 c9 不在名单内')]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items.map((i) => i.selectable)).toEqual([true, false, true]);
    expect(p.items[1]?.blockedReason).toContain('c9');
  });

  it('warnings do not block selection', () => {
    expect(isItemSelectable({ issues: [issue('warning', 0)], match: 'exact' })).toBe(true);
    expect(isItemSelectable({ issues: [issue('warning', 0), issue('error', 0)], match: 'exact' })).toBe(false);
  });

  it('a rejected quote blocks selection even without an issue', () => {
    expect(isItemSelectable({ issues: [], match: 'rejected' })).toBe(false);
    expect(isItemSelectable({ issues: [], match: 'fuzzy' })).toBe(true);
  });

  it('whole-draft issues (item null) are reported separately and do not block items', () => {
    const p = parseBreakdownDraft(draft(THREE, [issue('warning', null, 'TOO_MANY', '镜头数超过上限')]));
    expect(p.draftIssues).toHaveLength(1);
    if (!p.ok) throw new Error('parse failed');
    expect(p.items.every((i) => i.selectable)).toBe(true);
  });

  it('a draft whose parsed output does not match BreakdownOutput yields no items', () => {
    const p = parseBreakdownDraft(draft({ shots: [{ shot_size: 'HUGE' }] }, [issue('error', null, 'ZOD', 'invalid')]));
    expect(p.ok).toBe(false);
    expect(p.draftIssues).toHaveLength(1);
    expect(parseBreakdownDraft(draft(null)).ok).toBe(false);
  });

  it('default selection skips errors and fuzzy quotes; toggling never adds an unselectable item', () => {
    const parsed = { shots: THREE.shots, matches: ['exact', 'fuzzy', 'exact'] };
    const p = parseBreakdownDraft(draft(parsed, [issue('error', 2)]));
    if (!p.ok) throw new Error('parse failed');
    const sel = defaultSelection(p.items);
    expect([...sel]).toEqual([0]);
    const withFuzzy = toggleSelection(sel, p.items[1]!);
    expect([...withFuzzy].sort()).toEqual([0, 1]);
    const blocked = toggleSelection(withFuzzy, p.items[2]!);
    expect(blocked.has(2)).toBe(false);
    expect(toggleSelection(withFuzzy, p.items[0]!).has(0)).toBe(false);
  });

  it('reads the quote match level from the item, a sibling array or an issue code', () => {
    const shots = [{ ...fields(), match: 'fuzzy' }, fields(), fields()];
    expect(quoteMatchOf({ shots }, 0, [])).toBe('fuzzy');
    expect(quoteMatchOf({ shots, quote_matches: [null, 'exact'] }, 1, [])).toBe('exact');
    expect(quoteMatchOf({ shots }, 2, [issue('error', 2, 'QUOTE_REJECTED')])).toBe('rejected');
    expect(quoteMatchOf({ shots }, 2, [issue('warning', 2, 'quote_fuzzy')])).toBe('fuzzy');
    // server semantics: no quote issue = exact; a paragraph outside the scene cannot match
    expect(quoteMatchOf({ shots }, 1, [])).toBe('exact');
    expect(quoteMatchOf({ shots }, 2, [issue('error', 2, 'paragraph_not_in_scene')])).toBe('rejected');
  });

  it('attaches claim flags to their items', () => {
    const p = parseBreakdownDraft(draft(THREE), [
      { item: 0, kind: 'year', text: '1999 年' },
      { item: null, kind: 'title', text: '《某书》' },
    ]);
    if (!p.ok) throw new Error('parse failed');
    expect(p.items[0]?.claims).toHaveLength(1);
    expect(p.items[1]?.claims).toHaveLength(0);
    expect(p.draftClaims).toHaveLength(1);
  });
});

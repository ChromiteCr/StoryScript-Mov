import { describe, expect, test } from 'vitest';
import { DELIVER_GROUPS } from '../src/lib/labels-deliver.ts';
import { adoptedAiCount, deliverItems, deliverSummary, dispositionFilename, missingCount, type DeliverInput } from '../src/views/deliver/model.ts';

/** The deliver checklist (FR-10): what each export holds and when it is a draft. */

const EMPTY: DeliverInput = { shots: [], boards: [], plan: null, takes: [], links: [], coverage: [] };

const shot = (id: string, locked = false) => ({ id, locked });
const board = (shot_id: string, stale = false, adopted_raster_id: string | null = null) => ({ shot_id, stale, adopted_raster_id });
const plan = (status: 'draft' | 'approved', stale = false) => ({ stale, plan: { status, date: '2026-10-05' } });

describe('deliver checklist', () => {
  test('every group item is present, in page order', () => {
    const items = deliverItems(EMPTY);
    expect(DELIVER_GROUPS.flatMap((g) => g.items)).toEqual(['boards', 'topview', 'callsheet', 'slates', 'take-log', 'takes-media', 'coverage-csv', 'missing', 'shots-csv', 'project-json']);
    for (const g of DELIVER_GROUPS) for (const id of g.items) expect(items[id].id).toBe(id);
  });

  test('a new project: nothing to print, plan exports unavailable, the project JSON is always ready', () => {
    const items = deliverItems(EMPTY);
    expect(items.boards.state).toBe('empty');
    expect(items.callsheet.state).toBe('unavailable');
    expect(items['take-log'].state).toBe('unavailable');
    expect(items['shots-csv'].state).toBe('empty');
    expect(items['takes-media'].state).toBe('empty');
    expect(items['project-json'].state).toBe('ready');
    expect(deliverSummary(items)).toEqual({ ready: 1, draft: 0, empty: 6, unavailable: 3 });
  });

  test('boards are 草案 while a shot is unlocked or a board is stale, final otherwise', () => {
    const base = { ...EMPTY, shots: [shot('a', true), shot('b', true)] };
    expect(deliverItems({ ...base, boards: [board('a'), board('b')] }).boards.state).toBe('ready');
    const unlocked = deliverItems({ ...base, shots: [shot('a', true), shot('b')], boards: [board('a'), board('b')] }).boards;
    expect(unlocked).toMatchObject({ state: 'draft' });
    expect(unlocked.note).toContain('1 个镜头未锁定');
    const stale = deliverItems({ ...base, boards: [board('a', true), board('b')] }).topview;
    expect(stale).toMatchObject({ state: 'draft' });
    expect(stale.note).toContain('1 格镜头已改');
  });

  test('plan exports follow the plan: draft, approved, approved but stale', () => {
    expect(deliverItems({ ...EMPTY, plan: plan('draft') }).callsheet.state).toBe('draft');
    expect(deliverItems({ ...EMPTY, plan: plan('approved') }).slates).toMatchObject({ state: 'ready', note: '2026-10-05 的计划已批准。' });
    expect(deliverItems({ ...EMPTY, plan: plan('approved', true) })['take-log'].state).toBe('draft');
  });

  test('takes and links: rejected links do not count, candidates are called out', () => {
    const items = deliverItems({
      ...EMPTY,
      shots: [shot('a')],
      takes: [{ id: 't1' }],
      links: [{ status: 'candidate' }, { status: 'confirmed' }, { status: 'rejected' }],
    });
    expect(items['takes-media']).toMatchObject({ state: 'ready' });
    expect(items['takes-media'].note).toBe('1 条场记、2 条关联（其中 1 条候选待审核，状态列写明「候选」）。');
  });

  test('missing count: required shots with a reason only (optional and waived never count)', () => {
    const coverage = [
      { status: 'planned' as const, required_status: 'required' as const, missing_reason: 'no_take' as const },
      { status: 'usable' as const, required_status: 'required' as const, missing_reason: null },
      { status: 'planned' as const, required_status: 'optional' as const, missing_reason: 'no_take' as const },
      { status: 'waived' as const, required_status: 'waived' as const, missing_reason: null },
    ];
    expect(missingCount(coverage)).toBe(1);
    expect(deliverItems({ ...EMPTY, shots: [shot('a')], coverage }).missing).toMatchObject({ state: 'ready', note: '漏拍 1 个，可用 1 个。' });
  });

  test('adopted AI images are counted for the badge note', () => {
    expect(adoptedAiCount([board('a'), board('b', false, 'r1'), board('c', true, 'r2')])).toBe(2);
  });
});

describe('Content-Disposition file names', () => {
  test('filename* (UTF-8) wins over the ASCII fallback', () => {
    expect(dispositionFilename(`attachment; filename="storyscript-shots-2026-10-05.csv"; filename*=UTF-8''${encodeURIComponent('旧书-镜头表-2026-10-05.csv')}`)).toBe(
      '旧书-镜头表-2026-10-05.csv',
    );
  });
  test('plain filename, quoted or not; nothing → null', () => {
    expect(dispositionFilename('attachment; filename="a b.json"')).toBe('a b.json');
    expect(dispositionFilename('attachment; filename=plain.csv')).toBe('plain.csv');
    expect(dispositionFilename("attachment; filename*=UTF-8''%E0%A4%A; filename=\"fallback.csv\"")).toBe('fallback.csv');
    expect(dispositionFilename(null)).toBeNull();
    expect(dispositionFilename('inline')).toBeNull();
  });
});

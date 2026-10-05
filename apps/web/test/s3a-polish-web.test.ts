import { describe, expect, it } from 'vitest';
import { PolishRequest, type DraftIssue, type PolishOutput, type Shot } from '@storyscript/contracts';
import { POLISH_MODE_LABEL } from '@storyscript/core';
import { draftSceneId } from '../src/lib/drafts.ts';
import { JOB_KIND_LABEL, POLISH_SLOT } from '../src/lib/jobs.ts';
import {
  POLISH_MAX,
  buildApplyPolishInput,
  canPolish,
  defaultPolishSelection,
  fieldText,
  parsePolishDraft,
  pendingPolishDrafts,
  polishAiReason,
  polishAppliedNotice,
  polishBlockedReason,
  polishOutgoingSentence,
  pruneSelection,
  readPolishScope,
  sceneSelection,
  selectableShotIds,
  setShots,
  sideLines,
  toggleShot,
  togglePolishItem,
} from '../src/lib/polish.ts';
import { changedFieldKeys, changedFieldLabels } from '../src/lib/shots.ts';
import { draft, fields, issue, shot, uuid } from './fixtures.ts';

// S3a web logic: the shot table's selection, what a polish draft shows and
// the body of the apply request. Original text only.

const AI_ON = { enabled: true, reason: null };
const AI_OFF = { enabled: false, reason: '未配置文本模型：在"设置 → 模型"中填写后可用。' };

function noSource(s: Shot) {
  const { source: _source, ...rest } = s.fields;
  return rest;
}

/** three shots of one scene: the middle one is locked */
function scene(): Shot[] {
  return [shot({ code: '1-001', narrative_pos: 1 }), shot({ code: '1-002', narrative_pos: 2, locked: true }), shot({ code: '1-003', narrative_pos: 3 })];
}

describe('selection', () => {
  it('only live, unlocked shots can be ticked', () => {
    const [a, b, c] = scene();
    const gone = shot({ archived: true });
    const ok = selectableShotIds([a!, b!, c!, gone]);
    expect([...ok]).toEqual([a!.id, c!.id]);
  });

  it('toggling ticks and unticks; a locked shot is never added', () => {
    const [a, b] = scene();
    const ok = selectableShotIds([a!, b!]);
    const one = toggleShot(new Set(), a!.id, ok);
    expect([...one]).toEqual([a!.id]);
    expect(toggleShot(one, a!.id, ok).size).toBe(0);
    const still = toggleShot(one, b!.id, ok);
    expect(still).toBe(one); // same set back: nothing to re-render
  });

  it('a tick that has become impossible can still be removed', () => {
    const [a] = scene();
    const ticked = new Set([a!.id]);
    expect(toggleShot(ticked, a!.id, new Set()).size).toBe(0);
  });

  it('全选本场 ticks the unlocked shots and skips the locked one; 取消本场 clears them', () => {
    const shots = scene();
    const ok = selectableShotIds(shots);
    const before = sceneSelection(shots, new Set());
    expect(before).toMatchObject({ selectedCount: 0, all: false });
    expect(before.ids).toEqual([shots[0]!.id, shots[2]!.id]);

    const all = setShots(new Set(), before.ids, true, ok);
    expect(sceneSelection(shots, all)).toMatchObject({ selectedCount: 2, all: true });
    expect(all.has(shots[1]!.id)).toBe(false);

    const none = setShots(all, before.ids, false, ok);
    expect(none.size).toBe(0);
  });

  it('setShots skips locked ids even when they are passed in, and returns the same set when nothing changes', () => {
    const shots = scene();
    const ok = selectableShotIds(shots);
    const ticked = setShots(new Set(), shots.map((s) => s.id), true, ok);
    expect(ticked.has(shots[1]!.id)).toBe(false);
    expect(ticked.size).toBe(2);
    expect(setShots(ticked, shots.map((s) => s.id), true, ok)).toBe(ticked);
    expect(setShots(new Set(), [], false, ok).size).toBe(0);
  });

  it('a scene with only locked shots has nothing to select', () => {
    const locked = [shot({ locked: true }), shot({ locked: true })];
    const s = sceneSelection(locked, new Set());
    expect(s.ids).toEqual([]);
    expect(s.all).toBe(false);
  });

  it('shots that disappear or get locked drop out of the selection', () => {
    const [a, b, c] = scene();
    const ticked = new Set([a!.id, c!.id]);
    const ok = selectableShotIds([a!, b!, c!]);
    expect(pruneSelection(ticked, ok)).toBe(ticked); // nothing to drop: same set
    const locked = { ...c!, locked: true };
    expect([...pruneSelection(ticked, selectableShotIds([a!, b!, locked]))]).toEqual([a!.id]);
    expect(pruneSelection(ticked, selectableShotIds([a!])).has(c!.id)).toBe(false);
  });
});

describe('AI 润色 button', () => {
  it('needs at least one shot, at most 12, and a working model', () => {
    expect(canPolish(0, AI_ON)).toBe(false);
    expect(canPolish(1, AI_ON)).toBe(true);
    expect(canPolish(POLISH_MAX, AI_ON)).toBe(true);
    expect(POLISH_MAX).toBe(12);
    expect(canPolish(13, AI_ON)).toBe(false);
    expect(polishBlockedReason(13, AI_ON)).toBe('一次最多 12 个');
    expect(polishBlockedReason(5, AI_ON)).toBeNull();
  });

  it('shows the AI gate\'s reason first', () => {
    expect(canPolish(3, AI_OFF)).toBe(false);
    expect(polishBlockedReason(3, AI_OFF)).toBe(AI_OFF.reason);
    expect(polishBlockedReason(13, AI_OFF)).toBe(AI_OFF.reason);
  });

  it('the demo replays recorded breakdowns only: polishing is blocked with a reason', () => {
    const demo = { enabled: true, reason: null, demo: true };
    expect(polishAiReason(demo)).toBe('演示模式不连接模型，不能润色镜头');
    expect(canPolish(2, demo)).toBe(false);
    expect(polishAiReason({ ...AI_ON, demo: false })).toBeNull();
    expect(polishAiReason(AI_OFF)).toBe(AI_OFF.reason);
  });

  it('the outgoing sentence names what leaves the machine', () => {
    expect(polishOutgoingSentence({ shots: 3, characters: 2, styleName: null, hasInstruction: false })).toBe('将发送这 3 个镜头的内容和出处段落、角色名单（2 人）到');
    const full = polishOutgoingSentence({ shots: 1, characters: 0, styleName: '惊悚压迫', hasInstruction: true });
    expect(full).toContain('风格说明（惊悚压迫）');
    expect(full).toContain('你写的润色要求');
  });

  it('the request the dialog builds satisfies the contract', () => {
    const ids = [uuid(), uuid()];
    expect(PolishRequest.safeParse({ shot_ids: ids, mode: 'improve', instruction: '更有压迫感', style_id: null, level: 'steady' }).success).toBe(true);
    expect(PolishRequest.safeParse({ shot_ids: Array.from({ length: 13 }, () => uuid()), mode: 'refine', instruction: null, style_id: null, level: 'steady' }).success).toBe(false);
    expect(PolishRequest.safeParse({ shot_ids: ids, mode: 'refine', instruction: 'x'.repeat(501), style_id: null, level: 'steady' }).success).toBe(false);
  });

  it('labels: the job, the slot and the four ways', () => {
    expect(JOB_KIND_LABEL.polish_shots).toBe('AI 润色');
    expect(POLISH_SLOT).toBe('polish');
    expect(POLISH_MODE_LABEL).toEqual({ refine: '细化', improve: '优化', rewrite: '重写', vary: '丰富变化' });
  });
});

describe('drafts list', () => {
  it('pending polish drafts are their own list, newest first; breakdown and applied drafts stay out', () => {
    const older = draft(null, [], { kind: 'polish', created_at: '2026-09-26T08:00:00.000Z', scope: {} });
    const newer = draft(null, [], { kind: 'polish', created_at: '2026-09-27T08:00:00.000Z', scope: {} });
    const applied = draft(null, [], { kind: 'polish', status: 'applied', scope: {} });
    const breakdown = draft(null, [], { kind: 'breakdown' });
    expect(pendingPolishDrafts([older, breakdown, applied, newer]).map((d) => d.id)).toEqual([newer.id, older.id]);
  });

  it('a polish draft has no scene: the breakdown lookup ignores it', () => {
    expect(draftSceneId(draft(null, [], { kind: 'polish', scope: { shot_ids: [] } }))).toBeNull();
  });
});

/** A polish draft for the given shots: item i rewrites shots[i]. */
function polishDraft(shots: readonly Shot[], edit: (s: Shot, i: number) => Partial<ReturnType<typeof noSource>>, issues: DraftIssue[] = []) {
  const parsed: PolishOutput = {
    shots: shots.map((s, i) => ({ ref: `s${i + 1}`, change_note: `第 ${i + 1} 个的改动说明`, fields: { ...noSource(s), ...edit(s, i) } })),
  };
  const refs: Record<string, string> = {};
  const expected: Record<string, number> = {};
  shots.forEach((s, i) => {
    refs[`s${i + 1}`] = s.id;
    expected[s.id] = s.revision;
  });
  return draft(parsed, issues, {
    kind: 'polish',
    scope: { shot_ids: shots.map((s) => s.id), refs, expected_revisions: expected, mode: 'improve', instruction: '更有压迫感', style_id: 'style.thriller-press', level: 'bold' },
  });
}

describe('reading a polish draft', () => {
  it('reads the scope: way, request, style, level, refs and revisions', () => {
    const [a, b] = [shot({ revision: 2 }), shot({ revision: 5 })];
    const d = polishDraft([a, b], () => ({}));
    expect(readPolishScope(d.scope)).toEqual({
      mode: 'improve',
      instruction: '更有压迫感',
      styleId: 'style.thriller-press',
      level: 'bold',
      refs: { s1: a.id, s2: b.id },
      expected: { [a.id]: 2, [b.id]: 5 },
    });
    // a malformed scope reads as empty, not as an error
    expect(readPolishScope({ mode: 'other', refs: 3, expected_revisions: { x: 'y' }, level: 1 })).toEqual({ mode: null, instruction: null, styleId: null, level: null, refs: {}, expected: {} });
  });

  it('every clean item is ticked by default; before comes from the shot as it is now', () => {
    const shots = [shot({ code: '1-001' }), shot({ code: '1-002' })];
    const d = polishDraft(shots, (s, i) => (i === 0 ? { angle: 'low', movement: 'orbit', camera_notes: '稳定器绕两人半圈' } : { action: `${s.fields.action}，停顿一下` }));
    const p = parsePolishDraft({ draft: d, current_shots: shots });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items.map((i) => i.selectable)).toEqual([true, true]);
    expect([...defaultPolishSelection(p.items)]).toEqual([0, 1]);
    expect(p.items[0]!.shot?.code).toBe('1-001');
    expect(p.items[0]!.before?.angle).toBe('eye');
    expect(p.items[0]!.after.angle).toBe('low');
    expect(p.items[0]!.changed).toEqual(['角度', '运动', '拍法说明']);
    expect(p.items[1]!.changed).toEqual(['动作']);
    expect(p.items[1]!.changeNote).toBe('第 2 个的改动说明');
  });

  it('the shot keeps its source: it never shows up as a change', () => {
    const [a] = [shot()];
    const d = polishDraft([a], () => ({ est_seconds: 6 }));
    const p = parsePolishDraft({ draft: d, current_shots: [a] });
    expect(p.ok && p.items[0]!.changedKeys).toEqual(['est_seconds']);
    expect(changedFieldLabels(a.fields, { ...noSource(a), est_seconds: 6, source: a.fields.source })).toEqual(['预计时长']);
    expect(changedFieldKeys(null, a.fields)).toEqual([]);
  });

  it('an item with an error, a locked shot and a gone shot cannot be ticked', () => {
    const [a, b, c, d2] = [shot({ code: '1-001' }), shot({ code: '1-002', locked: true }), shot({ code: '1-003' }), shot({ code: '1-004' })];
    const d = polishDraft([a, b, c, d2], () => ({ action: '新的动作' }), [issue('error', 0, 'unknown_alias', '人物 c9 不在名单里'), issue('warning', 2, 'w', '拍法说明有点长')]);
    // shot 3 (index 2) is missing from current_shots
    const p = parsePolishDraft({ draft: d, current_shots: [a, b, d2] });
    if (!p.ok) throw new Error('parse');
    expect(p.items.map((i) => i.selectable)).toEqual([false, false, false, true]);
    expect(p.items[0]!.blockedReason).toContain('人物 c9 不在名单里');
    expect(p.items[1]!.blockedReason).toBe('镜头已锁定，不会被改动');
    expect(p.items[2]!.blockedReason).toBe('这个镜头已不在镜头表里');
    expect(p.items[2]!.warnings).toHaveLength(1);
    expect([...defaultPolishSelection(p.items)]).toEqual([3]);
    // a blocked item is never added by a click
    expect(togglePolishItem(new Set(), p.items[0]!).size).toBe(0);
    expect([...togglePolishItem(new Set(), p.items[3]!)]).toEqual([3]);
    expect(togglePolishItem(new Set([3]), p.items[3]!).size).toBe(0);
  });

  it('a shot edited after the request is stale and cannot be ticked', () => {
    const a = shot({ revision: 1 });
    const d = polishDraft([a], () => ({ action: '新的动作' }));
    const edited = { ...a, revision: 2, fields: { ...a.fields, action: '手改的动作' } };
    const p = parsePolishDraft({ draft: d, current_shots: [edited] });
    if (!p.ok) throw new Error('parse');
    expect(p.items[0]).toMatchObject({ stale: true, selectable: false });
    expect(p.items[0]!.blockedReason).toContain('润色之后被改过');
  });

  it('output that is not a polish result is not readable', () => {
    const p = parsePolishDraft({ draft: draft({ shots: [{ ref: 's1' }] }, [issue('error', null, 'x', '模型没有按格式输出')], { kind: 'polish', scope: {} }), current_shots: [] });
    expect(p.ok).toBe(false);
    expect(p.draftIssues).toHaveLength(1);
  });
});

describe('the apply request', () => {
  it('sends the ticked indices in order and the revisions of exactly those shots', () => {
    const shots = [shot({ revision: 1 }), shot({ revision: 4 }), shot({ revision: 2 })];
    const d = polishDraft(shots, () => ({ action: '新的动作' }));
    const p = parsePolishDraft({ draft: d, current_shots: shots });
    if (!p.ok) throw new Error('parse');
    const body = buildApplyPolishInput({ items: p.items, selected: new Set([2, 0]), expected: p.scope.expected });
    expect(body).toEqual({ selected: [0, 2], expected_revisions: { [shots[0]!.id]: 1, [shots[2]!.id]: 2 } });
    expect(body.expected_revisions).not.toHaveProperty(shots[1]!.id);
  });

  it('drops items that cannot be applied, even when they are in the ticked set', () => {
    const shots = [shot(), shot({ locked: true })];
    const d = polishDraft(shots, () => ({ action: '新的动作' }));
    const p = parsePolishDraft({ draft: d, current_shots: shots });
    if (!p.ok) throw new Error('parse');
    const body = buildApplyPolishInput({ items: p.items, selected: new Set([0, 1]), expected: p.scope.expected });
    expect(body.selected).toEqual([0]);
    expect(Object.keys(body.expected_revisions)).toEqual([shots[0]!.id]);
  });

  it('nothing ticked → an empty request', () => {
    expect(buildApplyPolishInput({ items: [], selected: new Set(), expected: {} })).toEqual({ selected: [], expected_revisions: {} });
  });

  it('the notice counts what was written and what was skipped', () => {
    const a = shot();
    expect(polishAppliedNotice({ updated: [a, a], skipped_locked_ids: [], skipped_missing_ids: [] })).toBe('已润色 2 个镜头。');
    expect(polishAppliedNotice({ updated: [a], skipped_locked_ids: [a.id], skipped_missing_ids: [a.id, a.id] })).toBe('已润色 1 个镜头，1 个锁定镜头未改动，2 个镜头已不在镜头表。');
    expect(polishAppliedNotice({ updated: [], skipped_locked_ids: [], skipped_missing_ids: [] })).toBe('已润色 0 个镜头，内容与原来相同。');
  });
});

describe('before / after lines', () => {
  it('marks what changed and adds a labelled line for the other changed fields', () => {
    const before = fields({ action: '店主抬头', camera_notes: null });
    const after = fields({ action: '店主抬头，停住', angle: 'low', movement: 'orbit', camera_notes: '稳定器绕半圈', props: ['door'], est_seconds: 6 });
    const keys = changedFieldKeys(before, after);
    expect(keys).toEqual(['angle', 'movement', 'camera_notes', 'props', 'est_seconds', 'action']);

    const b = sideLines(before, keys);
    const a = sideLines(after, keys);
    // spec line, action, camera notes (changed to something), then props and seconds
    expect(a.map((l) => l.key)).toEqual(['spec', 'action', 'camera_notes', 'props', 'est_seconds']);
    expect(a.every((l) => l.changed)).toBe(true);
    expect(a[0]!.text).toBe('中景 · 仰拍 · 50mm · 环绕');
    expect(a[2]).toMatchObject({ label: '拍法', text: '稳定器绕半圈' });
    expect(a[3]).toMatchObject({ label: '道具', text: '门' });
    expect(b[2]).toMatchObject({ label: '拍法', text: '无' });
    expect(b[3]).toMatchObject({ label: '道具', text: '无' });
    expect(b[4]).toMatchObject({ label: '预计时长', text: '4 秒' });
  });

  it('an unchanged side shows only the two main lines and no camera notes line', () => {
    const f = fields();
    const lines = sideLines(f, []);
    expect(lines.map((l) => l.key)).toEqual(['spec', 'action']);
    expect(lines.some((l) => l.changed)).toBe(false);
  });

  it('field text uses the display labels and the roster label for people', () => {
    const f = fields({ pov_owner: 'c1', technique_id: null, dialogue_quote: '你来了' });
    expect(fieldText('subjects', f, (alias) => `${alias} 老周`)).toBe('c1 老周 画左 中层 朝画右 站');
    expect(fieldText('pov_owner', f, (alias) => `${alias} 老周`)).toBe('c1 老周');
    expect(fieldText('dialogue_quote', f)).toBe('「你来了」');
    expect(fieldText('technique_id', f)).toBe('无');
    expect(fieldText('env', f)).toBe('室内');
    expect(fieldText('set_piece', f)).toBe('否');
  });
});

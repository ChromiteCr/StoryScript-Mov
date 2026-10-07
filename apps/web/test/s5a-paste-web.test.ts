import { describe, expect, it } from 'vitest';
import { PasteKind, type PasteItem, type PasteItemView, type PasteResolution } from '@storyscript/contracts';
import { JOB_KIND_LABEL } from '../src/lib/jobs.ts';
import { appliedLine, assigneeText, defaultSelection, dueText, groupItems, itemSummary, PASTE_KIND_LABEL, pruneSelection, resolutionText, slotText, todoOverdue } from '../src/lib/paste.ts';

// S5a web logic: one-line summaries, what applying does, grouping and the
// selection kept across refreshes, the result line, todo due dates. Pure.

const blank: PasteItem = {
  kind: 'other', quote: 'q', name: null, detail: null, character: null, owner: null, quantity: null, slots: [], scenes: [], rule: null,
  other_scenes: [], shot: null, take: null, rating: null, clip: null, assignee: null, task: null, unsure: null,
};
const item = (o: Partial<PasteItem>): PasteItem => ({ ...blank, ...o });
const none: PasteResolution = {
  action: 'none', target_id: null, target_name: null, character_id: null, character_name: null, setup_ids: [], other_setup_ids: [],
  shot_ids: [], unresolved_labels: [], assignee_id: null, assignee_roles: [],
};
const view = (key: string, it: Partial<PasteItem>, o: Partial<PasteItemView> = {}): PasteItemView => ({
  key, item: item(it), resolution: none, warnings: [], blocked: null, unconfirmed: false, suggested: true, applied: null, ...o,
});
const slot = (date: string, start: string | null, end: string | null) => ({ date, weekday: '周六', start, end, vague: false });

describe('summaries', () => {
  it('every kind has a label, and the job kind too', () => {
    for (const k of PasteKind.options) expect(PASTE_KIND_LABEL[k]).toBeTruthy();
    expect(JOB_KIND_LABEL.organize_paste).toBe('粘贴整理');
  });

  it('slots read as month, day, weekday and times', () => {
    expect(slotText(slot('2026-10-10', '14:00', '18:00'))).toBe('10月10日 周六 14:00–18:00');
    expect(slotText(slot('2026-10-10', '14:00', null))).toBe('10月10日 周六 14:00 起');
    expect(slotText({ ...slot('2026-10-16', null, null), weekday: null })).toBe('10月16日');
  });

  it('one line per kind', () => {
    expect(itemSummary(item({ kind: 'person', name: '小雨', character: '林晓', slots: [slot('2026-10-10', '14:00', '18:00')] }))).toBe('小雨 · 饰 林晓 · 10月10日 周六 14:00–18:00');
    expect(itemSummary(item({ kind: 'equipment', name: '稳定器', quantity: 2, owner: '小林' }))).toBe('稳定器 ×2 · 小林 负责');
    expect(itemSummary(item({ kind: 'schedule', scenes: ['1'], rule: 'after', other_scenes: ['2'] }))).toBe('第 1 场 晚于 第 2 场');
    expect(itemSummary(item({ kind: 'schedule', scenes: ['2'], rule: 'within', slots: [slot('2026-10-11', '09:00', '12:00')] }))).toBe('第 2 场 在这段时间拍 10月11日 周六 09:00–12:00');
    expect(itemSummary(item({ kind: 'take', scenes: ['1'], shot: '3', take: 2, rating: 'good', clip: 'C0012' }))).toBe('1 场 3 镜 第 2 条 · 可用 · 素材 C0012');
    expect(itemSummary(item({ kind: 'todo', assignee: '阿丽', task: '把日记本做旧', slots: [slot('2026-10-16', null, null)] }))).toBe('阿丽：把日记本做旧 · 10月16日 周六前');
    expect(itemSummary(item({ kind: 'other', detail: '剧组成员的档期' }))).toBe('剧组成员的档期');
  });

  it('what applying does', () => {
    expect(resolutionText({ item: item({ kind: 'person', name: '小雨', slots: [slot('2026-10-10', null, null)] }), resolution: { ...none, action: 'merge', target_name: '小雨' } })).toBe('合并到已有演员「小雨」（增加可用时段）');
    expect(resolutionText({ item: item({ kind: 'equipment', name: '稳定器', owner: '小林' }), resolution: { ...none, action: 'create' } })).toBe('新建器材，并给负责人建一条待办');
    expect(resolutionText({ item: item({ kind: 'prop', name: '日记本' }), resolution: { ...none, action: 'exists', target_name: '日记本' } })).toBe('剧本里已有道具「日记本」');
    expect(resolutionText({ item: item({ kind: 'todo', task: 'x' }), resolution: { ...none, assignee_id: 'a', target_name: '小林', assignee_roles: ['摄影'] } })).toBe('待办，指派给 小林（摄影）');
    expect(resolutionText({ item: item({ kind: 'other' }), resolution: none })).toBeNull();
  });
});

describe('the review list', () => {
  const items = [
    view('0:0', { kind: 'take', scenes: ['1'] }),
    view('0:1', { kind: 'person', name: '小雨' }),
    view('0:2', { kind: 'other' }, { blocked: '「其他」只作记录，不写入', suggested: false }),
    view('0:3', { kind: 'person', name: '老陈' }, { applied: { at: '2026-10-09T12:00:00.000Z', actor: null }, suggested: false }),
  ];

  it('grouped in review order; empty kinds left out', () => {
    expect(groupItems(items).map((g) => [g.kind, g.items.length])).toEqual([
      ['person', 2],
      ['take', 1],
      ['other', 1],
    ]);
  });

  it('suggested ones are ticked; refreshes drop applied and blocked ones', () => {
    const sel = defaultSelection(items);
    expect([...sel].sort()).toEqual(['0:0', '0:1']);
    const next = pruneSelection(new Set(['0:0', '0:1', '0:2', '0:3']), items);
    expect([...next].sort()).toEqual(['0:0', '0:1']);
  });

  it('the result line', () => {
    expect(appliedLine({ resources_created: 5, resources_updated: 1, constraints: 3, takes: 0, entities: 1, todos: 5 })).toBe('已写入：新建 5 个资源、更新 1 个资源、3 条约束、1 个道具条目、5 条待办');
    expect(appliedLine({ resources_created: 0, resources_updated: 0, constraints: 0, takes: 0, entities: 0, todos: 0 })).toBe('没有需要写入的内容');
  });
});

describe('todos', () => {
  it('due dates, overdue, who', () => {
    expect(dueText({ due_date: '2026-10-09', due_time: null }, '2026-10-09')).toBe('今天');
    expect(dueText({ due_date: '2026-10-10', due_time: '09:00' }, '2026-10-09')).toBe('明天 09:00');
    expect(dueText({ due_date: '2026-10-16', due_time: null }, '2026-10-09')).toBe('10月16日');
    expect(dueText({ due_date: null, due_time: null }, '2026-10-09')).toBeNull();
    expect(todoOverdue({ due_date: '2026-10-08', done: null }, '2026-10-09')).toBe(true);
    expect(todoOverdue({ due_date: '2026-10-09', done: null }, '2026-10-09')).toBe(false);
    expect(todoOverdue({ due_date: '2026-10-08', done: { at: '2026-10-08T00:00:00.000Z', actor: null } }, '2026-10-09')).toBe(false);
    expect(assigneeText({ assignee_name: '小林', assignee_roles: ['摄影', '灯光'] })).toBe('小林（摄影、灯光）');
    expect(assigneeText({ assignee_name: null, assignee_roles: [] })).toBeNull();
  });
});

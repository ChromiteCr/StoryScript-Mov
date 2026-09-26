import { describe, expect, it } from 'vitest';
import { Api, ShotFields } from '@storyscript/contracts';
import { attemptsText, isTerminalJob, usageText } from '../src/lib/jobs.ts';
import { describeJobError } from '../src/lib/errors.ts';
import {
  changedFieldLabels,
  emptyShotFields,
  groupShotsByScene,
  locateParagraph,
  moveId,
  narrativeOrderIds,
  parseNumberField,
  reorderLocally,
  sourceState,
  splitAroundQuote,
} from '../src/lib/shots.ts';
import { fields, SCENE_ID, shot, VERSION_ID } from './fixtures.ts';

describe('job polling', () => {
  it('stops on terminal statuses only', () => {
    expect(isTerminalJob({ status: 'queued', remote: true })).toBe(false);
    expect(isTerminalJob({ status: 'running', remote: true })).toBe(false);
    for (const s of ['succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const) {
      expect(isTerminalJob({ status: s, remote: false })).toBe(true);
    }
    // local jobs are re-run after a restart; remote ones are never resent
    expect(isTerminalJob({ status: 'interrupted', remote: false })).toBe(false);
    expect(isTerminalJob({ status: 'interrupted', remote: true })).toBe(true);
  });

  it('describes attempts, usage and errors in Chinese', () => {
    expect(attemptsText(0)).toBe('尚未外发');
    expect(attemptsText(2)).toContain('2 次');
    expect(usageText(null)).toBeNull();
    expect(usageText({ prompt_tokens: 1200, completion_tokens: 300 })).toContain('输入');
    expect(describeJobError({ code: 'ATTEMPTS_EXHAUSTED', message: 'x' })?.title).toContain('最大尝试次数');
    expect(describeJobError({ code: 'SOMETHING_NEW', message: '模型超时' })?.detail).toBe('模型超时');
    expect(describeJobError(null)).toBeNull();
  });
});

describe('shot table helpers', () => {
  it('groups by scene in narrative order', () => {
    const a = shot({ narrative_pos: 2 });
    const b = shot({ narrative_pos: 1 });
    const other = shot({ scene_id: '11111111-1111-4111-8111-111111111111' });
    const g = groupShotsByScene([a, b, other]);
    expect(g.get(SCENE_ID)?.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(g.size).toBe(2);
  });

  it('moves ids and sends exactly the live shots of the scene in the new order', () => {
    expect(moveId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    const live1 = shot({ narrative_pos: 1 });
    const gone = shot({ narrative_pos: 2, archived: true });
    const live2 = shot({ narrative_pos: 3 });
    const ids = narrativeOrderIds([live1, gone, live2], [live2.id, live1.id]);
    expect(ids).toEqual([live2.id, live1.id]);
    // unknown ids are dropped, forgotten live shots are appended
    expect(narrativeOrderIds([live1, gone, live2], [gone.id, live2.id, 'x'])).toEqual([live2.id, live1.id]);
    expect(Api.setNarrativeOrder.input.safeParse({ scene_id: SCENE_ID, shot_ids: ids }).success).toBe(true);
    const re = reorderLocally([live1, gone, live2], ids);
    expect(re.find((s) => s.id === live2.id)?.narrative_pos).toBe(1);
  });

  it('source cell states', () => {
    expect(sourceState(shot({ needs_relink: true })).kind).toBe('relink');
    expect(sourceState(shot({ origin: 'manual', source_anchor: null })).kind).toBe('manual');
    expect(sourceState(shot()).kind).toBe('anchored');
  });

  it('locates a paragraph by id on the same version, else by quote', () => {
    const paras = [
      { id: 'p-001', text: '1. 内景 旧书店 夜' },
      { id: 'p-002', text: '店主整理书架，灰尘在灯下飘。' },
    ];
    expect(locateParagraph(paras, { paragraph_id: 'p-002', quote: 'x', script_version_id: VERSION_ID }, VERSION_ID)).toBe('p-002');
    expect(locateParagraph(paras, { paragraph_id: 'p-009', quote: '灰尘在灯下飘', script_version_id: 'old' }, VERSION_ID)).toBe('p-002');
    expect(locateParagraph(paras, null, VERSION_ID)).toBeNull();
    expect(splitAroundQuote('店主整理书架，灰尘', '整理书架')).toEqual(['店主', '整理书架', '，灰尘']);
    expect(splitAroundQuote('abc', 'zz')).toBeNull();
  });

  it('new manual shot fields satisfy the contract', () => {
    const f = emptyShotFields({ paragraph_ids: ['p-004', 'p-005'] });
    expect(ShotFields.safeParse(f).success).toBe(true);
    expect(f.source.paragraph_id).toBe('p-004');
  });

  it('lists changed fields between revisions', () => {
    expect(changedFieldLabels(fields(), fields({ shot_size: 'CU', action: '抬头' }))).toEqual(['景别', '动作']);
    expect(changedFieldLabels(null, fields())).toEqual([]);
  });

  it('parses number inputs', () => {
    expect(parseNumberField('', { allowEmpty: true, label: '焦段' })).toEqual({ value: null, error: null });
    expect(parseNumberField('35', { allowEmpty: true, label: '焦段' }).value).toBe(35);
    expect(parseNumberField('abc', { allowEmpty: true, label: '焦段' }).error).toContain('数字');
    expect(parseNumberField('0', { allowEmpty: false, min: 0.1, label: '时长' }).error).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import { Emotion, PropKind, TimeOfDay } from '@storyscript/contracts';
import { PICTURE_VERSION, STANDARD_SHOTS, standardBoard, structureHash, TIME_LIGHT } from '@storyscript/core';
import { setEmotion, setTimeOfDay } from '../src/lib/board-editor.ts';
import { EMOTION_LABEL, PROP_LABEL, SHOT_FIELD_LABEL, TIME_OF_DAY_LABEL } from '../src/lib/labels.ts';
import { fieldText } from '../src/lib/polish.ts';
import { changedFieldKeys } from '../src/lib/shots.ts';
import { fields } from './fixtures.ts';

// S5b web logic: the inspector's 情绪 and 时段, the shot editor's new labels,
// and change detection that treats an unset feeling or name as none. Pure.

const spec = standardBoard(STANDARD_SHOTS.find((s) => s.key === '05-mcu')!);
const sid = spec.scene.subjects[0]!.id;

describe('board inspector: 情绪 and 时段', () => {
  it('a feeling is stored on the person; calm removes it (the board hashes as before)', () => {
    const angry = setEmotion(spec, sid, 'angry');
    expect(angry.scene.subjects[0]!.emotion).toBe('angry');
    expect(spec.scene.subjects[0]!.emotion).toBeUndefined(); // a copy, the original untouched
    const calm = setEmotion(angry, sid, 'neutral');
    expect('emotion' in calm.scene.subjects[0]!).toBe(false);
    expect(structureHash(calm)).toBe(structureHash(spec));
    expect(setEmotion(spec, 'nobody', 'sad')).toBe(spec);
  });

  it('the time sets the light; day goes back to exactly the old spec', () => {
    const night = setTimeOfDay(spec, 'night');
    expect(night.scene).toMatchObject({ time: 'night', light: TIME_LIGHT.night });
    const day = setTimeOfDay(night, 'day');
    expect('time' in day.scene).toBe(false);
    expect(day.scene.light).toEqual(spec.scene.light);
    expect(structureHash(day)).toBe(structureHash(spec));
  });

  it('every emotion, time and prop has a label; the picture cache key moved on', () => {
    for (const e of Emotion.options) expect(EMOTION_LABEL[e].trim()).not.toBe('');
    for (const t of TimeOfDay.options) expect(TIME_OF_DAY_LABEL[t].trim()).not.toBe('');
    for (const p of PropKind.options) expect(PROP_LABEL[p].trim()).not.toBe('');
    expect([PROP_LABEL.can, PROP_LABEL.bottle]).toEqual(['罐子', '瓶子']);
    expect(SHOT_FIELD_LABEL.object_name).toBe('物件名称');
    expect(PICTURE_VERSION).toBe('picture-s5b');
  });
});

describe('shot changes', () => {
  const base = fields({ subjects: [{ alias: 'c1', screen: null, depth: null, facing: null, pose: null }] });

  it('an unset feeling or an empty name is no change; a set one is', () => {
    expect(changedFieldKeys(base, { ...base, subjects: [{ ...base.subjects[0]!, emotion: null }] })).toEqual([]);
    expect(changedFieldKeys(base, { ...base, object_name: '' })).toEqual([]);
    expect(changedFieldKeys(base, { ...base, object_name: null })).toEqual([]);
    expect(changedFieldKeys(base, { ...base, subjects: [{ ...base.subjects[0]!, emotion: 'sad' }] })).toEqual(['subjects']);
    expect(changedFieldKeys(base, { ...base, object_name: '信' })).toEqual(['object_name']);
  });

  it('the polish comparison shows the name and the feeling', () => {
    const { source: _s, ...rest } = { ...base, object_name: '水果罐头', subjects: [{ ...base.subjects[0]!, emotion: 'surprised' as const }] };
    expect(fieldText('object_name', rest)).toBe('水果罐头');
    expect(fieldText('subjects', rest)).toContain('吃惊');
    const { source: _t, ...none } = base;
    expect(fieldText('object_name', none)).toBe('无');
  });
});

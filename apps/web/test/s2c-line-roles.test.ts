import { describe, expect, test } from 'vitest';
import { cycleLineRole, lineRole, type Detected, type LineOverrides } from '../src/lib/scriptImport.ts';

/** S2c: each preview line is 正文, 场 or 镜; a click moves it on, with the fewest overrides. */

const detected: Detected = { headings: new Set([1]), shots: new Set([2]) };
const none: LineOverrides = { heading: [], shot: [] };

describe('line roles in the import preview', () => {
  test('rules first, overrides on top (a heading override wins, like on the server)', () => {
    expect(lineRole(1, detected, none)).toBe('heading');
    expect(lineRole(2, detected, none)).toBe('shot');
    expect(lineRole(3, detected, none)).toBe('text');
    expect(lineRole(2, detected, { heading: [{ line: 2, is_heading: true }], shot: [] })).toBe('heading');
    expect(lineRole(1, detected, { heading: [{ line: 1, is_heading: false }], shot: [{ line: 1, is_shot: true }] })).toBe('shot');
  });

  test('a text line cycles 场 → 镜 → 正文 and ends with no overrides', () => {
    let ov: LineOverrides = none;
    ov = cycleLineRole(3, detected, ov);
    expect(lineRole(3, detected, ov)).toBe('heading');
    ov = cycleLineRole(3, detected, ov);
    expect(lineRole(3, detected, ov)).toBe('shot');
    expect(ov).toEqual({ heading: [], shot: [{ line: 3, is_shot: true }] });
    ov = cycleLineRole(3, detected, ov);
    expect(lineRole(3, detected, ov)).toBe('text');
    expect(ov).toEqual({ heading: [], shot: [] });
  });

  test('a detected heading → 镜 → 正文 → back to 场 with no overrides', () => {
    let ov: LineOverrides = none;
    ov = cycleLineRole(1, detected, ov);
    expect(lineRole(1, detected, ov)).toBe('shot');
    ov = cycleLineRole(1, detected, ov);
    expect(lineRole(1, detected, ov)).toBe('text');
    expect(ov).toEqual({ heading: [{ line: 1, is_heading: false }], shot: [] });
    ov = cycleLineRole(1, detected, ov);
    expect(ov).toEqual({ heading: [], shot: [] });
  });

  test('a detected shot → 正文 → 场 → back to 镜', () => {
    let ov = cycleLineRole(2, detected, none);
    expect(lineRole(2, detected, ov)).toBe('text');
    expect(ov.shot).toEqual([{ line: 2, is_shot: false }]);
    ov = cycleLineRole(2, detected, ov);
    expect(lineRole(2, detected, ov)).toBe('heading');
    ov = cycleLineRole(2, detected, ov);
    expect(ov).toEqual({ heading: [], shot: [] });
  });
});

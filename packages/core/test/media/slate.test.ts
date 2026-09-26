import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { DEFAULT_SLATE_FORMAT, compileSlateFormat, formatSlate, parseSlate } from '../../src/media/slate.ts';

const F = DEFAULT_SLATE_FORMAT; // S{scene:02}-{shot:03}-T{take:02}

describe('formatSlate', () => {
  test('pads to the requested widths', () => {
    expect(formatSlate(F, { scene: 1, shot: 3, take: 2 })).toBe('S01-003-T02');
    expect(formatSlate(F, { scene: 12, shot: 1234, take: 101 })).toBe('S12-1234-T101');
    expect(formatSlate('{scene}_{shot:02}', { scene: 7, shot: 4 })).toBe('7_04');
    expect(formatSlate('SC{scene:02} SH{shot:03} TK{take}', { scene: 2, shot: 15, take: 3 })).toBe('SC02 SH015 TK3');
  });

  test('rejects bad formats and bad values', () => {
    expect(() => formatSlate('S{scene}-{frame}', { scene: 1, shot: 1 })).toThrow(RangeError);
    expect(() => formatSlate('S{scene}', { scene: 1, shot: 1 })).toThrow(/needs \{scene\} and \{shot\}/);
    expect(() => formatSlate('{scene}{shot}', { scene: 1, shot: 1 })).toThrow(/separated/);
    expect(() => formatSlate('S{scene', { scene: 1, shot: 1 })).toThrow(RangeError);
    expect(() => formatSlate(F, { scene: 1, shot: 3 })).toThrow(/take/);
    expect(() => formatSlate(F, { scene: -1, shot: 3, take: 1 })).toThrow(RangeError);
    expect(() => formatSlate(F, { scene: 1.5, shot: 3, take: 1 })).toThrow(RangeError);
  });

  test('compileSlateFormat reports instead of throwing', () => {
    expect(compileSlateFormat('S{scene}-{shot}-{shot}')).toEqual({ ok: false, message: expect.stringContaining('twice') });
    expect(compileSlateFormat(F).ok).toBe(true);
  });
});

describe('parseSlate finds the code anywhere in a file name', () => {
  test.each([
    ['S01-003-T02.mov', { scene: 1, shot: 3, take: 2 }],
    ['s01-003-t02.MOV', { scene: 1, shot: 3, take: 2 }],
    ['S01_003_T02.mp4', { scene: 1, shot: 3, take: 2 }],
    ['S01 003 T02.mp4', { scene: 1, shot: 3, take: 2 }],
    ['S01.003.T02.mov', { scene: 1, shot: 3, take: 2 }],
    ['cafe_S01-003-T02_camA.mov', { scene: 1, shot: 3, take: 2 }],
    ['A001_S12-104-T10.mov', { scene: 12, shot: 104, take: 10 }],
    ['S1-3-T2.mov', { scene: 1, shot: 3, take: 2 }],
  ])('%s', (name, code) => {
    expect(parseSlate(F, name)).toEqual(code);
  });

  test.each(['IMG_1234.MOV', 'A001C003.mov', 'S01-003.mov', 'XS01-003-T02.mov', 'S01-003-T02345678.mov', 'notes.txt'])(
    '%s has no slate code',
    (name) => {
      expect(parseSlate(F, name)).toBeNull();
    },
  );

  test('formats without a take return take = null', () => {
    expect(parseSlate('SC{scene}_SH{shot}', 'sc3_sh12.mov')).toEqual({ scene: 3, shot: 12, take: null });
  });

  test('an invalid format parses nothing instead of throwing', () => {
    expect(parseSlate('S{scene', 'S01-003-T02.mov')).toBeNull();
  });

  test('property: parse(format(x)) = x, also after separator/case variants', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: 1, max: 99 }),
        fc.constantFrom('-', '_', ' ', '.'),
        fc.boolean(),
        (scene, shot, take, sep, lower) => {
          let text = formatSlate(F, { scene, shot, take }).replaceAll('-', sep);
          if (lower) text = text.toLowerCase();
          expect(parseSlate(F, `clip ${text}.mov`)).toEqual({ scene, shot, take });
        },
      ),
      { numRuns: 300 },
    );
  });
});

import { LinkCandidate } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { type BuildCandidatesInput, buildCandidates } from '../../src/media/candidates.ts';
import { DEFAULT_SLATE_FORMAT } from '../../src/media/slate.ts';

const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const shots = [
  { id: uid(1), scene_display_no: '1', code: '3' },
  { id: uid(2), scene_display_no: '1', code: '004' },
  { id: uid(3), scene_display_no: '2', code: '3' },
  { id: uid(4), scene_display_no: '12', code: '104' },
  { id: uid(5), scene_display_no: '2', code: '3A' }, // not numeric: never matched by number
];
const take = (id: string, takeNo: number, shotIds: string[], clipHint: string | null = null) => ({
  id,
  take_no: takeNo,
  clip_hint: clipHint,
  shot_ids: shotIds,
});
const asset = (n: number, rel_path: string) => ({ id: uid(0x100 + n), rel_path });

const run = (over: Partial<BuildCandidatesInput>) =>
  buildCandidates({ assets: [], shots, takes: [], codeFormat: DEFAULT_SLATE_FORMAT, ...over });

describe('R1: slate code in the file name', () => {
  test('S01-003-T02 → scene 1 shot 3, matched to the logged take 2', () => {
    const takes = [take(uid(21), 1, [uid(1)]), take(uid(22), 2, [uid(1)])];
    const { candidates, errors } = run({ assets: [asset(1, 'Day1/A/S01-003-T02.mov')], takes });
    expect(errors).toEqual([]);
    expect(candidates).toEqual([
      {
        shot_id: uid(1),
        media_asset_id: uid(0x101),
        take_id: uid(22),
        evidence: 'R1',
        detail: 'R1: slate code in "S01-003-T02.mov" → scene 1, shot 3, take 2',
        conflict: false,
      },
    ]);
    for (const c of candidates) expect(LinkCandidate.parse(c)).toEqual(c);
  });

  test('case and separator variants; take not logged yet → take_id null', () => {
    const { candidates } = run({
      assets: [asset(1, 's01_004_t01.mp4'), asset(2, 'S01 004 T01.MOV'), asset(3, 'S12.104.T10.mov')],
    });
    expect(candidates.map((c) => [c.media_asset_id, c.shot_id, c.take_id])).toEqual([
      [uid(0x101), uid(2), null],
      [uid(0x102), uid(2), null],
      [uid(0x103), uid(4), null],
    ]);
    expect(candidates[0]!.detail).toContain('take 1 not logged');
  });

  test('scene number must match too (shot 3 exists in scenes 1 and 2)', () => {
    const { candidates } = run({ assets: [asset(1, 'S02-003-T01.mov')] });
    expect(candidates.map((c) => c.shot_id)).toEqual([uid(3)]);
  });

  test('no slate code → nothing from R1', () => {
    expect(run({ assets: [asset(1, 'IMG_1234.MOV'), asset(2, 'A001C003.mov')] }).candidates).toEqual([]);
  });
});

describe('R2: take clip_hint equals the file stem', () => {
  test('iPhone IMG_1234 and cinema A001C003 (case-insensitive)', () => {
    const takes = [take(uid(21), 1, [uid(1)], 'IMG_1234'), take(uid(22), 3, [uid(4)], 'a001c003')];
    const { candidates } = run({ assets: [asset(1, 'DCIM/IMG_1234.MOV'), asset(2, 'CARD/A001C003.mov'), asset(3, 'IMG_12345.MOV')], takes });
    expect(candidates.map((c) => [c.media_asset_id, c.shot_id, c.take_id, c.evidence, c.conflict])).toEqual([
      [uid(0x101), uid(1), uid(21), 'R2', false],
      [uid(0x102), uid(4), uid(22), 'R2', false],
    ]);
  });

  test('a take covering two shots links the clip to both without a conflict (INV-06)', () => {
    const takes = [take(uid(21), 1, [uid(1), uid(2)], 'A001C007')];
    const { candidates } = run({ assets: [asset(1, 'A001C007.MOV')], takes });
    expect(candidates.map((c) => [c.shot_id, c.conflict])).toEqual([
      [uid(1), false],
      [uid(2), false],
    ]);
  });

  test('R1 and R2 agreeing on shot and take is not a conflict', () => {
    const takes = [take(uid(21), 2, [uid(1)], 'S01-003-T02')];
    const { candidates } = run({ assets: [asset(1, 'S01-003-T02.mov')], takes });
    expect(candidates.map((c) => [c.evidence, c.take_id, c.conflict])).toEqual([
      ['R1', uid(21), false],
      ['R2', uid(21), false],
    ]);
  });
});

describe('conflicts', () => {
  test('R1 and R2 disagree on the shot → every candidate of the asset is flagged', () => {
    const takes = [take(uid(21), 5, [uid(3)], 'S01-003-T02')];
    const { candidates } = run({ assets: [asset(1, 'S01-003-T02.mov'), asset(2, 'S01-004-T01.mov')], takes });
    expect(candidates.map((c) => [c.media_asset_id, c.shot_id, c.evidence, c.conflict])).toEqual([
      [uid(0x101), uid(1), 'R1', true],
      [uid(0x101), uid(3), 'R2', true],
      [uid(0x102), uid(2), 'R1', false],
    ]);
  });

  test('two logged takes with the same number (A/B camera) → ambiguous take, conflict', () => {
    const takes = [take(uid(21), 2, [uid(1)]), take(uid(22), 2, [uid(1)])];
    const { candidates } = run({ assets: [asset(1, 'S01-003-T02.mov')], takes });
    expect(candidates.map((c) => [c.take_id, c.conflict])).toEqual([
      [uid(21), true],
      [uid(22), true],
    ]);
  });

  test('duplicate shot numbers in the same scene → conflict', () => {
    const dupShots = [...shots, { id: uid(6), scene_display_no: '1', code: '03' }];
    const { candidates } = buildCandidates({ assets: [asset(1, 'S01-003-T01.mov')], shots: dupShots, takes: [], codeFormat: DEFAULT_SLATE_FORMAT });
    expect(candidates.map((c) => [c.shot_id, c.conflict])).toEqual([
      [uid(1), true],
      [uid(6), true],
    ]);
  });
});

describe('R3: user regex', () => {
  test('named groups scene/shot/take', () => {
    const takes = [take(uid(21), 4, [uid(4)])];
    const { candidates, errors } = run({
      assets: [asset(1, 'day2_sc12-sh104-tk4.mov')],
      takes,
      userRegex: 'sc(?<scene>\\d+)-sh(?<shot>\\d+)-tk(?<take>\\d+)',
    });
    expect(errors).toEqual([]);
    expect(candidates.map((c) => [c.shot_id, c.take_id, c.evidence, c.conflict])).toEqual([[uid(4), uid(21), 'R3', false]]);
    expect(candidates[0]!.detail).toContain('user pattern matched "sc12-sh104-tk4"');
  });

  test('without a scene group every scene with that shot number matches (and conflicts)', () => {
    const { candidates } = run({ assets: [asset(1, 'shot_3.mov')], userRegex: 'shot_(?<shot>\\d+)' });
    expect(candidates.map((c) => [c.shot_id, c.conflict])).toEqual([
      [uid(1), true],
      [uid(3), true],
    ]);
  });

  test.each([
    ['(?<shot>\\d+', /invalid regular expression/],
    ['[a-', /invalid regular expression/],
    ['sc(\\d+)', /named group/],
    ['x'.repeat(501), /longer than/],
  ])('invalid pattern %s → error, no throw, other rules still run', (userRegex, message) => {
    const { candidates, errors } = run({ assets: [asset(1, 'S01-003-T01.mov')], userRegex });
    expect(errors).toEqual([{ code: 'INVALID_REGEX', message: expect.stringMatching(message) }]);
    expect(candidates.map((c) => c.evidence)).toEqual(['R1']);
  });

  test('invalid slate format is reported, not thrown', () => {
    const { candidates, errors } = run({ assets: [asset(1, 'S01-003-T01.mov')], codeFormat: 'S{scene' });
    expect(errors.map((e) => e.code)).toEqual(['INVALID_FORMAT']);
    expect(candidates).toEqual([]);
  });
});

describe('never confirms, skips AppleDouble files', () => {
  test('._ files are ignored', () => {
    const takes = [take(uid(21), 1, [uid(1)], 'IMG_1234')];
    const { candidates } = run({ assets: [asset(1, 'DCIM/._IMG_1234.MOV'), asset(2, '._S01-003-T01.mov')], takes });
    expect(candidates).toEqual([]);
  });

  test('candidates carry evidence R1–R3 only and no status field', () => {
    const takes = [take(uid(21), 1, [uid(1)], 'IMG_1'), take(uid(22), 2, [uid(1)])];
    const { candidates } = run({
      assets: [asset(1, 'IMG_1.MOV'), asset(2, 'S01-003-T02.mov'), asset(3, 'x_3.mov')],
      takes,
      userRegex: 'x_(?<shot>\\d+)',
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(['R1', 'R2', 'R3']).toContain(c.evidence);
      expect(c).not.toHaveProperty('status');
      expect(LinkCandidate.safeParse(c).success).toBe(true);
    }
  });

  test('deterministic output order regardless of input order', () => {
    const assets = [asset(2, 'S01-004-T01.mov'), asset(1, 'S01-003-T01.mov')];
    const a = run({ assets });
    const b = run({ assets: [...assets].reverse(), takes: [] });
    expect(a).toEqual(b);
  });
});

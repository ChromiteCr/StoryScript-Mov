import type { Pose, Silhouette } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { buildPuppet, facingBucket, POSE_TABLES, poseTopY, type PuppetView } from '../../src/index.ts';

const POSES: Pose[] = ['stand', 'walk', 'run', 'sit', 'point', 'crouch'];
const VIEWS: PuppetView[] = ['front', '3q', 'side', 'back'];
const SILS: Silhouette[] = ['regular', 'coat', 'dress'];

describe('joint tables', () => {
  test('front and side tables agree on joint heights (one 3D figure)', () => {
    for (const pose of POSES) {
      const { front, side } = POSE_TABLES[pose];
      for (const j of Object.keys(front) as (keyof typeof front)[]) {
        expect(Math.abs(front[j][1] - side[j][1]), `${pose}.${j}`).toBeLessThanOrEqual(0.01);
      }
    }
  });

  test('standing figure: height 1, feet on the ground, head ≈ 1/7.5 of stature', () => {
    expect(poseTopY('stand')).toBeCloseTo(1, 2);
    const b = buildPuppet('stand', 'front', false, 'regular');
    expect(b.bbox.y0).toBeGreaterThanOrEqual(-0.01);
    expect(b.bbox.y0).toBeLessThan(0.01);
    expect(b.bbox.y1).toBeCloseTo(1, 2);
    const head = b.parts.find((p) => p.key === 'head')!;
    const ys = head.pts.map((p) => p[1]);
    expect((Math.max(...ys) - Math.min(...ys)) * 7.5).toBeCloseTo(1, 1);
  });

  test('sitting and crouching lower the head', () => {
    expect(poseTopY('sit')).toBeLessThan(0.8);
    expect(poseTopY('crouch')).toBeLessThan(0.75);
    expect(poseTopY('run')).toBeLessThan(poseTopY('stand'));
  });
});

describe('facing buckets', () => {
  test.each([
    [0, 'front', false],
    [29, 'front', false],
    [-29, 'front', true],
    [30, '3q', false],
    [-60, '3q', true],
    [75, 'side', false],
    [120, 'side', false],
    [-100, 'side', true],
    [121, 'back', false],
    [-150, 'back', true],
    [180, 'back', false],
    [-180, 'back', false],
    [380, 'front', false],
  ] as const)('rel %d → %s (mirror %s)', (rel, view, mirror) => {
    expect(facingBucket(rel)).toEqual({ view, mirror });
  });
});

describe('puppet geometry', () => {
  test('every pose × view × silhouette builds finite, closed parts', () => {
    for (const pose of POSES)
      for (const view of VIEWS)
        for (const sil of SILS) {
          const p = buildPuppet(pose, view, false, sil);
          expect(p.parts.length).toBeGreaterThan(10);
          for (const part of p.parts) {
            expect(part.pts.length).toBeGreaterThanOrEqual(3);
            for (const q of part.pts) expect(Number.isFinite(q[0]) && Number.isFinite(q[1])).toBe(true);
          }
          expect(p.bbox.y1).toBeCloseTo(poseTopY(pose), 1);
          if (sil !== 'regular') expect(p.parts.some((x) => x.key === 'skirt')).toBe(true);
        }
  });

  test('mirroring flips x only', () => {
    const a = buildPuppet('point', '3q', false, 'regular');
    const b = buildPuppet('point', '3q', true, 'regular');
    expect(b.bbox.x0).toBeCloseTo(-a.bbox.x1, 9);
    expect(b.bbox.x1).toBeCloseTo(-a.bbox.x0, 9);
    expect(b.bbox.y1).toBeCloseTo(a.bbox.y1, 9);
  });

  test('3/4 narrows the shoulders; side view shows the nose, back view hides the face', () => {
    const width = (v: PuppetView) => {
      const t = buildPuppet('stand', v, false, 'regular').parts.find((p) => p.key === 'torso')!;
      const xs = t.pts.map((q) => q[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(width('3q')).toBeLessThan(width('front'));
    expect(width('side')).toBeLessThan(width('3q'));
    const keys = (v: PuppetView) => buildPuppet('stand', v, false, 'regular').parts.map((p) => p.key);
    expect(keys('side')).toContain('nose');
    expect(keys('front')).toContain('face');
    expect(keys('back')).not.toContain('face');
  });

  test('far limbs draw behind the torso and thinner in profile', () => {
    const p = buildPuppet('walk', 'side', false, 'regular');
    const idx = (k: string) => p.parts.findIndex((x) => x.key === k);
    expect(idx('upperArmB')).toBeLessThan(idx('torso'));
    expect(idx('upperArmA')).toBeGreaterThan(idx('torso'));
    const span = (k: string) => {
      const xs = p.parts[idx(k)]!.pts.map((q) => q[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    // both upper arms are nearly vertical here: width ≈ diameter
    expect(span('upperArmB')).toBeLessThan(span('upperArmA') * 1.2);
  });

  test('pointing arm reads in every view (reaches well outside the torso)', () => {
    for (const view of VIEWS) {
      const p = buildPuppet('point', view, false, 'regular');
      const hand = p.parts.find((x) => x.key === 'handB')!;
      const torso = p.parts.find((x) => x.key === 'torso')!;
      const tx = torso.pts.map((q) => q[0]);
      const hx = hand.pts.map((q) => q[0]);
      const outside = Math.max(Math.min(...tx) - Math.min(...hx), Math.max(...hx) - Math.max(...tx));
      expect(outside, view).toBeGreaterThan(0.1);
    }
  });
});

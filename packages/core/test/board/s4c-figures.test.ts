import type { Pose, Silhouette } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { figurePartTone } from '../../src/board/pencil-plan.ts';
import { figureStyleFor, HAIR_STYLES } from '../../src/board/puppet-style.ts';
import { buildPuppet, effectiveGesture, gestureCount, type PuppetView } from '../../src/index.ts';

/**
 * S4c figures: gesture variants, a look per character (hair, clothing values),
 * materials on every part, the new poses.
 */

const POSES: Pose[] = ['stand', 'walk', 'run', 'sit', 'point', 'crouch', 'lie', 'kneel', 'reach', 'phone'];
const VIEWS: PuppetView[] = ['front', '3q', 'side', 'back'];

describe('gestures', () => {
  test('stand, sit and walk have variants; every pose has at least one', () => {
    expect(gestureCount('stand')).toBeGreaterThanOrEqual(5);
    expect(gestureCount('sit')).toBeGreaterThanOrEqual(3);
    expect(gestureCount('walk')).toBeGreaterThanOrEqual(2);
    for (const pose of POSES) expect(gestureCount(pose)).toBeGreaterThanOrEqual(1);
  });

  test('a subject without a gesture gets one from the seed: in range, stable, not all alike', () => {
    const picks = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = { id: `s${i}`, pose: 'stand' as const };
      const g = effectiveGesture(s, 7);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThan(gestureCount('stand'));
      expect(effectiveGesture(s, 7)).toBe(g);
      picks.add(g);
    }
    expect(picks.size).toBeGreaterThanOrEqual(3);
  });

  test('a set gesture wins and wraps; a pose with one variant always draws 0', () => {
    const n = gestureCount('stand');
    expect(effectiveGesture({ id: 's0', pose: 'stand', gesture: 2 }, 7)).toBe(2);
    expect(effectiveGesture({ id: 's0', pose: 'stand', gesture: n + 1 }, 7)).toBe(1);
    expect(effectiveGesture({ id: 's0', pose: 'run', gesture: 3 }, 7)).toBe(0);
  });

  test('variants move the arms, not the legs', () => {
    const hand = (g: number) => buildPuppet('stand', 'front', false, 'regular', { gesture: g }).parts.find((p) => p.key === 'handB')!.pts[0]!;
    const foot = (g: number) => buildPuppet('stand', 'front', false, 'regular', { gesture: g }).parts.find((p) => p.key === 'footB')!.pts[0]!;
    const hands = new Set(Array.from({ length: gestureCount('stand') }, (_, g) => hand(g).map((v) => v.toFixed(3)).join(',')));
    expect(hands.size).toBeGreaterThanOrEqual(3);
    expect(foot(2)).toEqual(foot(0));
  });
});

describe('a look per character', () => {
  test('the same identity always gets the same look; top and bottom differ', () => {
    const a = figureStyleFor({ entity_id: '00000000-0000-4000-8000-000000000001', label: '林', silhouette: 'regular' });
    expect(figureStyleFor({ entity_id: '00000000-0000-4000-8000-000000000001', label: '换了名字', silhouette: 'regular' })).toEqual(a);
    for (let i = 0; i < 60; i++) {
      const s = figureStyleFor({ entity_id: null, label: `角色${i}`, silhouette: 'regular' });
      expect(s.top).not.toBe(s.bottom);
      expect(HAIR_STYLES).toContain(s.hair);
    }
  });

  test('characters are told apart: the looks spread over hair styles and clothing values', () => {
    const looks = Array.from({ length: 60 }, (_, i) => figureStyleFor({ entity_id: null, label: `角色${i}`, silhouette: 'regular' }));
    expect(new Set(looks.map((l) => l.hair)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(looks.map((l) => `${l.top}/${l.bottom}`)).size).toBeGreaterThanOrEqual(5);
  });

  test('a dress silhouette leans to long hair, a ponytail or a bun', () => {
    const sil: Silhouette = 'dress';
    const looks = Array.from({ length: 80 }, (_, i) => figureStyleFor({ entity_id: null, label: `角色${i}`, silhouette: sil }));
    const tied = looks.filter((l) => l.hair === 'long' || l.hair === 'ponytail' || l.hair === 'bun').length;
    expect(tied / looks.length).toBeGreaterThan(0.75);
  });
});

describe('materials and tones', () => {
  test('every part says what it is made of: skin head and hands, shoes on the feet', () => {
    for (const pose of POSES)
      for (const view of VIEWS) {
        const p = buildPuppet(pose, view, false, 'regular');
        const mat = (k: string) => p.parts.find((x) => x.key === k)?.material;
        expect(mat('head')).toBe('skin');
        expect(mat('handA')).toBe('skin');
        expect(mat('footA')).toBe('shoe');
        expect(mat('torso')).toBe('top');
        for (const x of p.parts) expect(['skin', 'hair', 'top', 'bottom', 'shoe']).toContain(x.material);
      }
  });

  test('a mid-ground face is lighter than the clothes; the foreground figure stays near-black', () => {
    const style = { hair: 'short' as const, top: 'mid' as const, bottom: 'dark' as const };
    expect(figurePartTone(2, 'mg', 'skin', style)).toBeLessThan(figurePartTone(2, 'mg', 'top', style));
    expect(figurePartTone(2, 'mg', 'hair', style)).toBeGreaterThan(figurePartTone(2, 'mg', 'top', style));
    expect(figurePartTone(3, 'fg', 'skin', style)).toBeGreaterThan(2.4);
  });

  test('a lying figure is long and low', () => {
    for (const view of VIEWS) {
      const b = buildPuppet('lie', view, false, 'regular').bbox;
      if (view === 'front' || view === 'back') continue;
      expect(b.x1 - b.x0).toBeGreaterThan(2.5 * (b.y1 - b.y0));
    }
  });
});

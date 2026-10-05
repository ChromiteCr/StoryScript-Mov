/**
 * structureHash is frozen across renderer upgrades (S4c design §3): adopted AI
 * redraws compare it with the board's current hash, so a new way of drawing
 * people or sets must never change it for an existing spec. The fixture holds
 * board specs captured from the S4b layout, with the hashes they had then.
 */
import type { BoardSpec } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { PENCIL_VARIANTS, structureHash } from '../../src/index.ts';
import pinned from './fixtures/s4c-hash-specs.json' with { type: 'json' };

const rows = pinned as unknown as { key: string; spec: BoardSpec; structure_hash: string; hash_b: string; hash_c: string }[];

describe('structureHash is pinned for existing specs', () => {
  test('fixture has the captured boards', () => {
    expect(rows.map((r) => r.key)).toEqual(['03-ots-a', '05-mcu', '07-chase', '12-group']);
  });

  for (const r of rows) {
    test(`${r.key}: default look and variants B / C hash as before`, () => {
      expect(structureHash(r.spec)).toBe(r.structure_hash);
      expect(structureHash(r.spec, PENCIL_VARIANTS.A)).toBe(r.structure_hash);
      expect(structureHash(r.spec, PENCIL_VARIANTS.B)).toBe(r.hash_b);
      expect(structureHash(r.spec, PENCIL_VARIANTS.C)).toBe(r.hash_c);
    });

    test(`${r.key}: an absent or null gesture does not change the hash, a set one does`, () => {
      const withGesture = (g: number | null | undefined): BoardSpec => ({
        ...r.spec,
        scene: { ...r.spec.scene, subjects: r.spec.scene.subjects.map((s) => ({ ...s, gesture: g })) },
      });
      expect(structureHash(withGesture(undefined))).toBe(r.structure_hash);
      expect(structureHash(withGesture(null))).toBe(r.structure_hash);
      if (r.spec.scene.subjects.length) expect(structureHash(withGesture(2))).not.toBe(r.structure_hash);
    });
  }
});

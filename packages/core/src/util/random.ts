import { cyrb53 } from './hash.ts';

/** mulberry32 PRNG — deterministic jitter source for the pencil renderer. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-element RNG: seeding by (boardSeed, elementKey) means editing one
 * element never re-jitters the others.
 */
export function rngFor(boardSeed: number, elementKey: string): () => number {
  return mulberry32(cyrb53(elementKey, boardSeed) >>> 0);
}

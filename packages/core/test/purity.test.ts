import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contentHash, mulberry32, rngFor } from '../src/index.ts';

const SRC = join(import.meta.dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('packages/core stays pure (zero IO)', () => {
  const forbidden = [
    /from ['"]node:/,
    /from ['"](fs|path|os|child_process|http|https|net|crypto)['"]/,
    /\bfetch\s*\(/,
    /\bprocess\./,
    /\brequire\s*\(/,
    /\bDate\.now\s*\(/,
    /\bMath\.random\s*\(/,
  ];
  for (const file of walk(SRC)) {
    test(file.slice(SRC.length + 1), () => {
      const text = readFileSync(file, 'utf8');
      for (const re of forbidden) expect(text, `${re} in ${file}`).not.toMatch(re);
    });
  }
});

describe('determinism helpers', () => {
  test('contentHash ignores key order', () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(contentHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  test('mulberry32 is reproducible', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test('rngFor isolates elements', () => {
    expect(rngFor(1, 's0')()).toBe(rngFor(1, 's0')());
    expect(rngFor(1, 's0')()).not.toBe(rngFor(1, 's1')());
  });
});

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveWebDir } from '../src/server.ts';

/**
 * Which built frontend the server serves. A checkout can hold both the
 * packaging copy (apps/server/web, made by `npm run build`) and apps/web/dist;
 * an old packaging copy must not shadow a fresh web build.
 */

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function built(name: string, mtimeS: number | null): string {
  const d = join(root, name);
  if (mtimeS === null) return d;
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'index.html'), '<!doctype html>');
  utimesSync(join(d, 'index.html'), mtimeS, mtimeS);
  return d;
}

describe('resolveWebDir', () => {
  test('the newer build wins, whichever candidate it is', () => {
    root = mkdtempSync(join(tmpdir(), 'ssm-webdir-'));
    const pkg = built('pkg-web', 1_000);
    const dist = built('web-dist', 2_000);
    expect(resolveWebDir([pkg, dist])).toBe(dist);
    utimesSync(join(pkg, 'index.html'), 3_000, 3_000);
    expect(resolveWebDir([pkg, dist])).toBe(pkg);
  });

  test('an installed package has only its own copy', () => {
    root = mkdtempSync(join(tmpdir(), 'ssm-webdir-'));
    const pkg = built('pkg-web', 1_000);
    const missing = built('web-dist', null);
    expect(resolveWebDir([pkg, missing])).toBe(pkg);
  });

  test('nothing built: the first candidate (the server answers with a build hint)', () => {
    root = mkdtempSync(join(tmpdir(), 'ssm-webdir-'));
    expect(resolveWebDir([built('a', null), built('b', null)])).toBe(join(root, 'a'));
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoMediaManifest } from './media-manifest.ts';

/**
 * Where the `--demo` project's inputs live. One layout, relative to a data
 * root: the original sample script, the replay recordings and the pre-probed
 * footage.
 *
 *   <root>/fixtures/scripts/01-bookshop.txt
 *   <root>/fixtures/replay/*.json
 *   <root>/samples/demo-media/{media.json, posters/, clips/}
 *
 * Roots tried in order: the source checkout (this file → repo root), a
 * `demo-data/` folder next to the bundled cli (for the npm package), the
 * current directory.
 */

export const DEMO_SCRIPT_NAME = '01-bookshop.txt';

export interface DemoAssets {
  root: string;
  scriptFile: string;
  replayDir: string;
  /** samples/demo-media, or null when it is missing */
  mediaDir: string | null;
}

export function demoRootCandidates(cwd: string = process.cwd()): string[] {
  return [
    fileURLToPath(new URL('../../../../', import.meta.url)),
    fileURLToPath(new URL('../demo-data/', import.meta.url)),
    resolve(cwd),
  ];
}

export function demoAssetsAt(root: string): DemoAssets | null {
  const scriptFile = join(root, 'fixtures', 'scripts', DEMO_SCRIPT_NAME);
  if (!existsSync(scriptFile)) return null;
  const media = join(root, 'samples', 'demo-media');
  return {
    root,
    scriptFile,
    replayDir: join(root, 'fixtures', 'replay'),
    mediaDir: existsSync(join(media, 'media.json')) ? media : null,
  };
}

/** The first candidate root that holds the sample script, or null. */
export function resolveDemoAssets(candidates: readonly string[] = demoRootCandidates()): DemoAssets | null {
  for (const c of candidates) {
    const a = demoAssetsAt(c);
    if (a) return a;
  }
  return null;
}

export function readDemoMedia(mediaDir: string): DemoMediaManifest {
  return DemoMediaManifest.parse(JSON.parse(readFileSync(join(mediaDir, 'media.json'), 'utf8')));
}

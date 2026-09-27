// The `--demo` project's inputs for the published package: the same layout
// apps/server/src/demo/assets.ts reads from a source checkout, copied into
// apps/server/demo-data (next to the bundled dist/, which looks for
// ../demo-data). Only what the demo uses: the sample script, its replay
// recordings and the pre-probed footage with posters.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const DEMO_SCRIPT = '01-bookshop.txt';
const REPLAY_PREFIX = '01-bookshop.';

/** Copy the demo inputs from a repo root into dest (replacing it); returns the copied paths relative to dest. */
export function assembleDemoData(repoRoot, dest) {
  const script = join(repoRoot, 'fixtures', 'scripts', DEMO_SCRIPT);
  const replayDir = join(repoRoot, 'fixtures', 'replay');
  const media = join(repoRoot, 'samples', 'demo-media');
  for (const need of [script, replayDir, join(media, 'media.json')]) {
    if (!existsSync(need)) throw new Error(`演示数据缺少 ${need}`);
  }
  rmSync(dest, { recursive: true, force: true });
  const copied = [];
  const copy = (from, rel) => {
    mkdirSync(join(dest, rel, '..'), { recursive: true });
    cpSync(from, join(dest, rel));
    copied.push(rel);
  };
  copy(script, `fixtures/scripts/${DEMO_SCRIPT}`);
  for (const f of readdirSync(replayDir).sort()) {
    if (f.startsWith(REPLAY_PREFIX) && f.endsWith('.json')) copy(join(replayDir, f), `fixtures/replay/${f}`);
  }
  copy(join(media, 'media.json'), 'samples/demo-media/media.json');
  for (const sub of ['posters', 'clips']) {
    for (const f of readdirSync(join(media, sub)).sort()) {
      if (!f.startsWith('.')) copy(join(media, sub, f), `samples/demo-media/${sub}/${f}`);
    }
  }
  return copied;
}

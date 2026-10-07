/**
 * README images, taken from the real `--demo` project (nothing staged by
 * hand): a short hero GIF of the workflow, a contact sheet of the demo's
 * pencil boards rendered by the same core renderer the app uses, and one
 * screenshot per feature group.
 *
 *   npm run readme:media -- [--out docs/media] [--skip-build] [--no-gif]
 *
 * Needs local Chrome (Playwright channel "chrome") and ffmpeg (the GIF is
 * assembled from Chrome's screencast frames).
 */
import { spawnSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { BoardView, Shot } from '@storyscript/contracts';
import { renderBoard } from '@storyscript/core';
import { api, buildWeb, ROOT, signInAnywhere, startApp, type RunningApp } from '../e2e/support.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'docs/media' },
    'skip-build': { type: 'boolean', default: false },
    'no-gif': { type: 'boolean', default: false },
  },
});
const OUT = resolve(ROOT, values.out);

const SHOT = { width: 1440, height: 900 };
const GIF = { width: 1280, height: 800, fps: 10, outWidth: 960 };

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(ms);
}

/** Click a stage in the bottom workflow bar and wait for its page title. */
async function stage(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: label, exact: true }).click();
  await page.getByRole('heading', { name: label, level: 1 }).waitFor();
}

async function report(path: string): Promise<void> {
  const kb = (await stat(path)).size / 1024;
  console.log(`  ${path.replace(`${ROOT}/`, '')}  ${kb.toFixed(0)} KB`);
}

/**
 * Six boards of the demo's main scene (codes stay unique), in shot order: a
 * two-person shot, then people at different shot sizes, then one insert.
 */
function pickBoards(boards: BoardView[], shots: Shot[]): BoardView[] {
  const sizeOf = new Map(shots.map((s) => [s.id, s.fields.shot_size]));
  const count = new Map<string, number>();
  for (const b of boards) count.set(b.scene_id, (count.get(b.scene_id) ?? 0) + 1);
  const main = [...count.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  const byCode = (a: BoardView, b: BoardView) => a.shot_code.localeCompare(b.shot_code, 'en', { numeric: true });
  const scene = boards.filter((b) => b.scene_id === main).sort(byCode);
  const people = (b: BoardView) => b.spec.scene.subjects.length;
  const picked: BoardView[] = [];
  const add = (b: BoardView | undefined) => {
    if (b && !picked.includes(b) && picked.length < 6) picked.push(b);
  };
  add(scene.find((b) => people(b) >= 2));
  const sizes = new Set(picked.map((b) => sizeOf.get(b.shot_id)));
  for (const b of scene) {
    const size = sizeOf.get(b.shot_id);
    if (people(b) > 0 && size && !sizes.has(size) && picked.length < 5) {
      sizes.add(size);
      add(b);
    }
  }
  add(scene.find((b) => people(b) === 0 && sizeOf.get(b.shot_id) === 'INSERT'));
  for (const b of scene) add(b);
  return picked.sort(byCode);
}

async function contactSheet(browser: Browser, page: Page): Promise<void> {
  const boards = await api<BoardView[]>(page, 'GET', '/api/v1/boards');
  const shots = await api<Shot[]>(page, 'GET', '/api/v1/shots');
  const picked = pickBoards(boards, shots);
  if (picked.length < 4) throw new Error(`demo has only ${picked.length} distinct shot sizes`);
  const cells = picked.map((b) => renderBoard(b.spec, 'pencil', { overlay: true, code: b.shot_code })).map((svg) => `<div class="cell">${svg}</div>`);
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#1d1e20}
    .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;padding:14px;width:1572px}
    .cell svg{display:block;width:100%;height:auto}
  </style><div class="grid">${cells.join('')}</div>`;
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const sheet = await ctx.newPage();
  await sheet.setContent(html);
  await sheet.waitForTimeout(300);
  const path = join(OUT, 'pencil-boards.png');
  await sheet.locator('.grid').screenshot({ path });
  await ctx.close();
  await report(path);
}

async function screenshots(page: Page): Promise<void> {
  const take = async (name: string) => {
    await settle(page);
    const path = join(OUT, `${name}.png`);
    await page.screenshot({ path });
    await report(path);
  };
  await stage(page, '剧本');
  await take('script');
  // S5 体检: the length estimate and the recorded difficulties, beside the script
  await page.getByRole('button', { name: /^体检/ }).click();
  const check = page.getByRole('region', { name: '剧本体检' });
  await check.getByRole('button', { name: '找出拍摄难点' }).click();
  await page.getByRole('dialog', { name: '剧本体检' }).getByRole('button', { name: '开始体检' }).click();
  await check.getByText(/条 · 未处理/).waitFor({ timeout: 30_000 });
  await take('check');
  await page.getByRole('button', { name: /^体检/ }).click();
  await stage(page, '分镜');
  await take('boards');
  await stage(page, '计划');
  await take('plan');
  await stage(page, '现场');
  await take('set');
  await stage(page, '素材');
  await take('media');
  await stage(page, '交付');
  await take('deliver');
  // S5a 粘贴整理: the sample chat sorted by kind, reviewed before anything is written
  await stage(page, '计划');
  await page.getByRole('button', { name: '粘贴整理', exact: true }).first().click();
  const paste = page.getByRole('dialog', { name: '粘贴整理' });
  await paste.getByRole('button', { name: '填入示例' }).click();
  await paste.getByRole('button', { name: '整理', exact: true }).click();
  await paste.getByRole('button', { name: '确认发送' }).click();
  await paste.getByRole('heading', { name: /演员档期/ }).waitFor({ timeout: 30_000 });
  await take('paste');
  await paste.getByRole('button', { name: '关闭' }).click();
}

/**
 * Chrome's own screencast (CDP) records the tour: frames arrive only when the
 * page changes, each with a timestamp, and ffmpeg's concat demuxer holds each
 * frame for its real duration. No extra recorder download.
 */
async function heroGif(browser: Browser, app: RunningApp): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: GIF.width, height: GIF.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await signInAnywhere(page, app);
  // visit every page once so lazy chunks and queries are warm: no spinners in the recording
  for (const label of ['计划', '现场', '素材', '交付', '分镜']) {
    await stage(page, label);
    await settle(page, 300);
  }
  await settle(page, 600);

  const dir = join(app.tmp, 'frames');
  await mkdir(dir, { recursive: true });
  const frames: { file: string; t: number }[] = [];
  const writes: Promise<void>[] = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    writes.push(writeFile(file, Buffer.from(f.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: GIF.width, maxHeight: GIF.height });
  await page.waitForTimeout(900);

  // boards: step through a few shots in the strip, then walk the workflow bar
  const strip = page.getByRole('button', { name: /^镜 / });
  const n = await strip.count();
  for (const i of [1, 3, 5].filter((k) => k < n)) {
    await strip.nth(i).click();
    await page.waitForTimeout(1300);
  }
  for (const label of ['计划', '现场', '素材', '交付']) {
    await stage(page, label);
    await settle(page, label === '素材' ? 2000 : 1500);
  }
  const end = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  await ctx.close();
  if (frames.length < 5) throw new Error(`only ${frames.length} frames captured`);

  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.05, (frames[i + 1]?.t ?? end) - f.t).toFixed(3)}`);
  const listFile = join(dir, 'frames.txt');
  await writeFile(listFile, `${list.join('\n')}\nfile '${frames.at(-1)!.file}'\n`);

  const gif = join(OUT, 'hero.gif');
  const filter = `fps=${GIF.fps},scale=${GIF.outWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', filter, '-loop', '0', gif], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}`);
  await report(gif);
}

async function main(): Promise<void> {
  if (!values['skip-build']) buildWeb();
  await mkdir(OUT, { recursive: true });
  const app = await startApp({ demo: true, noKey: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const ctx = await browser.newContext({ viewport: SHOT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const title = await signInAnywhere(page, app);
    if (title !== '剧本') throw new Error(`expected the demo project's script page, got "${title}"`);
    await screenshots(page);
    await contactSheet(browser, page);
    await ctx.close();
    if (!values['no-gif']) await heroGif(browser, app);
  } finally {
    await browser.close();
    await app.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

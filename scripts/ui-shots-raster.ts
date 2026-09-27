/**
 * AI pencil redraw screenshots (M8, FR-12). Builds the web app, starts the
 * production server (not --demo: demo never sends image requests) under a
 * throwaway STORYSCRIPT_HOME plus a local fake image service, creates two
 * manual shots through the API, then walks the UI in the installed Chrome:
 * settings → image model (configured, free check, paid-trial confirmation),
 * the redraw confirmation, the candidate list, the onion skin at 50 %, the
 * adopted frame ("AI 图 + 标注" and the corner mark), the stale state and the
 * print preview — at 1440x900 and 390x844. PNGs go to .look/ui-raster/.
 *
 * The fake echoes the control image it received (openai-edits multipart), so
 * the "AI" raster is the pencil frame without annotations after the server's
 * post-processing: the onion skin shows whether raster and frame line up.
 * `--fake color` uses the test suite's FakeImage (a coloured test card).
 *
 *   npx tsx scripts/ui-shots-raster.ts [--no-build] [--out .look/ui-raster] [--fake echo|color]
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import type { ScriptImportResult, ShotFields } from '@storyscript/contracts';
import { startFakeImage } from '../apps/server/test/helpers/fake-image.ts';
import { api, BOOKSHOP, buildWeb, createProject, ROOT, signIn, startApp, type RunningApp } from '../e2e/support.ts';

interface Size {
  name: string;
  width: number;
  height: number;
}

const DESKTOP: Size = { name: '1440', width: 1440, height: 900 };
const PHONE: Size = { name: '390', width: 390, height: 844 };
const KEY = 'sk-local-test-0000-shots-7c1e';

// ---------------------------------------------------------------- fakes

interface Fake {
  url: string;
  close(): Promise<void>;
}

/** openai-edits echo: returns the uploaded control image as the "generated" one. */
async function startEchoImage(): Promise<Fake> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0];
        const json = (status: number, body: unknown) => {
          const text = JSON.stringify(body);
          res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
          res.end(text);
        };
        if (req.method === 'GET' && path === '/v1/models') return json(200, { object: 'list', data: [{ id: 'echo-image-model', object: 'model' }] });
        if (req.method === 'POST' && path === '/v1/images/edits') {
          const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
          const file = form.getAll('image[]').find((v): v is File => typeof v !== 'string');
          if (!file) return json(400, { error: { message: 'no image' } });
          const b64 = Buffer.from(await file.arrayBuffer()).toString('base64');
          await new Promise((r) => setTimeout(r, 1200)); // long enough to see the job running
          return json(200, { created: 0, data: [{ b64_json: b64 }], usage: { input_tokens: 1310, output_tokens: 4160, total_tokens: 5470 } });
        }
        return json(404, { error: { message: 'Not found' } });
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

// ------------------------------------------------------------- helpers

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(350);
}

async function shot(page: Page, out: string, size: Size, name: string, list: string[], target?: Locator, fullPage = false): Promise<void> {
  await settle(page);
  const path = join(out, `${size.name}-${name}.png`);
  if (target) await target.screenshot({ path });
  else await page.screenshot({ path, fullPage });
  list.push(path);
  const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  if (overflow > 0) console.warn(`  ! ${size.name}-${name}: page scrolls sideways by ${overflow}px`);
  console.log(`  ${path}`);
}

function fields(p: Partial<ShotFields> & Pick<ShotFields, 'source'>): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: [],
    props: [],
    env: 'interior',
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 4,
    narrative_purpose: '',
    action: '',
    dialogue_quote: null,
    assumptions: [],
    questions: [],
    ...p,
  };
}

const subject = (alias: string, screen: 'L' | 'C' | 'R', facing: ShotFields['subjects'][number]['facing'] = null) => ({ alias, screen, depth: null, facing, pose: null });

async function setupShots(page: Page): Promise<void> {
  const text = await readFile(BOOKSHOP, 'utf8');
  const imported = await api<ScriptImportResult>(page, 'POST', '/api/v1/scripts', { text, source_name: '01-bookshop.txt', format: 'txt', heading_overrides: [] });
  const scene = imported.scenes[0]!;
  await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] });
  await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '林晓', aliases: [] });
  const source = { paragraph_id: scene.paragraph_ids[1]!, quote: '' };
  await api(page, 'POST', '/api/v1/shots', {
    scene_id: scene.id,
    fields: fields({
      shot_size: 'MS',
      subjects: [subject('c1', 'L', 'screen_right'), subject('c2', 'R', 'screen_left')],
      props: ['table'],
      action: '老周把《某片》的旧海报递给林晓',
      source,
    }),
    manual_note: '截图用两人镜头',
  });
  await api(page, 'POST', '/api/v1/shots', {
    scene_id: scene.id,
    fields: fields({ shot_size: 'EWS', angle: 'low', lens: 'wide', set_piece: true, env: 'open', props: ['building'], subjects: [subject('c2', 'C', 'away')], action: '林晓站在旧楼前抬头', source }),
    manual_note: '截图用大场面',
  });
}

async function frameReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    type Img = { complete: boolean; naturalWidth: number };
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Img> } }).document;
    const imgs = Array.from(doc.querySelectorAll('img'));
    return imgs.length > 0 && imgs.every((i) => i.complete);
  });
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}

// ------------------------------------------------------------- walks

async function desktop(browser: Browser, app: RunningApp, fakeUrl: string, model: string, out: string): Promise<string[]> {
  const list: string[] = [];
  const size = DESKTOP;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) console.warn(`  ! console: ${msg.text()}`);
  });
  await signIn(page, app);
  await createProject(page, join(app.projectsDir, '周末短片'), '周末短片');
  await setupShots(page);

  // the board page before an image model is configured
  await page.goto(`${app.base}/#/boards`);
  await page.locator('button[data-shot]').first().click();
  await frameReady(page);
  await shot(page, out, size, '30-board-unconfigured', list);

  // settings → 模型
  await page.goto(`${app.base}/#/settings`);
  await page.getByRole('tab', { name: '模型' }).click();
  const form = page.getByRole('region', { name: '图像模型 · 连接设置' });
  await form.scrollIntoViewIfNeeded();
  await shot(page, out, size, '31-settings-image-empty', list);
  await form.getByLabel('地址（base_url）').fill(fakeUrl);
  await form.getByLabel('模型', { exact: true }).fill(model);
  await form.getByLabel('API key').fill(KEY);
  await form.getByRole('button', { name: '保存' }).click();
  await page.getByRole('region', { name: '图像模型（实验）' }).getByText('已配置').waitFor();
  await form.getByRole('button', { name: '免费检查' }).click();
  await form.getByRole('status').filter({ hasText: '免费检查' }).waitFor();
  await page.getByRole('region', { name: '图像模型（实验）' }).scrollIntoViewIfNeeded();
  await shot(page, out, size, '32-settings-image-configured', list);
  const panel = page.getByRole('tabpanel');
  await shot(page, out, size, '33-settings-image-panel', list, panel);
  await form.getByRole('button', { name: '付费试生成…' }).click();
  await shot(page, out, size, '34-settings-paid-confirm', list);
  await page.getByRole('dialog', { name: '付费试生成' }).getByRole('button', { name: '取消' }).click();

  // board page: the confirmation
  await page.goto(`${app.base}/#/boards`);
  await page.locator('button[data-shot]').nth(1).click();
  await frameReady(page);
  await shot(page, out, size, '35-board-set-piece-recommended', list);
  await page.locator('button[data-shot]').first().click();
  await frameReady(page);
  await page.getByRole('button', { name: 'AI 铅笔重绘（实验）' }).click();
  const confirm = page.getByRole('dialog', { name: /AI 铅笔重绘/ });
  await confirm.locator('img[data-control-preview]').waitFor();
  await shot(page, out, size, '36-redraw-confirm', list);
  await confirm.getByRole('button', { name: '确认发送' }).click();
  await page.locator('[data-redraw-job]').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await shot(page, out, size, '37-redraw-running', list);

  // candidate list + onion skin at 50 %
  const items = page.getByRole('list', { name: 'AI 候选列表' }).getByRole('listitem');
  await items.first().waitFor({ timeout: 60_000 });
  await page.locator('[data-ai-layer="onion"]').waitFor();
  await frameReady(page);
  await shot(page, out, size, '38-onion-50', list);
  const sheet = page.getByRole('region', { name: '镜 001 分镜稿' });
  await shot(page, out, size, '39-onion-50-frame', list, sheet);
  const candidates = page.getByRole('list', { name: 'AI 候选列表' });
  await candidates.scrollIntoViewIfNeeded();
  await shot(page, out, size, '40-candidates', list);
  const bar = page.getByRole('group', { name: 'AI 图层' });
  await bar.getByRole('radio', { name: '只看 AI 图' }).click();
  await shot(page, out, size, '41-ai-only-frame', list, sheet);

  // adopt → AI + annotations with the corner mark
  await bar.getByRole('button', { name: '采用' }).click();
  await page.locator('[data-ai-layer="overlay"]').waitFor();
  await page.getByRole('toolbar', { name: '分镜稿工具' }).scrollIntoViewIfNeeded();
  await frameReady(page);
  await shot(page, out, size, '42-adopted', list);
  await shot(page, out, size, '43-adopted-frame', list, sheet);

  // stale: a structure edit
  await dragBy(page, sheet.locator('[data-handle="foot"]').first(), 90, 10);
  await page.getByRole('status').filter({ hasText: '镜头构图已改' }).first().waitFor();
  await shot(page, out, size, '44-stale', list);
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByRole('status').filter({ hasText: '镜头构图已改' }).first().waitFor({ state: 'detached' });

  // print preview with the adopted raster
  await page.getByRole('button', { name: '打印分镜' }).click();
  await page.getByRole('button', { name: '打印', exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('[data-ai-raster]').first().waitFor();
  await shot(page, out, size, '45-print-preview', list);
  await page.emulateMedia({ media: 'print' });
  await shot(page, out, size, '46-print-media', list, undefined, true);
  await page.pdf({ path: join(out, 'boards-ai.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: '返回分镜' }).click();

  // saved structure change: the adoption stays behind on v1
  await dragBy(page, sheet.locator('[data-handle="foot"]').first(), 90, 10);
  await page.getByRole('button', { name: '保存为新版本' }).click();
  await page.getByText('v2 · 手动调整').first().waitFor();
  await page.getByRole('list', { name: 'AI 候选列表' }).scrollIntoViewIfNeeded();
  await shot(page, out, size, '47-left-behind', list);
  await context.close();
  return list;
}

async function phone(browser: Browser, app: RunningApp, out: string): Promise<string[]> {
  const list: string[] = [];
  const size = PHONE;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn(`  ! page error: ${err.message}`));
  await page.goto(`${app.base}/#t=${app.token}`);
  await page.getByRole('navigation', { name: '工作流程' }).getByRole('link', { name: /剧本/ }).waitFor();
  await page.goto(`${app.base}/#/boards`);
  await page.getByRole('tab', { name: '镜头' }).click();
  await page.locator('button[data-shot]').first().click();
  await frameReady(page);
  await shot(page, out, size, '30-board', list);
  const items = page.getByRole('list', { name: 'AI 候选列表' });
  await items.scrollIntoViewIfNeeded();
  await shot(page, out, size, '31-candidates', list);
  await items.getByRole('button', { name: '对比', exact: true }).first().click();
  await page.getByRole('group', { name: 'AI 图层' }).scrollIntoViewIfNeeded();
  await shot(page, out, size, '32-onion', list);
  await page.getByRole('button', { name: 'AI 铅笔重绘（实验）' }).click();
  await page.getByRole('dialog', { name: /AI 铅笔重绘/ }).locator('img[data-control-preview]').waitFor();
  await shot(page, out, size, '33-redraw-confirm', list);
  await page.getByRole('dialog', { name: /AI 铅笔重绘/ }).getByRole('button', { name: '取消' }).click();
  await page.goto(`${app.base}/#/settings`);
  await page.getByRole('tab', { name: '模型' }).click();
  await page.getByRole('region', { name: '图像模型（实验）' }).scrollIntoViewIfNeeded();
  await shot(page, out, size, '34-settings-image', list);
  await context.close();
  return list;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'no-build': { type: 'boolean', default: false }, out: { type: 'string' }, fake: { type: 'string', default: 'echo' } } });
  const out = resolve(ROOT, values.out ?? '.look/ui-raster');
  await mkdir(out, { recursive: true });
  if (!values['no-build']) buildWeb();
  for (const k of ['STORYSCRIPT_IMAGE_BASE_URL', 'STORYSCRIPT_IMAGE_API_KEY', 'STORYSCRIPT_IMAGE_MODEL']) delete process.env[k];
  const color = values.fake === 'color';
  const fake: Fake = color ? await startFakeImage() : await startEchoImage();
  const model = color ? 'fake-image-model' : 'echo-image-model';
  const app = await startApp();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    const all = [...(await desktop(browser, app, fake.url, model, out)), ...(await phone(browser, app, out))];
    console.log(`${all.length} screenshots in ${out}`);
  } catch (err) {
    console.error(`--- server output ---\n${app.log()}`);
    throw err;
  } finally {
    await browser?.close();
    await app.stop();
    await fake.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

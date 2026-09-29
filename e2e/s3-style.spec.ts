import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BreakdownOutput, ScriptImportResult, StyleResearchOutput } from '@storyscript/contracts';
import { BUILTIN_STYLES } from '@storyscript/core';
import { reply, startFakeOpenAI, type FakeOpenAI } from '../apps/server/test/helpers/fake-openai.ts';
import { api, BOOKSHOP, createProject, ROOT, SCENE_1, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S3 (fake OpenAI service on 127.0.0.1, no key in the server's environment):
 * settings → 模型 (research model, web-search switch) → 风格 opens the style
 * library → 研究新风格 (one request, unverified draft) → edited and saved as a
 * card → set as the group default → the scene's AI 拆镜 form starts with that
 * style and difficulty → 挑战 + a note → the request carries them → the draft
 * review opens. Also: copying a built-in card, editing and deleting it, the
 * form's own checks, and the 风格 button on a phone-sized window.
 */

const REFERENCE = '某部赛车电影的车载运镜';
const CARD_NAME = '我们的赛道感';

const RESEARCH: StyleResearchOutput = {
  name: '贴地速度：车载与长焦',
  summary: '低机位、车身硬挂和长焦压缩表现速度。',
  grammar: '贴地：机位放低，路面高速掠过。\n车载：车头、车侧、驾驶位三个固定视角。\n长焦：弯道外侧压缩前后车距离。',
  shot_size_bias: ['CU', 'WS'],
  angle_bias: ['low'],
  lens_bias: ['tele'],
  movement_bias: ['vehicle', 'aerial'],
  gear: '车载支架、跟拍车',
  low_budget: '用自行车代替，手机贴地慢速跟拍',
  confidence: 'medium',
  caveats: ['具体机位需要看片核实'],
};

const SCENE1 = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'replay', '01-bookshop.breakdown-v1.scene-1.json'), 'utf8')) as { output_json: BreakdownOutput }).output_json;

let app: RunningApp;
let fake: FakeOpenAI;

test.beforeAll(async () => {
  fake = await startFakeOpenAI();
  // no model settings in the server's environment: the settings page decides
  app = await startApp({ noKey: true });
});

test.afterAll(async () => {
  await app?.stop();
  await fake?.close();
});

test('S3 styles: research (a failure, then a success) → card → default → breakdown form → request → draft', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-style'), '风格库测试');

  // ---- settings → 模型: research model and the web-search switch
  await test.step('configure the text model with a research model', async () => {
    await page.goto(`${app.base}/#/settings`);
    await page.getByRole('tab', { name: '模型' }).click();
    const form = page.getByRole('region', { name: '连接设置', exact: true });
    await form.getByLabel('地址（base_url）').fill(fake.url);
    await form.getByLabel('模型', { exact: true }).fill('fake-model');
    await form.getByLabel('API key').fill('sk-e2e-style-1234');
    await expect(form.getByLabel('研究用模型')).toHaveAttribute('placeholder', '不填就用上面的模型');
    await form.getByLabel('研究用模型').fill('fake-research-model');
    await form.getByRole('checkbox', { name: '研究风格时联网搜索' }).check();
    // 127.0.0.1 is no service we know a search flag for
    await expect(form.getByText('这个服务商没有我们已知的联网参数，研究时只用模型自己的知识。')).toBeVisible();
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form.getByText('已保存。')).toBeVisible();
    await expect(form.getByLabel('研究用模型')).toHaveValue('fake-research-model');
    await expect(form.getByRole('checkbox', { name: '研究风格时联网搜索' })).toBeChecked();
  });

  // ---- the bookshop script and its roster, then the script page
  await test.step('import the bookshop script', async () => {
    const text = readFileSync(BOOKSHOP, 'utf8');
    await api<ScriptImportResult>(page, 'POST', '/api/v1/scripts', { text, source_name: '01-bookshop.txt', format: 'txt', heading_overrides: [] });
    await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '周明远', aliases: ['老周'] });
    await api(page, 'POST', '/api/v1/entities', { type: 'character', name: '林晓', aliases: [] });
    await page.goto(`${app.base}/#/script`);
    await page.reload();
    await page.getByRole('region', { name: SCENE_1, exact: true }).waitFor();
  });

  const library = page.getByRole('dialog', { name: '风格库' });

  // ---- 风格 button → the library, research a new style
  await test.step('research a style: one request, an unverified draft', async () => {
    await page.getByRole('button', { name: '风格', exact: true }).click();
    await expect(library).toBeVisible();
    const defaults = library.getByRole('region', { name: '本组默认', exact: true });
    await expect(defaults.getByLabel('风格', { exact: true }).locator('option:checked')).toHaveText('不指定');
    await expect(defaults.getByRole('button', { name: '稳妥', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(library.getByRole('region', { name: '内置风格卡', exact: true }).getByRole('listitem')).toHaveCount(BUILTIN_STYLES.length);

    const research = library.getByRole('region', { name: '研究新风格', exact: true });
    await expect(research.getByText('最多外发 3 次')).toBeVisible();
    await expect(research.getByText('通用手法建议（未核实）')).toBeVisible();
    await research.getByLabel('参考', { exact: true }).fill(REFERENCE);
    await research.getByLabel('补充说明（可不填）').fill('只有一台手机和一副稳定器');
    // a provider that refuses the key fails the job with its reason (one request); the button works again
    fake.enqueue({ type: 'status', status: 401, message: 'Incorrect API key provided' });
    await research.getByRole('button', { name: '研究', exact: true }).click();
    const failed = research.getByRole('status').filter({ hasText: '风格研究 失败' });
    await expect(failed).toBeVisible({ timeout: 30_000 });
    expect(fake.chatRequests()).toHaveLength(1);
    await expect(research.getByRole('button', { name: '研究', exact: true })).toBeEnabled();
    await failed.getByRole('button', { name: '关闭任务状态' }).click();
    await expect(failed).toHaveCount(0);

    fake.enqueue(reply.json(RESEARCH));
    await research.getByRole('button', { name: '研究', exact: true }).click();

    const draft = research.getByRole('form', { name: '研究结果（草案）' });
    await expect(draft).toBeVisible({ timeout: 30_000 });
    // one more request, on the research model; nothing but the reference and the notes came from the user
    expect(fake.chatRequests()).toHaveLength(2);
    const sent = fake.chatRequests()[1]!.body!;
    expect(sent.model).toBe('fake-research-model');
    expect(sent as Record<string, unknown>).not.toHaveProperty('enable_search');
    expect(sent.messages!.at(-1)!.content).toContain(REFERENCE);

    const review = research.getByRole('region', { name: '研究结果', exact: true });
    await expect(review.getByText('未核实', { exact: true })).toBeVisible();
    await expect(review.getByText('模型自评把握：中')).toBeVisible();
    await expect(review.getByText('具体机位需要看片核实')).toBeVisible();
    await expect(review.getByText(`参考：${REFERENCE}`)).toBeVisible();
    await expect(draft.getByLabel('名称')).toHaveValue(RESEARCH.name);
    await expect(draft.getByRole('group', { name: '偏好运镜' }).getByRole('button', { name: '航拍', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // review, rename and save
    await draft.getByLabel('名称').fill(CARD_NAME);
    await page.screenshot({ path: test.info().outputPath('research-review.png') });
    await draft.getByRole('button', { name: '保存为风格卡' }).click();
    await expect(research.getByRole('status').filter({ hasText: `已保存为风格卡「${CARD_NAME}」` })).toBeVisible();
    await expect(draft).toHaveCount(0);
  });

  // ---- it is a group card, marked 未核实, with the reference the user typed
  await test.step('the card is listed under 本组的风格卡', async () => {
    const own = library.getByRole('region', { name: '本组的风格卡', exact: true });
    const item = own.getByRole('listitem').filter({ hasText: CARD_NAME });
    await expect(item).toHaveCount(1);
    await expect(item.getByText('未核实', { exact: true })).toBeVisible();
    await expect(item.getByText(REFERENCE)).toBeVisible();
    await item.getByText('展开详情').click();
    await expect(item.getByText('贴地：机位放低，路面高速掠过。', { exact: false })).toBeVisible();
    await expect(item.getByText('航拍', { exact: true })).toBeVisible();

    await item.getByRole('button', { name: `设为默认：${CARD_NAME}` }).click();
    await expect(item.getByText('本组默认', { exact: true })).toBeVisible();
    const defaults = library.getByRole('region', { name: '本组默认', exact: true });
    await expect(defaults.getByLabel('风格', { exact: true }).locator('option:checked')).toHaveText(CARD_NAME);
    await defaults.getByRole('button', { name: '进取', exact: true }).click();
    await expect(defaults.getByRole('button', { name: '进取', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(defaults.getByText('允许长镜头调度')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('style-library.png') });
  });

  // ---- a built-in card: copy it, edit the copy, delete it
  await test.step('copy a built-in card, edit the copy, delete it; the form checks its own fields', async () => {
    const builtin = BUILTIN_STYLES[0]!;
    const copyName = `${builtin.name}（副本）`;
    const own = library.getByRole('region', { name: '本组的风格卡', exact: true });
    await library.getByRole('region', { name: '内置风格卡', exact: true }).getByRole('button', { name: `复制一份再改：${builtin.name}` }).click();
    const edit = library.getByRole('form', { name: `编辑风格卡：${copyName}` });
    await expect(edit).toBeVisible();
    await expect(edit.getByLabel('名称')).toBeFocused();
    await edit.getByLabel('名称').fill('');
    await edit.getByRole('button', { name: '保存修改' }).click();
    await expect(edit.getByText('请填写名称')).toBeVisible();
    await edit.getByLabel('名称').fill('赛道贴地（改）');
    await edit.getByRole('button', { name: '保存修改' }).click();
    const copy = own.getByRole('listitem').filter({ hasText: '赛道贴地（改）' });
    await expect(copy).toHaveCount(1);
    await copy.getByRole('button', { name: '删除：赛道贴地（改）' }).click();
    await copy.getByRole('button', { name: '确认删除：赛道贴地（改）' }).click();
    await expect(copy).toHaveCount(0);

    await own.getByRole('button', { name: '新建风格卡' }).click();
    const fresh = library.getByRole('form', { name: '新建风格卡' });
    await expect(fresh).toBeVisible();
    await fresh.getByRole('button', { name: '保存风格卡' }).click();
    await expect(fresh.getByText('请填写名称')).toBeVisible();
    await expect(fresh.getByText('请写下镜头语言：运镜、镜头、构图和节奏')).toBeVisible();
    await fresh.getByRole('button', { name: '取消' }).click();
    await expect(fresh).toHaveCount(0);
    await library.getByRole('button', { name: '关闭' }).click();
    await expect(library).toHaveCount(0);
  });

  // ---- the scene's AI 拆镜 form starts with the group's default
  await test.step('the breakdown form is preselected; 挑战 and a note reach the model', async () => {
    const scene1 = page.getByRole('region', { name: SCENE_1, exact: true });
    await scene1.getByRole('button', { name: 'AI 拆镜' }).click();
    const style = page.getByLabel('风格', { exact: true });
    await expect(style.locator('option:checked')).toHaveText(CARD_NAME);
    await expect(page.getByRole('button', { name: '进取', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('风格要求')).toHaveAttribute('maxlength', '800');
    await expect(page.getByText('作为数据发给模型，输出为通用手法建议（未核实），不会引用具体影片的镜头。')).toBeVisible();

    await page.getByRole('button', { name: '挑战', exact: true }).click();
    await expect(page.getByRole('button', { name: '挑战', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '进取', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.getByLabel('风格要求').fill('节奏更快，多用低机位');
    await expect(page.getByText(`风格说明（${CARD_NAME}）`)).toBeVisible();
    await expect(page.getByText('你写的风格要求')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('breakdown-form.png') });

    fake.enqueue(reply.json(SCENE1));
    await page.getByRole('button', { name: '开始拆镜' }).click();
    const draft = page.getByRole('dialog', { name: /AI 拆镜草案 · 第 1 场/ });
    await draft.getByRole('button', { name: /应用所选/ }).waitFor({ timeout: 30_000 });

    // the second request carried the style card and the level, but not the reference the user typed
    expect(fake.chatRequests()).toHaveLength(3);
    const bodies = fake.chatRequests()[2]!.body!.messages!;
    const system = bodies[0]!.content;
    const user = bodies[1]!.content;
    expect(system).toContain('【难度：挑战】');
    expect(user).toContain(`【风格】${CARD_NAME}`);
    expect(user).toContain('贴地：机位放低');
    expect(user).toContain('节奏更快，多用低机位');
    expect(user).not.toContain(REFERENCE);
    // the draft is the model's output, waiting for a tick
    await draft.getByRole('button', { name: '放弃草案' }).click();
    await draft.waitFor({ state: 'detached' });
  });

  // ---- the 风格 button on a phone-sized window
  await test.step('narrow screen: 风格 opens the library', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '风格', exact: true }).click();
    await expect(library).toBeVisible();
    await expect(library.getByRole('heading', { name: '风格库', level: 2 })).toBeVisible();
    await expect(library.getByRole('button', { name: `设为默认：${BUILTIN_STYLES[1]!.name}` })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('style-library-narrow.png') });
    await library.getByRole('button', { name: '关闭' }).click();
    await expect(library).toHaveCount(0);

    // the breakdown form (a drawer here) links to the same library
    await page.getByRole('region', { name: SCENE_1, exact: true }).getByRole('button', { name: 'AI 拆镜' }).click();
    const drawer = page.getByRole('dialog', { name: /第 1 场/ });
    await drawer.getByRole('button', { name: '管理风格…' }).click();
    await expect(library).toBeVisible();
    await library.getByRole('button', { name: '关闭' }).click();
    await expect(library).toHaveCount(0);
    await expect(drawer.getByLabel('风格', { exact: true })).toBeVisible();
  });

  expect(pageErrors).toEqual([]);
});

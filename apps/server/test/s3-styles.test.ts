import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BreakdownOutput, DraftDetail, Job, ProvidersView, StyleCard, StyleCardInput, StyleLibrary, StyleResearchOutput } from '@storyscript/contracts';
import { searchBody, searchSupport } from '../src/config/text-provider.ts';
import { startFakeOpenAI, reply, type FakeOpenAI } from './helpers/fake-openai.ts';
import { bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * S3: the style library (built-in + group cards, defaults), style research
 * through the group's own model (web search flag, fallback when refused),
 * and breakdown requests that carry a style and a level (breakdown-v2).
 */

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

const CARD: StyleCardInput = {
  name: '雨夜霓虹',
  summary: '湿地面反光、霓虹色、慢推。',
  grammar: '反光：拍湿地面上的倒影。\n慢推：人物停下时缓慢推近。',
  bias: { shot_size: ['CU'], angle: ['low'], lens: ['tele'], movement: ['push_in'] },
  gear: '喷壶、彩色灯',
  low_budget: '手机手电加彩色玻璃纸',
};

let fake: FakeOpenAI;
let app: M3App;

const library = async () => (await app.get<StyleLibrary>('/api/v1/styles')).data;

async function research(reference = '某位导演某部赛车片的运镜'): Promise<{ job: Job; detail: DraftDetail }> {
  const res = await app.post<{ job_id: string }>('/api/v1/styles/research', { reference, notes: null });
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  const detail = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
  return { job, detail: detail.data };
}

beforeEach(async () => {
  fake = await startFakeOpenAI();
  app = await makeM3App({ env: llmEnv(fake.url) });
});

afterEach(async () => {
  app.close();
  await fake.close();
});

describe('style library', () => {
  test('built-in cards come first; a group card can be created, edited, made default and deleted', async () => {
    const lib = await library();
    expect(lib.cards.filter((c) => c.origin === 'builtin')).toHaveLength(8);
    expect(lib.defaults).toEqual({ style_id: null, level: 'steady' });

    const created = await app.post<StyleCard>('/api/v1/styles', CARD);
    expect(created.status, created.text).toBe(201);
    expect(created.data).toMatchObject({ ...CARD, origin: 'custom', unverified: false, reference: null });

    const edited = await app.put<StyleCard>(`/api/v1/styles/${created.data.id}`, { ...CARD, name: '雨夜霓虹·慢' });
    expect(edited.data.name).toBe('雨夜霓虹·慢');

    const d = await app.put<StyleLibrary>('/api/v1/styles/defaults', { style_id: created.data.id, level: 'bold' });
    expect(d.data.defaults).toEqual({ style_id: created.data.id, level: 'bold' });

    const del = await app.raw('DELETE', `/api/v1/styles/${created.data.id}`);
    expect(del.status).toBe(200);
    const after = await library();
    expect(after.cards.some((c) => c.id === created.data.id)).toBe(false);
    // deleting the default card clears it, the level stays
    expect(after.defaults).toEqual({ style_id: null, level: 'bold' });
  });

  test('built-in cards are read-only; unknown ids are refused', async () => {
    const put = await app.put('/api/v1/styles/style.track-low', CARD);
    expect(put.status).toBe(403);
    const bad = await app.put('/api/v1/styles/defaults', { style_id: 'style.nope', level: 'steady' });
    expect(bad.status).toBe(400);
  });
});

describe('style research', () => {
  test('one call → a draft with the unverified note → saved as a researched card', async () => {
    fake.enqueue(reply.json(RESEARCH));
    const { job, detail } = await research();
    expect(job.status).toBe('succeeded');
    expect(job.kind).toBe('research_style');
    expect(fake.chatRequests()).toHaveLength(1);
    const sent = fake.chatRequests()[0]!.body!;
    expect(sent.messages![1]!.content).toContain('某位导演某部赛车片的运镜');
    // no search flag unless turned on
    expect(sent as Record<string, unknown>).not.toHaveProperty('enable_search');
    expect(detail.draft.kind).toBe('style');
    expect(detail.draft.issues.map((i) => i.code)).toContain('reference_unverified');

    const saved = await app.post<StyleCard>(`/api/v1/drafts/${detail.draft.id}/save-style`, { ...CARD, name: '我们的赛道感' });
    expect(saved.status, saved.text).toBe(201);
    expect(saved.data).toMatchObject({ origin: 'researched', unverified: true, reference: '某位导演某部赛车片的运镜', name: '我们的赛道感' });
    const again = await app.post(`/api/v1/drafts/${detail.draft.id}/save-style`, CARD);
    expect(again.status).toBe(409);
  });

  test('a titled name goes back for repair (2 calls)', async () => {
    fake.enqueue(reply.json({ ...RESEARCH, name: '《某片》式运镜' }), reply.json(RESEARCH));
    const { job } = await research();
    expect(job.status).toBe('succeeded');
    expect(fake.chatRequests()).toHaveLength(2);
    expect(fake.chatRequests()[1]!.body!.messages!.at(-1)!.content).toContain('name 不要包含片名');
  });

  test('the research model is used; a service without a known search flag gets none', async () => {
    const saved = await app.put<ProvidersView>('/api/v1/settings/providers/text', {
      base_url: fake.url,
      model: 'fake-model',
      research_model: 'fake-search-model',
      research_search: true,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.data.text).toMatchObject({ research_model: 'fake-search-model', research_search: true, search_support: null });
    // the fake runs on 127.0.0.1, which takes no search flag: nothing extra is sent
    fake.enqueue(reply.json(RESEARCH));
    await research();
    const body = fake.chatRequests()[0]!.body! as Record<string, unknown>;
    expect(body.model).toBe('fake-search-model');
    expect(body).not.toHaveProperty('enable_search');
  });

  test('research counts against the hosted daily cap', async () => {
    app.handle.deps.hosted = { slug: 'g1', name: '一组', limits: { llm_jobs_per_day: 1, image_jobs_per_day: 1 } };
    fake.enqueue(reply.json(RESEARCH));
    await research();
    const second = await app.post('/api/v1/styles/research', { reference: '另一个参考', notes: null });
    expect(second.status).toBe(409);
    expect(second.text).toContain('QUOTA_EXCEEDED');
  });
});

describe('search flags by service', () => {
  test('dashscope takes enable_search; OpenAI only with a search model; others none', () => {
    expect(searchSupport('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('dashscope');
    expect(searchBody('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus')).toEqual({ enable_search: true });
    expect(searchBody('https://api.openai.com/v1', 'gpt-4o-search-preview')).toEqual({ web_search_options: {} });
    expect(searchBody('https://api.openai.com/v1', 'gpt-4o')).toBeNull();
    expect(searchSupport('https://api.deepseek.com/v1')).toBeNull();
  });
});

describe('breakdown with a style and a level', () => {
  const SCENE1 = replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput;

  async function sceneId(): Promise<string> {
    const imported = await importFixture(app, '01-bookshop.txt', 'txt');
    await bookshopRoster(app);
    return imported.scenes[0]!.id;
  }

  test('style and level in the messages; draft marked breakdown-v3 (S4c: v3 replaced v2)', async () => {
    const id = await sceneId();
    fake.enqueue(reply.json({ shots: SCENE1.shots.slice(0, 2) }));
    const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${id}/breakdown`, {
      technique_id: null,
      reference_note: '更快',
      max_shots: 8,
      target_seconds: null,
      style_id: 'style.track-low',
      level: 'extreme',
    });
    expect(res.status, res.text).toBe(202);
    const job = await waitJob(app, res.data.job_id);
    expect(job.status).toBe('succeeded');
    const sent = fake.chatRequests()[0]!.body!;
    expect(sent.messages![0]!.content).toContain('【难度：挑战】');
    expect(sent.messages![1]!.content).toContain('【风格】赛道贴地');
    const detail = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
    expect(detail.data.draft.prompt_version).toBe('breakdown-v4');
  });

  test('old-style requests (no style, no level) send breakdown-v3 at 稳妥 (S4c; v1 is --demo only)', async () => {
    const id = await sceneId();
    fake.enqueue(reply.json({ shots: SCENE1.shots.slice(0, 2) }));
    const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${id}/breakdown`, { technique_id: null, reference_note: null, max_shots: 8, target_seconds: null });
    const job = await waitJob(app, res.data.job_id);
    const detail = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
    expect(detail.data.draft.prompt_version).toBe('breakdown-v4');
    const system = fake.chatRequests()[0]!.body!.messages![0]!.content;
    expect(system).toContain('【难度：稳妥】');
    expect(system).toContain('宁可少而准');
  });

  test('an unknown style is a 400 before anything is sent', async () => {
    const id = await sceneId();
    const res = await app.post(`/api/v1/scenes/${id}/breakdown`, { technique_id: null, reference_note: null, max_shots: 8, target_seconds: null, style_id: 'gone', level: 'steady' });
    expect(res.status).toBe(400);
    expect(fake.chatRequests()).toHaveLength(0);
  });
});

describe('web-search body in structuredCall', () => {
  test('sent while accepted; a 400 drops it for the next attempt (both count)', async () => {
    const { FakeChat } = await import('../src/adapters/llm/fake-chat.ts');
    const { structuredCall } = await import('../src/adapters/llm/structured.ts');
    const { z } = await import('zod');
    const Out = z.object({ ok: z.boolean() });
    const chat = new FakeChat([
      { error: { kind: 'http', status: 400, message: 'Unrecognized request argument supplied: enable_search' } },
      { content: JSON.stringify({ ok: true }) },
    ]);
    const res = await structuredCall({
      client: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: 'sk-x', model: 'qwen-plus' },
      chat,
      messages: [{ role: 'user', content: 'u' }],
      schema: Out,
      jsonSchemaName: 'out',
      extraBody: { enable_search: true },
      sleep: async () => undefined,
      backoffMs: 0,
    });
    expect(res.value).toEqual({ ok: true });
    expect(res.attempts).toBe(2);
    expect(chat.requests.map((r) => r.extra_body ?? null)).toEqual([{ enable_search: true }, null]);
    // the response_format stays json_schema: the 400 was about the search flag
    expect(chat.requests.map((r) => r.response_format?.type)).toEqual(['json_schema', 'json_schema']);
  });

  test('a 400 about response_format keeps the search flag and downgrades the format', async () => {
    const { FakeChat } = await import('../src/adapters/llm/fake-chat.ts');
    const { structuredCall } = await import('../src/adapters/llm/structured.ts');
    const { z } = await import('zod');
    const chat = new FakeChat([
      { error: { kind: 'http', status: 400, message: "response_format 'json_schema' is not supported" } },
      { content: JSON.stringify({ ok: true }) },
    ]);
    const res = await structuredCall({
      client: { base_url: 'https://api.openai.com/v1', api_key: 'sk-x', model: 'gpt-4o-search-preview' },
      chat,
      messages: [{ role: 'user', content: 'u' }],
      schema: z.object({ ok: z.boolean() }),
      jsonSchemaName: 'out',
      extraBody: { web_search_options: {} },
      sleep: async () => undefined,
      backoffMs: 0,
    });
    expect(res.value).toEqual({ ok: true });
    expect(chat.requests.map((r) => r.extra_body ?? null)).toEqual([{ web_search_options: {} }, { web_search_options: {} }]);
    expect(chat.requests[1]!.response_format?.type).toBe('json_object');
  });
});

describe('demo mode', () => {
  test('styled breakdowns, polish and research are refused with a clear message; plain breakdown replays', async () => {
    const demo = await makeM3App({ demo: true });
    try {
      const imported = await importFixture(demo, '01-bookshop.txt', 'txt');
      const id = imported.scenes[0]!.id;
      const styled = await demo.post(`/api/v1/scenes/${id}/breakdown`, { technique_id: null, reference_note: null, max_shots: 8, target_seconds: null, style_id: 'style.oner', level: 'steady' });
      expect(styled.status).toBe(409);
      expect(styled.text).toContain('演示模式只回放录好的拆镜');
      const research = await demo.post('/api/v1/styles/research', { reference: '某个参考', notes: null });
      expect(research.status).toBe(409);
      const plain = await demo.post(`/api/v1/scenes/${id}/breakdown`, { technique_id: null, reference_note: null, max_shots: 8, target_seconds: null });
      expect(plain.status).toBe(202);
    } finally {
      demo.close();
    }
  });
});

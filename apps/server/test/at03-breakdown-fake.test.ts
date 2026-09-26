import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BreakdownOutput, DraftDetail, Entity, Job, Shot, ShotDraft } from '@storyscript/contracts';
import { startFakeOpenAI, reply, type FakeOpenAI } from './helpers/fake-openai.ts';
import {
  BREAKDOWN_REQUEST,
  bookshopRoster,
  importFixture,
  llmEnv,
  makeM3App,
  replayOutput,
  TEST_KEY,
  waitJob,
  type M3App,
} from './helpers/m3-app.ts';

/**
 * AT-03 (breakdown against a fake OpenAI-compatible HTTP service). The real
 * OpenAIChat transport (openai SDK, maxRetries 0) talks to 127.0.0.1, so the
 * number of requests the fake receives is the number of outbound attempts.
 */

const SCENE1 = replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput;
const good: BreakdownOutput = { shots: SCENE1.shots.slice(0, 3) };

let fake: FakeOpenAI;
let app: M3App;
let sleeps: number[];
let sceneId: string;
let responses: string[];

async function requestBreakdown(body: Record<string, unknown> = BREAKDOWN_REQUEST): Promise<{ job: Job; draft: ShotDraft | null }> {
  const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, body);
  responses.push(res.text);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  responses.push(JSON.stringify(job));
  if (!job.result_ref) return { job, draft: null };
  const d = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
  responses.push(d.text);
  expect(d.status).toBe(200);
  return { job, draft: d.data.draft };
}

const shotsNow = async () => (await app.get<Shot[]>('/api/v1/shots')).data;

beforeEach(async () => {
  fake = await startFakeOpenAI();
  sleeps = [];
  responses = [];
  app = await makeM3App({
    env: llmEnv(fake.url),
    ai: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  sceneId = imported.scenes[0]!.id;
  await bookshopRoster(app);
});

afterEach(async () => {
  // AT-03: the key never shows up in any response body, job row or draft
  for (const text of responses) expect(text).not.toContain(TEST_KEY);
  app.close();
  await fake.close();
});

describe('AT-03 structured output against a fake OpenAI service', () => {
  test('valid JSON on the first try: one request, draft pending without errors', async () => {
    fake.enqueue(reply.json(good));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    expect(job.remote).toBe(true);
    expect(job.attempts).toBe(1);
    expect(fake.chatRequests()).toHaveLength(1);
    const req = fake.chatRequests()[0]!;
    expect(req.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(req.body?.model).toBe('fake-model');
    expect(req.body?.response_format?.type).toBe('json_schema');
    expect(req.body?.response_format?.json_schema?.strict).toBe(true);
    const schema = req.body!.response_format!.json_schema!.schema as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['shots']);
    expect(draft!.status).toBe('pending');
    expect(draft!.kind).toBe('breakdown');
    expect(draft!.attempts).toBe(1);
    expect(draft!.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect((draft!.parsed as BreakdownOutput).shots).toHaveLength(3);
    expect(draft!.usage).toMatchObject({ prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 });
    // INV-03: nothing reaches the shot table before apply
    expect(await shotsNow()).toEqual([]);
  });

  test('code-fenced JSON is accepted without a repair round', async () => {
    fake.enqueue(reply.fenced(good));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    expect(fake.chatRequests()).toHaveLength(1);
    expect(draft!.raw_output).toContain('```json');
  });

  test('invalid JSON → repair round succeeds (2 outbound requests)', async () => {
    fake.enqueue(reply.invalid(), reply.json(good));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(2);
    const reqs = fake.chatRequests();
    expect(reqs).toHaveLength(2);
    const repair = reqs[1]!.body!.messages!;
    expect(repair.at(-2)).toEqual({ role: 'assistant', content: '抱歉，我无法按要求输出。' });
    expect(repair.at(-1)!.role).toBe('user');
    expect(repair.at(-1)!.content).toContain('只输出修正后的完整 JSON');
    expect(draft!.attempts).toBe(2);
    expect(draft!.status).toBe('pending');
  });

  test('persistently invalid JSON → ATTEMPTS_EXHAUSTED after exactly 3 requests', async () => {
    fake.enqueue(reply.invalid(), reply.invalid(), reply.invalid(), reply.json(good));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(job.attempts).toBe(3);
    expect(fake.chatRequests()).toHaveLength(3);
    expect(fake.pending).toBe(1);
    expect(draft!.status).toBe('failed');
    expect(draft!.parsed).toBeNull();
    expect(draft!.issues.some((i) => i.level === 'error' && i.code === 'ATTEMPTS_EXHAUSTED')).toBe(true);
    const apply = await app.post(`/api/v1/drafts/${draft!.id}/apply`, { selected: [0], replace_existing: false, expected_revisions: {} });
    expect(apply.status).toBe(409);
  });

  test('empty content counts as an attempt', async () => {
    fake.enqueue(reply.empty(), reply.json(good));
    const { job } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(2);
    expect(fake.chatRequests()).toHaveLength(2);
  });

  test('unknown character → error fed back; persisting → draft carries the error, cannot be applied, shots unchanged', async () => {
    const bad: BreakdownOutput = structuredClone(good);
    bad.shots[1]!.subjects[0]!.alias = 'c9';
    fake.enqueue(reply.json(bad), reply.json(bad), reply.json(bad));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(fake.chatRequests()).toHaveLength(3);
    // the business error went back to the model
    expect(fake.chatRequests()[1]!.body!.messages!.at(-1)!.content).toContain('c9');

    expect(draft!.status).toBe('pending');
    const err = draft!.issues.find((i) => i.code === 'unknown_alias');
    expect(err).toMatchObject({ level: 'error', item: 1 });

    const before = await shotsNow();
    const apply = await app.post(`/api/v1/drafts/${draft!.id}/apply`, { selected: [0, 1], replace_existing: false, expected_revisions: {} });
    expect(apply.status).toBe(400);
    expect(apply.body.error?.code).toBe('VALIDATION_ERROR');
    expect(await shotsNow()).toEqual(before);
    const again = await app.get<DraftDetail>(`/api/v1/drafts/${draft!.id}`);
    expect(again.data.draft.status).toBe('pending');
  });

  test('unknown character fixed in the repair round → succeeds with 2 requests', async () => {
    const bad: BreakdownOutput = structuredClone(good);
    bad.shots[1]!.subjects[0]!.alias = 'c9';
    fake.enqueue(reply.json(bad), reply.json(good));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(2);
    expect(draft!.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('too many shots → excess items are errors (not silently truncated)', async () => {
    const many: BreakdownOutput = { shots: SCENE1.shots.slice(0, 4) };
    fake.enqueue(reply.json(many), reply.json(many), reply.json(many));
    const { job, draft } = await requestBreakdown({ ...BREAKDOWN_REQUEST, max_shots: 2 });
    expect(job.error?.code).toBe('ATTEMPTS_EXHAUSTED');
    expect((draft!.parsed as BreakdownOutput).shots).toHaveLength(4);
    const tooMany = draft!.issues.filter((i) => i.code === 'too_many_shots');
    expect(tooMany.map((i) => i.item).sort()).toEqual([2, 3, null].sort());
    const apply = await app.post(`/api/v1/drafts/${draft!.id}/apply`, { selected: [2], replace_existing: false, expected_revisions: {} });
    expect(apply.status).toBe(400);
    expect(await shotsNow()).toEqual([]);
  });

  test('tampered quote / out-of-scene paragraph → errors', async () => {
    const bad: BreakdownOutput = structuredClone(good);
    bad.shots[0]!.source.quote = '窗外下着倾盆大雨，街上空无一人';
    bad.shots[2]!.source.paragraph_id = 'p-022'; // scene 2
    fake.enqueue(reply.json(bad), reply.json(bad), reply.json(bad));
    const { draft } = await requestBreakdown();
    expect(draft!.issues.find((i) => i.code === 'quote_rejected')?.item).toBe(0);
    expect(draft!.issues.find((i) => i.code === 'paragraph_not_in_scene')?.item).toBe(2);
  });

  test('enum case and synonyms are normalised before validation', async () => {
    const loose = JSON.parse(JSON.stringify(good)) as { shots: Record<string, unknown>[] };
    loose.shots[0]!.shot_size = 'wide';
    loose.shots[1]!.shot_size = 'medium';
    loose.shots[1]!.angle = 'eye-level';
    loose.shots[2]!.movement = 'fixed';
    loose.shots[2]!.est_seconds = '3';
    fake.enqueue(reply.json(loose));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    const shots = (draft!.parsed as BreakdownOutput).shots;
    expect(shots[0]!.shot_size).toBe('WS');
    expect(shots[1]!.shot_size).toBe('MS');
    expect(shots[1]!.angle).toBe('eye');
    expect(shots[2]!.movement).toBe('static');
    expect(shots[2]!.est_seconds).toBe(3);
  });

  test('json_schema rejected with 400 → json_object fallback, capability cached for the next call', async () => {
    fake.enqueue(reply.unsupportedSchema(), reply.json(good));
    const first = await requestBreakdown();
    expect(first.job.status).toBe('succeeded');
    // the 400 that revealed the missing capability counts as an outbound attempt
    expect(first.job.attempts).toBe(2);
    const [a, b] = fake.chatRequests();
    expect(a!.body!.response_format!.type).toBe('json_schema');
    expect(b!.body!.response_format!.type).toBe('json_object');
    const sys = b!.body!.messages!.find((m) => m.role === 'system')!;
    expect(sys.content).toContain('只输出 JSON，符合以下 JSON Schema');

    const config = JSON.parse(readFileSync(join(app.stateDir, 'config.json'), 'utf8')) as {
      capability_cache: Record<string, { mode: string }>;
    };
    expect(config.capability_cache[`${fake.url}|fake-model`]?.mode).toBe('json_object');
    expect(JSON.stringify(config)).not.toContain(TEST_KEY);

    fake.enqueue(reply.json(good));
    const second = await requestBreakdown();
    expect(second.job.status).toBe('succeeded');
    expect(second.job.attempts).toBe(1);
    expect(fake.chatRequests()).toHaveLength(3);
    expect(fake.chatRequests()[2]!.body!.response_format!.type).toBe('json_object');
  });

  test('429 with Retry-After → waits (seconds, capped at 30 s) and counts the attempt', async () => {
    fake.enqueue(reply.rateLimited('1'), reply.json(good));
    const { job } = await requestBreakdown();
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(2);
    expect(fake.chatRequests()).toHaveLength(2);
    expect(sleeps).toEqual([1000]);

    sleeps.length = 0;
    fake.enqueue(reply.rateLimited('600'), reply.rateLimited('1'), reply.rateLimited('1'));
    const second = await requestBreakdown({ ...BREAKDOWN_REQUEST, max_shots: 15 });
    expect(second.job.status).toBe('failed');
    expect(second.job.error?.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(second.job.attempts).toBe(3);
    expect(fake.chatRequests()).toHaveLength(5);
    // capped at 30 s; no wait after the last attempt
    expect(sleeps).toEqual([30_000, 1000]);
  });

  test('finish_reason=length → fails immediately and asks for a smaller scope', async () => {
    fake.enqueue(reply.truncated(good), reply.json(good));
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('PROVIDER_ERROR');
    expect(job.error?.message).toContain('缩小范围');
    expect(job.attempts).toBe(1);
    expect(fake.chatRequests()).toHaveLength(1);
    expect(fake.pending).toBe(1);
    expect(draft!.status).toBe('failed');
  });

  test('the SDK never retries on its own: 5xx × 3 → exactly 3 requests', async () => {
    fake.enqueue(reply.serverError(500), reply.serverError(502), reply.serverError(503), reply.json(good));
    const { job } = await requestBreakdown();
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(job.attempts).toBe(3);
    expect(fake.chatRequests()).toHaveLength(3);
    expect(fake.pending).toBe(1);
  });

  test('api_key never appears in errors, even when the provider echoes it', async () => {
    fake.enqueue({ type: 'echo_auth', status: 401 });
    const { job, draft } = await requestBreakdown();
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('PROVIDER_ERROR');
    expect(job.attempts).toBe(1);
    expect(JSON.stringify(job)).not.toContain(TEST_KEY);
    expect(JSON.stringify(draft)).not.toContain(TEST_KEY);
    const list = await app.get('/api/v1/drafts');
    responses.push(list.text);
    const providers = await app.get('/api/v1/settings/providers');
    responses.push(providers.text);
    expect(providers.data).toMatchObject({ text: { base_url: fake.url, model: 'fake-model', key_last4: TEST_KEY.slice(-4), source: 'env' } });
  });

  test('a validated draft is applied into formal shots (origin ai, exact anchors, revision 0)', async () => {
    fake.enqueue(reply.json(good));
    const { draft } = await requestBreakdown();
    const apply = await app.post<{ created: Shot[]; archived_ids: string[]; skipped_locked_ids: string[] }>(
      `/api/v1/drafts/${draft!.id}/apply`,
      { selected: [0, 1, 2], replace_existing: false, expected_revisions: {} },
    );
    expect(apply.status, apply.text).toBe(200);
    expect(apply.data.created).toHaveLength(3);
    for (const s of apply.data.created) {
      expect(s.origin).toBe('ai');
      expect(s.revision).toBe(0);
      expect(s.source_anchor?.match).toBe('exact');
    }
    expect(apply.data.created.map((s) => s.code)).toEqual(['001', '002', '003']);
    const revs = await app.get<{ origin: string; revision: number }[]>(`/api/v1/shots/${apply.data.created[0]!.id}/revisions`);
    expect(revs.data).toEqual([expect.objectContaining({ origin: 'ai', revision: 0 })]);
    const d = await app.get<DraftDetail>(`/api/v1/drafts/${draft!.id}`);
    expect(d.data.draft.status).toBe('applied');
    expect(d.data.current_shots).toHaveLength(3);
    // applying twice is refused
    const twice = await app.post(`/api/v1/drafts/${draft!.id}/apply`, { selected: [0], replace_existing: false, expected_revisions: {} });
    expect(twice.status).toBe(409);
  });
});

describe('entity extraction against the fake service', () => {
  test('extract → entities draft → apply with edits (merge by name, origin ai, unconfirmed)', async () => {
    fake.enqueue(
      reply.json({
        characters: [
          { name: '周明远', aliases: ['老周', '周老板'] },
          { name: '林晓', aliases: [] },
        ],
        locations: [{ name: '旧书店', aliases: [] }],
        props: [{ name: '日记本', aliases: [] }],
      }),
    );
    const res = await app.post<{ job_id: string }>('/api/v1/entities/extract');
    expect(res.status, res.text).toBe(202);
    const job = await waitJob(app, res.data.job_id);
    expect(job.kind).toBe('extract_entities');
    expect(job.status).toBe('succeeded');
    expect(fake.chatRequests()).toHaveLength(1);
    const draft = (await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`)).data.draft;
    expect(draft.kind).toBe('entities');
    expect(draft.status).toBe('pending');

    const applied = await app.post<Entity[]>(`/api/v1/drafts/${draft.id}/apply-entities`, {
      items: [
        { kind: 'characters', index: 0, name: '周明远', aliases: ['老周', '周老板'] },
        { kind: 'locations', index: 0, name: '旧书店', aliases: ['书店'] },
        { kind: 'props', index: 0, name: '蓝色日记本', aliases: [] },
      ],
    });
    expect(applied.status, applied.text).toBe(200);
    const all = (await app.get<Entity[]>('/api/v1/entities')).data;
    const chars = all.filter((e) => e.type === 'character');
    expect(chars).toHaveLength(2); // merged, not duplicated
    expect(chars.find((e) => e.name === '周明远')).toMatchObject({ alias: 'c1', origin: 'manual', aliases: ['老周', '周老板'] });
    expect(all.find((e) => e.type === 'location')).toMatchObject({ alias: 'l1', name: '旧书店', aliases: ['书店'], origin: 'ai', confirmed: false });
    expect(all.find((e) => e.type === 'prop')).toMatchObject({ alias: 'o1', name: '蓝色日记本', origin: 'ai', confirmed: false });
    const after = (await app.get<DraftDetail>(`/api/v1/drafts/${draft.id}`)).data.draft;
    expect(after.status).toBe('applied');
  });

  test('manual entity aliases are allocated per type and never reused', async () => {
    const loc = await app.post<Entity>('/api/v1/entities', { type: 'location', name: '后屋', aliases: [] });
    const prop = await app.post<Entity>('/api/v1/entities', { type: 'prop', name: '合影', aliases: ['照片', '照片', ' '] });
    const c3 = await app.post<Entity>('/api/v1/entities', { type: 'character', name: '沈映秋', aliases: [] });
    expect([loc.data.alias, prop.data.alias, c3.data.alias]).toEqual(['l1', 'o1', 'c3']);
    expect(prop.data.aliases).toEqual(['照片']);
    const renamed = await app.patch<Entity>(`/api/v1/entities/${c3.data.id}`, { name: '沈映秋（外婆）', confirmed: true });
    expect(renamed.data).toMatchObject({ alias: 'c3', name: '沈映秋（外婆）', confirmed: true });
  });
});

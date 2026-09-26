import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ApplyBreakdownResult, BreakdownOutput, DraftDetail, Scene } from '@storyscript/contracts';
import { FakeChat } from '../src/adapters/llm/fake-chat.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-06 (reference requests): a "reference X" note with no material is only
 * a hint for choosing techniques. The draft is marked as unverified generic
 * advice, and concrete film claims in model text (《…》, years, "在电影…中")
 * are annotated as claim flags — annotate only, never block.
 */

const SCENE1 = replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput;
const REFERENCE = '参考某导演的风格';

let app: M3App;
let chat: FakeChat;
let scene: Scene;

async function breakdown(reference_note: string | null): Promise<DraftDetail> {
  const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${scene.id}/breakdown`, { ...BREAKDOWN_REQUEST, reference_note });
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  return (await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`)).data;
}

beforeEach(async () => {
  chat = new FakeChat();
  app = await makeM3App({ env: llmEnv('http://127.0.0.1:9/v1'), ai: { chat: () => chat } });
  scene = (await importFixture(app, '01-bookshop.txt', 'txt')).scenes[0]!;
  await bookshopRoster(app);
});

afterEach(() => app.close());

describe('AT-06 reference requests', () => {
  test('reference note without material → draft marked as unverified generic advice; note sent as data only', async () => {
    chat.push({ content: JSON.stringify({ shots: SCENE1.shots.slice(0, 4) }) });
    const detail = await breakdown(REFERENCE);
    expect(chat.requests).toHaveLength(1);
    const user = chat.requests[0]!.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(user).toContain(REFERENCE);
    expect(user).toContain('仅作风格参考');

    const flag = detail.draft.issues.find((i) => i.code === 'reference_unverified');
    expect(flag).toMatchObject({ level: 'warning', item: null });
    expect(flag!.message).toContain('未核实');
    expect(detail.draft.issues.filter((i) => i.level === 'error')).toEqual([]);
    // plain generic text → no film-fact claims
    expect(detail.claim_flags).toEqual([]);
    expect((detail.draft.scope as { request: { reference_note: string } }).request.reference_note).toBe(REFERENCE);
  });

  test('film claims in narrative_purpose / assumptions are flagged but the draft still applies', async () => {
    const shots = structuredClone(SCENE1.shots.slice(0, 3));
    shots[0]!.narrative_purpose = '像《某片》1994年开场那样先交代空间';
    shots[2]!.assumptions = ['在电影《某片》中这一段用了长镜头', '门在画面右侧'];
    chat.push({ content: JSON.stringify({ shots }) });
    const detail = await breakdown(REFERENCE);

    expect(detail.claim_flags.length).toBeGreaterThan(0);
    expect(detail.claim_flags).toEqual(
      expect.arrayContaining([
        { item: 0, kind: 'title', text: '《某片》' },
        { item: 0, kind: 'year', text: '1994年' },
        { item: 2, kind: 'title', text: '《某片》' },
        { item: 2, kind: 'film_reference', text: expect.stringContaining('在电影') },
      ]),
    );
    expect(detail.claim_flags.some((f) => f.item === 1)).toBe(false);
    // annotate only: no errors, and the flagged items can be applied
    expect(detail.draft.issues.filter((i) => i.level === 'error')).toEqual([]);
    const applied = await app.post<ApplyBreakdownResult>(`/api/v1/drafts/${detail.draft.id}/apply`, {
      selected: [0, 1, 2],
      replace_existing: false,
      expected_revisions: {},
    });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.data.created).toHaveLength(3);
    expect(applied.data.created[0]!.fields.narrative_purpose).toContain('《某片》');
  });

  test('without a reference note there is no unverified marker', async () => {
    chat.push({ content: JSON.stringify({ shots: SCENE1.shots.slice(0, 2) }) });
    const detail = await breakdown(null);
    expect(detail.draft.issues.some((i) => i.code === 'reference_unverified')).toBe(false);
    const user = chat.requests[0]!.messages.map((m) => m.content).join('\n');
    expect(user).not.toContain('用户的参考说明');
  });
});

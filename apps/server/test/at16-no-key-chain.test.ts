import { afterEach, describe, expect, test } from 'vitest';
import {
  ProjectExport,
  type BoardView,
  type BreakdownOutput,
  type Entity,
  type HealthInfo,
  type Job,
  type PlanDetail,
  type Resource,
  type Scene,
  type Setup,
  type Shot,
  type ShotDraft,
  type ShotFields,
  type Take,
} from '@storyscript/contracts';
import { localWindowToUtc, renderBoard } from '@storyscript/core';
import { FakeChat } from '../src/adapters/llm/fake-chat.ts';
import { projectContext } from '../src/ai/runtime.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-16 (SPEC §7: no-key flow and late results):
 *  - without any key the manual chain — script import, roster, shots, boards
 *    (laid out, drawn, edited), resources, setups, an approved plan, takes,
 *    and the exports — is persisted: closing and reopening the project gives
 *    back the same data and byte-identical exports;
 *  - an AI result that arrives after the user cancelled is never applied on
 *    its own: no draft, no shots, no entities.
 */

const HOST = '127.0.0.1:43203';
const TOKEN = 'm3-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF';
const TZ = 'Asia/Shanghai';
const DAY = '2026-10-12';

let app: M3App | null = null;

afterEach(() => {
  app?.close();
  app = null;
});

async function ok<T>(p: Promise<{ status: number; data: T; text: string }>, status = 200): Promise<T> {
  const r = await p;
  expect(r.status, r.text).toBe(status);
  return r.data;
}

/** Raw download (the export routes answer files, not the { data } envelope). */
async function fetchText(a: M3App, path: string): Promise<string> {
  const session = await a.handle.app.request('/api/v1/session', {
    method: 'POST',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]!;
  const res = await a.handle.app.request(path, { headers: { host: HOST, cookie } });
  expect(res.status, path).toBe(200);
  return res.text();
}

function fields(scene: Scene, alias: string, action: string, angle: ShotFields['angle'] = 'eye'): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle,
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: [{ alias, screen: null, depth: null, facing: 'camera', pose: null }],
    props: [],
    env: 'interior',
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 4,
    narrative_purpose: '手工镜头',
    action,
    dialogue_quote: null,
    source: { paragraph_id: scene.paragraph_ids[0]!, quote: '' },
    assumptions: [],
    questions: [],
  };
}

async function exportsOf(a: M3App): Promise<{ json: Record<string, unknown>; csv: Record<string, string> }> {
  const json = JSON.parse(await fetchText(a, '/api/v1/export/project.json')) as Record<string, unknown>;
  const csv: Record<string, string> = {};
  for (const kind of ['shots', 'callsheet', 'takes-media', 'coverage']) csv[kind] = await fetchText(a, `/api/v1/export/csv/${kind}?bom=1`);
  return { json, csv };
}

describe('AT-16 no key: the manual chain is persisted', () => {
  test('script, roster, shots, boards, plan, takes and exports survive closing and reopening', async () => {
    const a = (app = await makeM3App({ env: {} }));
    expect((await ok<HealthInfo>(a.get('/api/v1/health'))).text_provider_configured).toBe(false);

    // script + roster by hand
    const imported = await importFixture(a, '01-bookshop.txt', 'txt');
    const scene = imported.scenes[0]!;
    const [c1, c2] = await bookshopRoster(a);
    const shop = await ok<Entity>(a.post('/api/v1/entities', { type: 'location', name: '旧书店', aliases: [] }), 201);
    await ok(a.patch(`/api/v1/scenes/${scene.id}`, { location_entity_id: shop.id }));

    // shots by hand: boards are laid out with them and draw
    const shots: Shot[] = [];
    for (const [alias, action, angle] of [
      ['c1', '老周清理书脊', 'eye'],
      ['c2', '林晓推门进来', 'eye'],
      ['c1', '老周的手停住', 'high'],
    ] as const) {
      shots.push(await ok<Shot>(a.post('/api/v1/shots', { scene_id: scene.id, fields: fields(scene, alias, action, angle), manual_note: '没有 AI 的手工镜头' }), 201));
    }
    const boards = await ok<BoardView[]>(a.get('/api/v1/boards'));
    expect(boards.map((b) => [b.shot_id, b.version])).toEqual(shots.map((s) => [s.id, 1]));
    for (const b of boards) expect(renderBoard(b.spec, 'pencil')).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    const b0 = boards[0]!;
    const moved = { ...b0.spec, scene: { ...b0.spec.scene, subjects: b0.spec.scene.subjects.map((s) => ({ ...s, x: s.x + 0.4 })) } };
    const saved = await ok<BoardView>(a.patch(`/api/v1/boards/${b0.id}`, { expected_revision: b0.revision, spec: moved }));
    expect(saved).toMatchObject({ version: 2, user_edited: true });

    // plan: resources, setups, an approved day
    const win = [localWindowToUtc(DAY, '08:00', '20:00', TZ)];
    await ok<Resource>(a.post('/api/v1/resources', { type: 'performer', name: '演员甲', windows: win, cast_character_ids: [c1!.id], confirmed: true }), 201);
    await ok<Resource>(a.post('/api/v1/resources', { type: 'performer', name: '演员乙', windows: win, cast_character_ids: [c2!.id], confirmed: true }), 201);
    await ok<Resource>(a.post('/api/v1/resources', { type: 'location', name: '旧书店实景', windows: win, cast_character_ids: [shop.id], confirmed: true }), 201);
    const setups = await ok<Setup[]>(a.post('/api/v1/setups/derive', { keep_edited: false, default_durations: { setup_min: 20, per_shot_min: 15, reset_min: 10 } }));
    expect(setups).toHaveLength(2);
    for (const s of setups) await ok(a.patch(`/api/v1/setups/${s.id}`, { estimate_confirmed: true }));
    const created = await ok<PlanDetail>(a.post('/api/v1/plans', { date: DAY, crew_call: '08:00', crew_wrap: '20:00' }), 201);
    expect(created.plan.result.outcome).toBe('feasible');
    const approved = await ok<PlanDetail>(a.post(`/api/v1/plans/${created.plan.id}/approve`, { expected_revision: created.plan.revision }));
    expect(approved.plan.status).toBe('approved');

    // set: one take covering two shots, one more
    await ok<Take>(
      a.post('/api/v1/takes', { setup_id: null, camera_label: 'A', rating: 'good', clip_hint: 'A001C003', notes: '两镜一条', shot_ids: [shots[0]!.id, shots[1]!.id], unresolved_labels: [] }),
      201,
    );
    await ok<Take>(a.post('/api/v1/takes', { setup_id: null, camera_label: 'B', rating: 'unrated', clip_hint: null, notes: '', shot_ids: [shots[2]!.id], unresolved_labels: ['3A'] }), 201);

    const before = await exportsOf(a);
    const parsed = ProjectExport.parse(before.json);
    expect(parsed.shots).toHaveLength(3);
    expect(parsed.takes).toHaveLength(2);
    expect((parsed.plans as { status: string }[])[0]!.status).toBe('approved');
    expect(before.csv.shots).toContain('老周的手停住');

    // close, reopen: the same project comes back
    expect((await a.post('/api/v1/projects/close')).status).toBe(204);
    expect((await a.get('/api/v1/shots')).status).toBe(409);
    await ok(a.post('/api/v1/projects/open', { dir: a.projectDir }));

    expect((await ok<Shot[]>(a.get('/api/v1/shots'))).map((s) => [s.id, s.revision])).toEqual(shots.map((s) => [s.id, s.revision]));
    expect((await ok<BoardView[]>(a.get('/api/v1/boards')))[0]).toEqual(saved);
    expect((await ok<PlanDetail>(a.get(`/api/v1/plans/${created.plan.id}`))).plan).toMatchObject({ status: 'approved', revision: approved.plan.revision });
    const after = await exportsOf(a);
    const strip = (j: Record<string, unknown>) => ({ ...j, exported_at: null });
    expect(strip(after.json)).toEqual(strip(before.json));
    expect(after.csv).toEqual(before.csv);
  });
});

describe('AT-16 a late AI result after cancel is not applied', () => {
  /** A FakeChat step that ignores the abort signal and answers when released. */
  function lateStep(): { step: () => Promise<{ content: string }>; release: (content: unknown) => void; arrived: Promise<void> } {
    let release!: (content: unknown) => void;
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    const answer = new Promise<{ content: string }>((r) => (release = (c) => r({ content: JSON.stringify(c) })));
    return {
      step: () => {
        arrive();
        return answer;
      },
      release,
      arrived,
    };
  }

  test('breakdown and entity extraction: cancelled, the answer arrives later, nothing is written', async () => {
    const chat = new FakeChat();
    const a = (app = await makeM3App({ env: llmEnv('http://127.0.0.1:9/v1'), ai: { chat: () => chat } }));
    const scene = (await importFixture(a, '01-bookshop.txt', 'txt')).scenes[0]!;
    const roster = await bookshopRoster(a);
    const { jobs } = projectContext(a.handle.deps);

    // breakdown
    const late = lateStep();
    chat.push(late.step);
    const bd = await a.post<{ job_id: string }>(`/api/v1/scenes/${scene.id}/breakdown`, BREAKDOWN_REQUEST);
    expect(bd.status, bd.text).toBe(202);
    await late.arrived;
    const cancelled = await ok<Job>(a.post(`/api/v1/jobs/${bd.data.job_id}/cancel`));
    expect(cancelled.status).toBe('outcome_unknown');
    late.release({ shots: (replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput).shots.slice(0, 3) });
    await jobs.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(await waitJob(a, bd.data.job_id)).toMatchObject({ status: 'outcome_unknown', result_ref: null });
    expect(await ok<ShotDraft[]>(a.get('/api/v1/drafts'))).toEqual([]);
    expect(await ok<Shot[]>(a.get('/api/v1/shots'))).toEqual([]);

    // entity extraction
    const lateEntities = lateStep();
    chat.push(lateEntities.step);
    const ex = await a.post<{ job_id: string }>('/api/v1/entities/extract');
    expect(ex.status, ex.text).toBe(202);
    await lateEntities.arrived;
    expect((await ok<Job>(a.post(`/api/v1/jobs/${ex.data.job_id}/cancel`))).status).toBe('outcome_unknown');
    lateEntities.release(replayOutput('01-bookshop.entities-v1.json'));
    await jobs.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(await waitJob(a, ex.data.job_id)).toMatchObject({ status: 'outcome_unknown', result_ref: null });
    expect(await ok<ShotDraft[]>(a.get('/api/v1/drafts'))).toEqual([]);
    expect((await ok<Entity[]>(a.get('/api/v1/entities'))).map((e) => e.id)).toEqual(roster.map((e) => e.id));
    expect(chat.requests).toHaveLength(2);

    // control: the same answer, not cancelled, becomes a pending draft (still not applied)
    const good = { shots: (replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput).shots.slice(0, 3) };
    chat.push({ content: JSON.stringify(good) });
    const again = await a.post<{ job_id: string }>(`/api/v1/scenes/${scene.id}/breakdown`, BREAKDOWN_REQUEST);
    expect(await waitJob(a, again.data.job_id)).toMatchObject({ status: 'succeeded' });
    expect((await ok<ShotDraft[]>(a.get('/api/v1/drafts'))).map((d) => d.status)).toEqual(['pending']);
    expect(await ok<Shot[]>(a.get('/api/v1/shots'))).toEqual([]);
  });
});

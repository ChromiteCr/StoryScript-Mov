import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ApplyPasteResult, Constraint, Job, PasteItem, PasteNoteView, PasteOutput, Resource, Setup, Shot, Take, Todo } from '@storyscript/contracts';
import { PASTE_SAMPLE, PASTE_SAMPLE_DATE } from '@storyscript/core';
import { runWithRequest, syncMember, type Actor, type HostedRequest } from '../src/collab/actor.ts';
import { startPasteNote } from '../src/ai/paste-jobs.ts';
import type { AppDeps } from '../src/deps.ts';
import { isAppError } from '../src/http/errors.ts';
import { createTodo, updateTodo } from '../src/services/todos.ts';
import { reply, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * S5a 粘贴整理: a pasted chat → one job per segment → items matched against
 * the project (merge or new, characters, setups, shots, members) → apply in
 * one transaction (resources, constraints, takes, props, todos), never twice.
 * Also the todo list itself.
 */

const SAMPLE = replayOutput('01-bookshop.paste-v1.json') as PasteOutput;
let fake: FakeOpenAI;
let app: M3App;
let scenes: { id: string }[];

const shotFields = (paragraph: string) => ({
  template: null, shot_size: 'MS', angle: 'eye', lens: 'normal', focal_mm: null, movement: 'static', subjects: [], props: [], env: null,
  subject_motion: 'none', set_piece: false, pov_owner: null, frame_format: null, technique_id: null, est_seconds: 3,
  narrative_purpose: '交代', action: '镜头', dialogue_quote: null, source: { paragraph_id: paragraph, quote: '' }, assumptions: [], questions: [],
});

async function shot(sceneId: string, paragraph: string): Promise<Shot> {
  const r = await app.post<Shot>('/api/v1/shots', { scene_id: sceneId, manual_note: '手工', fields: shotFields(paragraph) });
  expect(r.status, r.text).toBe(201);
  return r.data;
}

async function setup(label: string, shotIds: string[]): Promise<Setup> {
  const r = await app.post<Setup>('/api/v1/setups', { location_resource_id: null, label, shot_ids: shotIds, resource_ids: [], durations: { setup_min: 10, per_shot_min: 5, reset_min: 2 }, estimate_confirmed: false });
  expect(r.status, r.text).toBe(201);
  return r.data;
}

async function paste(text = PASTE_SAMPLE, ref_date = PASTE_SAMPLE_DATE): Promise<PasteNoteView> {
  const r = await app.post<PasteNoteView>('/api/v1/paste', { text, ref_date, hint: 'plan' });
  expect(r.status, r.text).toBe(201);
  for (const s of r.data.segment_views) if (s.job_id) await waitJob(app, s.job_id);
  return (await app.get<PasteNoteView>(`/api/v1/paste/${r.data.id}`)).data;
}

const byName = (note: PasteNoteView, name: string) => note.items.find((i) => i.item.name === name || i.item.task === name)!;

beforeEach(async () => {
  fake = await startFakeOpenAI();
  app = await makeM3App({ env: llmEnv(fake.url) });
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  scenes = imported.scenes;
  await bookshopRoster(app);
});

afterEach(async () => {
  app.close();
  await fake.close();
});

describe('a pasted chat', () => {
  test('one segment, one job; every item matched against the project; lines nobody quoted kept apart', async () => {
    const a = [await shot(scenes[0]!.id, 'p-003'), await shot(scenes[0]!.id, 'p-004'), await shot(scenes[0]!.id, 'p-005')];
    const b = await shot(scenes[1]!.id, 'p-021');
    await setup('场1', a.map((s) => s.id));
    await setup('场2', [b.id]);
    fake.enqueue(reply.json(SAMPLE));
    const note = await paste();
    expect(note.segments).toBe(1);
    const sent = fake.chatRequests()[0]!.body!.messages![1]!.content;
    expect(sent).toContain('【消息日期】2026-10-09（周五）');
    expect(sent).toContain('第 2 场：内景 旧书店后屋 日');
    expect(sent).toContain('周明远（又称 老周）');
    expect(note.segment_views[0]).toMatchObject({ status: 'done' });
    expect(note.segment_views[0]!.uncovered).toContain('[21:05] 阿杰（导演）：大家早点休息');
    expect(note.items).toHaveLength(12);

    expect(byName(note, '图书馆三楼阅览室')).toMatchObject({ resolution: { action: 'create' }, unconfirmed: false, blocked: null, suggested: true });
    const yu = byName(note, '小雨');
    expect(yu.resolution).toMatchObject({ action: 'create', character_name: '林晓' });
    expect(yu.unconfirmed).toBe(true);
    expect(byName(note, '老陈').resolution.character_name).toBe('周明远');
    const within = note.items.find((i) => i.item.kind === 'schedule' && i.item.rule === 'within')!;
    expect(within.resolution.setup_ids).toHaveLength(1);
    expect(within.blocked).toBeNull();
    const take2 = note.items.find((i) => i.item.kind === 'take' && i.item.take === 2)!;
    expect(take2.resolution.shot_ids).toEqual([a[2]!.id]);
    expect(byName(note, '把日记本做旧').resolution).toMatchObject({ assignee_id: null, target_name: '阿丽' });
  });

  test('apply: resources, constraints, takes, a prop and todos in one go; never twice', async () => {
    const a = [await shot(scenes[0]!.id, 'p-003'), await shot(scenes[0]!.id, 'p-004'), await shot(scenes[0]!.id, 'p-005')];
    const b = await shot(scenes[1]!.id, 'p-021');
    const s1 = await setup('场1', a.map((s) => s.id));
    const s2 = await setup('场2', [b.id]);
    fake.enqueue(reply.json(SAMPLE));
    const note = await paste();
    const picks = note.items.filter((i) => i.suggested).map((i) => ({ key: i.key, item: i.item }));
    expect(picks).toHaveLength(12);
    const res = await app.post<ApplyPasteResult>(`/api/v1/paste/${note.id}/apply`, { items: picks });
    expect(res.status, res.text).toBe(200);
    expect(res.data.counts).toEqual({ resources_created: 5, resources_updated: 0, constraints: 3, takes: 2, entities: 1, todos: 5 });
    expect(res.data.note.applied_count).toBe(12);
    expect(res.data.note.items.every((i) => i.applied !== null)).toBe(true);

    const resources = (await app.get<Resource[]>('/api/v1/resources')).data;
    const yu = resources.find((r) => r.name === '小雨')!;
    // Asia/Shanghai: 2026-10-10 14:00 → 06:00Z; 10-11 08:00 → 10-11 00:00Z
    expect(yu.windows).toEqual([
      { start_utc: '2026-10-10T06:00:00.000Z', end_utc: '2026-10-10T10:00:00.000Z' },
      { start_utc: '2026-10-11T00:00:00.000Z', end_utc: '2026-10-11T12:00:00.000Z' },
    ]);
    expect(yu.confirmed).toBe(false);
    expect(yu.cast_character_ids).toHaveLength(1);
    expect(resources.find((r) => r.name === '图书馆三楼阅览室')).toMatchObject({ type: 'location', confirmed: true });
    const constraints = (await app.get<Constraint[]>('/api/v1/constraints')).data;
    expect(constraints.filter((c) => c.type === 'not_before' && c.setup_id === s2.id)).toHaveLength(1);
    expect(constraints.find((c) => c.type === 'before')).toMatchObject({ a_setup_id: s2.id, b_setup_id: s1.id, confirmed: true });
    const takes = (await app.get<Take[]>('/api/v1/takes')).data;
    expect(takes.map((t) => [t.take_no, t.rating, t.clip_hint]).sort()).toEqual([
      [1, 'reject', 'C0012'],
      [2, 'good', null],
    ]);
    const todos = (await app.get<Todo[]>('/api/v1/todos')).data;
    expect(todos.map((t) => t.text).sort()).toEqual(['准备 林晓的蓝色风衣', '带 稳定器', '带 补光灯', '把日记本做旧', '打印一张褪色的老合影'].sort());
    expect(todos.find((t) => t.text === '把日记本做旧')).toMatchObject({ assignee_name: '阿丽', due_date: '2026-10-16', source_note_id: note.id });

    const again = await app.post(`/api/v1/paste/${note.id}/apply`, { items: picks.slice(0, 1) });
    expect(again.status).toBe(409);
    // the same item under another spelling of its key is not a new item
    for (const alias of ['0:00', ' 0:0', '0:0:9', '0:0.0']) {
      const r = await app.post(`/api/v1/paste/${note.id}/apply`, { items: [{ key: alias.replace('0:0', picks[0]!.key), item: picks[0]!.item }] });
      expect(r.status, alias).toBeGreaterThanOrEqual(400);
    }
    expect((await app.get<Todo[]>('/api/v1/todos')).data).toHaveLength(5);
    // a pasted prop is like an AI draft: to be confirmed on the script page
    const prop = (await app.get<{ name: string; origin: string; confirmed: boolean }[]>('/api/v1/entities')).data.find((e) => e.name === '林晓的蓝色风衣')!;
    expect(prop).toMatchObject({ origin: 'ai', confirmed: false });
    // a segment that gave items (some applied) is not sorted again
    expect((await app.post(`/api/v1/paste/${note.id}/segments/0/retry`)).status).toBe(409);
    expect(fake.chatRequests()).toHaveLength(1);
  });

  test('an end before the start is refused, not read as overnight; a too-long todo is refused', async () => {
    fake.enqueue(reply.json(SAMPLE));
    const note = await paste();
    const room = byName(note, '图书馆三楼阅览室');
    const backwards: PasteItem = { ...room.item, slots: [{ ...room.item.slots[0]!, start: '19:00', end: '18:00' }] };
    const r = await app.post(`/api/v1/paste/${note.id}/apply`, { items: [{ key: room.key, item: backwards }] });
    expect(r.status).toBe(409);
    expect(r.text).toContain('结束时间');
    const todo = byName(note, '把日记本做旧');
    const long = await app.post(`/api/v1/paste/${note.id}/apply`, { items: [{ key: todo.key, item: { ...todo.item, task: '做'.repeat(300) } }] });
    expect(long.status).toBe(409);
    expect((await app.post('/api/v1/todos', { text: '  ', assignee_id: null, assignee_name: null, due_date: null, due_time: null })).status).toBe(400);
    expect((await app.get<Todo[]>('/api/v1/todos')).status).toBe(200);
  });

  test('an existing performer is merged into; edits are applied as edited; a scene without setups waits', async () => {
    const existing = await app.post<Resource>('/api/v1/resources', {
      type: 'performer', name: '小雨', windows: [{ start_utc: '2026-10-10T08:00:00.000Z', end_utc: '2026-10-10T12:00:00.000Z' }], cast_character_ids: [], confirmed: true,
    });
    fake.enqueue(reply.json(SAMPLE));
    const note = await paste();
    const yu = byName(note, '小雨');
    expect(yu.resolution).toMatchObject({ action: 'merge', target_name: '小雨' });
    const within = note.items.find((i) => i.item.kind === 'schedule' && i.item.rule === 'within')!;
    expect(within.blocked).toContain('还没有 setup');
    expect(within.suggested).toBe(false);
    const blocked = await app.post(`/api/v1/paste/${note.id}/apply`, { items: [{ key: within.key, item: within.item }] });
    expect(blocked.status).toBe(409);

    const room = byName(note, '图书馆三楼阅览室');
    const edited: PasteItem = { ...room.item, name: '三楼阅览室' };
    const res = await app.post<ApplyPasteResult>(`/api/v1/paste/${note.id}/apply`, { items: [{ key: yu.key, item: yu.item }, { key: room.key, item: edited }] });
    expect(res.status, res.text).toBe(200);
    expect(res.data.counts).toMatchObject({ resources_created: 1, resources_updated: 1 });
    const resources = (await app.get<Resource[]>('/api/v1/resources')).data;
    const merged = resources.find((r) => r.id === existing.data.id)!;
    // 06:00–10:00Z joins the 08:00–12:00Z already there; confirmed drops (the new time is vague)
    expect(merged.windows[0]).toEqual({ start_utc: '2026-10-10T06:00:00.000Z', end_utc: '2026-10-10T12:00:00.000Z' });
    expect(merged.confirmed).toBe(false);
    expect(resources.some((r) => r.name === '三楼阅览室')).toBe(true);
    // the quote must still be from this note
    const forged = await app.post(`/api/v1/paste/${note.id}/apply`, { items: [{ key: within.key, item: { ...within.item, quote: '这句话不在原文里' } }] });
    expect(forged.status).toBe(400);
  });

  test('a repair round for a quote not in the text; a failed segment is retried', async () => {
    fake.enqueue(reply.json({ items: [{ ...SAMPLE.items[3]!, quote: '稳定器归我管' }] }));
    fake.enqueue(reply.json({ items: [SAMPLE.items[3]!] }));
    const first = await paste();
    expect(fake.chatRequests()).toHaveLength(2);
    expect(first.items).toHaveLength(1);

    for (let i = 0; i < 3; i++) fake.enqueue(reply.invalid());
    const failed = await paste('[09:00] 小林：明天带三脚架', '2026-10-09');
    expect(failed.segment_views[0]).toMatchObject({ status: 'failed' });
    fake.enqueue(reply.json({ items: [{ ...SAMPLE.items[3]!, name: '三脚架', quote: '明天带三脚架' }] }));
    const retried = await app.post<PasteNoteView>(`/api/v1/paste/${failed.id}/segments/0/retry`);
    expect(retried.status, retried.text).toBe(200);
    await waitJob(app, retried.data.segment_views[0]!.job_id!);
    const after = (await app.get<PasteNoteView>(`/api/v1/paste/${failed.id}`)).data;
    expect(after.segment_views[0]!.status).toBe('done');
    expect(after.items[0]!.item.name).toBe('三脚架');
  });

  test('a long paste is several jobs; the cap must cover all of them, or nothing is sent', async () => {
    const line = `[10:00] 小林：${'器材清单'.repeat(20)}\n`;
    const text = line.repeat(90);
    const hosted = { ...app.handle.deps, hosted: { slug: 't', name: '一组', limits: { llm_jobs_per_day: 2, image_jobs_per_day: 1 } } } as AppDeps;
    let err: unknown;
    try {
      startPasteNote(hosted, { text, ref_date: '2026-10-09', hint: 'auto' });
    } catch (e) {
      err = e;
    }
    expect(isAppError(err) && err.code).toBe('QUOTA_EXCEEDED');
    expect(fake.requests).toHaveLength(0);
  });

  test('--demo replays the recorded sample; the list shows open notes first', async () => {
    const demo = await makeM3App({ demo: true });
    try {
      await importFixture(demo, '01-bookshop.txt', 'txt');
      const r = await demo.post<PasteNoteView>('/api/v1/paste', { text: PASTE_SAMPLE, ref_date: PASTE_SAMPLE_DATE, hint: 'auto' });
      const job: Job = await waitJob(demo, r.data.segment_views[0]!.job_id!);
      expect(job).toMatchObject({ kind: 'organize_paste', status: 'succeeded', remote: false });
      const note = (await demo.get<PasteNoteView>(`/api/v1/paste/${r.data.id}`)).data;
      expect(note.items).toHaveLength(12);
      await demo.post(`/api/v1/paste/${note.id}/close`);
      const list = (await demo.get<{ id: string; closed: boolean }[]>('/api/v1/paste')).data;
      expect(list[0]).toMatchObject({ id: note.id, closed: true });
    } finally {
      demo.close();
    }
  });
});

describe('todos', () => {
  test('create, tick, edit, delete; a stale edit is refused', async () => {
    const t = await app.post<Todo>('/api/v1/todos', { text: '借三脚架', assignee_id: null, assignee_name: '小林', due_date: '2026-10-10', due_time: '09:00' });
    expect(t.status, t.text).toBe(201);
    expect(t.data).toMatchObject({ assignee_name: '小林', due_time: '09:00', done: null, revision: 0 });
    const done = await app.patch<Todo>(`/api/v1/todos/${t.data.id}`, { done: true, expected_revision: 0 });
    expect(done.data.done).not.toBeNull();
    expect((await app.patch(`/api/v1/todos/${t.data.id}`, { text: '旧的改动', expected_revision: 0 })).status).toBe(409);
    const cleared = await app.patch<Todo>(`/api/v1/todos/${t.data.id}`, { due_date: null });
    expect(cleared.data).toMatchObject({ due_date: null, due_time: null });
    const open = await app.post<Todo>('/api/v1/todos', { text: '买胶带', assignee_id: null, assignee_name: null, due_date: null, due_time: null });
    const list = (await app.get<Todo[]>('/api/v1/todos')).data;
    expect(list.map((x) => x.id)).toEqual([open.data.id, t.data.id]);
    expect((await app.raw('DELETE', `/api/v1/todos/${t.data.id}`)).status).toBe(200);
    expect((await app.get<Todo[]>('/api/v1/todos')).data).toHaveLength(1);
  });

  test('hosted: a todo goes to a member, shown with their current name and roles; strangers are refused', () => {
    const db = app.handle.projectSession.require().db;
    const A: Actor = { id: 'acc-a', name: '阿杰', role: 'leader', crew_roles: ['导演'], text_source: 'group', image_source: 'group' };
    const B: Actor = { id: 'acc-b', name: '小林', role: 'member', crew_roles: ['摄影'], text_source: 'group', image_source: 'group' };
    const req: HostedRequest = { actor: A, roster: () => [A, B].map(({ id, name, role, crew_roles }) => ({ id, name, role, crew_roles })), personalDir: '/nonexistent' };
    for (const m of [A, B]) syncMember(db, m);
    const t = runWithRequest(req, () => createTodo(db, { text: '借稳定器', assignee_id: B.id, assignee_name: null, due_date: null, due_time: null }));
    expect(t).toMatchObject({ assignee_id: 'acc-b', assignee_name: '小林', assignee_roles: ['摄影'] });
    expect(t.actor?.name).toBe('阿杰');
    const ticked = runWithRequest(req, () => updateTodo(db, t.id, { done: true }));
    expect(ticked.done?.actor?.name).toBe('阿杰');
    expect(() => runWithRequest(req, () => createTodo(db, { text: 'x', assignee_id: randomUUID(), assignee_name: null, due_date: null, due_time: null }))).toThrow(/不是本组成员/);
  });
});

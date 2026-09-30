import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ActorRef, BoardSpec, Scene, Shot, ShotDraft } from '@storyscript/contracts';
import { PROJECT_SCHEMA_VERSION } from '@storyscript/contracts';
import { actorId, actorResolver, currentActor, runWithRequest, syncMember, type Actor, type HostedRequest, type RosterEntry } from '../src/collab/actor.ts';
import { migrate, MIGRATIONS, userVersion } from '../src/db/migrations/index.ts';
import { openDb, type DbPort } from '../src/db/port.ts';
import { getDraft, insertDraft } from '../src/db/repos/draft.ts';
import { getJob } from '../src/db/repos/job.ts';
import { getScriptVersion, listVersionSummaries } from '../src/db/repos/script.ts';
import { listShotRevisions } from '../src/db/repos/shot.ts';
import { JobQueue, type JobSpec } from '../src/jobs/queue.ts';
import { listBoards, saveBoard } from '../src/services/boards/boards.ts';
import { addCoverageDecision } from '../src/services/coverage/coverage.ts';
import { createTake, takeAudit, updateTake } from '../src/services/media/takes.ts';
import { approvePlan, createPlan, getPlanDetail, recomputePlan } from '../src/services/plan/plans.ts';
import { importScript } from '../src/services/scripts.ts';
import { createShot, updateShot } from '../src/services/shots.ts';
import { fixtureText } from './helpers/m3-app.ts';
import { DUR, expectOk, fields, makePlanApp, makeResource, makeShot, seedWorld, W, type PlanApp, type World } from './helpers/plan-app.ts';

/**
 * S4 (unit level): on the hosted server every history row records the account
 * that made it. The gateway hands the group instance the signed-in account in
 * the request env; services stamp rows through the AsyncLocalStorage of
 * collab/actor.ts. These tests call the real services inside runWithRequest
 * (no gateway) and read the history back. The local app has no actor: rows
 * stay NULL and nobody has "left".
 */

const A: Actor = { id: 'acc-a', name: '阿杰', role: 'member', crew_roles: ['导演'], text_source: 'group', image_source: 'group' };
const B: Actor = { id: 'acc-b', name: '阿丽', role: 'leader', crew_roles: ['摄影', '剪辑'], text_source: 'group', image_source: 'group' };
const roster = (...who: Actor[]): RosterEntry[] => who.map((a) => ({ id: a.id, name: a.name, role: a.role, crew_roles: a.crew_roles }));
const BOTH = roster(A, B);
const REF_A: ActorRef = { id: 'acc-a', name: '阿杰', crew_roles: ['导演'], left: false };
const REF_B: ActorRef = { id: 'acc-b', name: '阿丽', crew_roles: ['摄影', '剪辑'], left: false };

let app: PlanApp;
let personalDir: string;
let db: DbPort;
let scene: Scene;
let shot: Shot;

/** Run fn as this member, in a request whose roster is `members`, the way the group instance's middleware does. */
function as<T>(actor: Actor, fn: () => T, members: RosterEntry[] = BOTH): T {
  const req: HostedRequest = { actor, roster: () => members, personalDir };
  return runWithRequest(req, () => {
    syncMember(db, actor);
    return fn();
  });
}

const txt = () => fixtureText('01-bookshop.txt');
const scriptInput = () => ({ text: txt(), source_name: '01-bookshop.txt', format: 'txt' as const, heading_overrides: [] });

beforeEach(async () => {
  app = await makePlanApp();
  db = app.handle.projectSession.require().db;
  personalDir = mkdtempSync(join(tmpdir(), 'ssm-s4-own-'));
  // the base project is made by nobody (outside any request), like the local app
  const imported = importScript(db, scriptInput());
  scene = imported.scenes[0]!;
  shot = createShot(db, { scene_id: scene.id, fields: fields(scene), manual_note: '基础镜头' });
});

afterEach(() => {
  app.close();
  rmSync(personalDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('S4 who made each history row (services inside a hosted request)', () => {
  test('outside a request there is no actor at all', () => {
    expect(currentActor()).toBeNull();
    expect(actorId()).toBeNull();
    expect(listShotRevisions(db, shot.id).map((r) => r.actor ?? null)).toEqual([null]);
    expect(listVersionSummaries(db).map((v) => v.actor ?? null)).toEqual([null]);
    expect(runWithRequest(null, () => actorId())).toBeNull();
    expect(as(A, () => actorId())).toBe('acc-a');
    expect(as(A, () => currentActor())).toEqual(A);
  });

  test('shot revisions: A creates, B edits — each revision names its maker with roles', () => {
    const created = as(A, () => createShot(db, { scene_id: scene.id, fields: fields(scene, { action: '甲建的镜头' }), manual_note: '甲建' }));
    const edited = as(B, () => updateShot(db, created.id, { expected_revision: created.revision, fields: fields(scene, { action: '乙改的镜头' }) }));
    expect(edited.revision).toBe(created.revision + 1);

    const revs = listShotRevisions(db, created.id);
    expect(revs.map((r) => r.revision)).toEqual([0, 1]);
    expect(revs.map((r) => r.actor)).toEqual([REF_A, REF_B]);
    // the same rows are what the route would return; ShotRevision never carries an email or account fields
    expect(JSON.stringify(revs)).not.toMatch(/@|email/);
  });

  test('a shot made outside a request has a null actor; the same call in a request has one', () => {
    const before = listShotRevisions(db, shot.id);
    expect(before).toHaveLength(1);
    expect(before[0]!.actor ?? null).toBeNull();
    const again = as(A, () => updateShot(db, shot.id, { expected_revision: shot.revision, locked: true }));
    expect(listShotRevisions(db, shot.id).map((r) => r.actor ?? null)).toEqual([null, REF_A]);
    // and outside again
    updateShot(db, shot.id, { expected_revision: again.revision, locked: false });
    expect(listShotRevisions(db, shot.id).map((r) => r.actor ?? null)).toEqual([null, REF_A, null]);
  });

  test('someone who is no longer in the roster shows left: true and keeps their name', () => {
    const made = as(A, () => createShot(db, { scene_id: scene.id, fields: fields(scene, { action: '离组前' }), manual_note: 'x' }));
    as(B, () => updateShot(db, made.id, { expected_revision: made.revision, fields: fields(scene, { action: '继续' }) }));

    const inGroup = as(B, () => listShotRevisions(db, made.id).map((r) => r.actor));
    expect(inGroup).toEqual([REF_A, REF_B]);

    const afterA = as(B, () => listShotRevisions(db, made.id).map((r) => r.actor), roster(B));
    expect(afterA).toEqual([{ ...REF_A, left: true }, REF_B]);
    // the list a member of the remaining group reads still carries the departed person's name and roles, never an email
    expect(afterA[0]!.name).toBe('阿杰');
    expect(afterA[0]!.crew_roles).toEqual(['导演']);
    expect(Object.keys(afterA[0]!).sort()).toEqual(['crew_roles', 'id', 'left', 'name']);
  });

  test('a renamed member or new crew roles show on their old rows; an actor the project never saw gets a placeholder name', () => {
    const made = as(A, () => createShot(db, { scene_id: scene.id, fields: fields(scene, { action: '旧名' }), manual_note: 'x' }));
    const renamed: Actor = { ...A, name: '阿杰（新）', crew_roles: ['导演', '编剧'] };
    as(renamed, () => undefined);
    expect(listShotRevisions(db, made.id).map((r) => r.actor)).toEqual([{ ...REF_A, name: '阿杰（新）', crew_roles: ['导演', '编剧'] }]);

    // a row whose account was never synced (e.g. a project copied from elsewhere): shown, not crashed
    const resolve = actorResolver(db);
    expect(resolve('acc-ghost')).toEqual({ id: 'acc-ghost', name: '已离开的组员', crew_roles: [], left: false });
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    // the roster decides `left` only inside a request
    expect(as(B, () => actorResolver(db)('acc-ghost')!.left)).toBe(true);
  });

  test('syncMember keeps one row per person and stores no email', () => {
    as(A, () => undefined);
    as(A, () => undefined);
    as({ ...A, crew_roles: ['导演', '录音'] }, () => undefined);
    as(B, () => undefined);
    const rows = db.all<{ id: string; name: string; crew_roles_json: string }>('SELECT id, name, crew_roles_json FROM member ORDER BY id');
    expect(rows).toEqual([
      { id: 'acc-a', name: '阿杰', crew_roles_json: JSON.stringify(['导演', '录音']) },
      { id: 'acc-b', name: '阿丽', crew_roles_json: JSON.stringify(['摄影', '剪辑']) },
    ]);
    const cols = db.all<{ name: string }>('PRAGMA table_info(member)').map((c) => c.name);
    expect(cols).toEqual(['id', 'name', 'crew_roles_json', 'updated_at']);
  });
});

// ---------------------------------------------------------------------------
// Table-driven: every service that writes history stamps the account (and
// leaves NULL outside a request). A writer added later without an actor shows
// up here as a null.
// ---------------------------------------------------------------------------

type Writer = { name: string; write: () => ActorRef | null | undefined };

function writers(): Writer[] {
  return [
    {
      name: 'shot create (revision 0)',
      write: () => {
        const s = createShot(db, { scene_id: scene.id, fields: fields(scene, { action: '新建' }), manual_note: 'n' });
        return listShotRevisions(db, s.id)[0]!.actor;
      },
    },
    {
      name: 'shot update (revision 1)',
      write: () => {
        updateShot(db, shot.id, { expected_revision: shot.revision, fields: fields(scene, { action: '改动' }) });
        return listShotRevisions(db, shot.id).at(-1)!.actor;
      },
    },
    {
      name: 'script version (import)',
      write: () => {
        const r = importScript(db, { ...scriptInput(), text: `${txt()}\n\n（补一段）\n`, source_name: '补稿.txt' });
        const summary = listVersionSummaries(db).find((v) => v.id === r.version.id);
        expect(getScriptVersion(db, r.version.id)!.actor ?? null).toEqual(summary!.actor ?? null);
        return summary!.actor;
      },
    },
    {
      name: 'board version (saved edit)',
      write: () => {
        const v1 = listBoards(db).find((b) => b.shot_id === shot.id)!;
        const spec: BoardSpec = structuredClone(v1.spec);
        spec.camera.focal_mm = 85;
        return saveBoard(db, v1.id, { expected_revision: v1.revision, spec }).actor;
      },
    },
    {
      name: 'coverage decision',
      write: () => addCoverageDecision(db, shot.id, { decision: 'needs_pickup', selected_link_ids: [], reason: '补一条' }).actor,
    },
    {
      name: 'take (logged_by)',
      write: () =>
        createTake(db, { setup_id: null, camera_label: 'A', rating: 'good', clip_hint: null, notes: '', shot_ids: [shot.id], unresolved_labels: [] }).logged_by,
    },
  ];
}

describe('S4 every history writer stamps the requesting account', () => {
  const names = writers().map((w) => w.name);
  test.each(names)('%s: in a request → the account; outside → null', (name) => {
    const inside = as(A, () => writers().find((w) => w.name === name)!.write());
    expect(inside).toEqual(REF_A);
  });

  test.each(names)('%s: outside any request → null (the local app)', (name) => {
    const outside = writers().find((w) => w.name === name)!.write();
    expect(outside ?? null).toBeNull();
  });

  test('a take correction records who corrected it in the audit log', () => {
    const take = as(A, () => createTake(db, { setup_id: null, camera_label: null, rating: 'unrated', clip_hint: null, notes: '', shot_ids: [shot.id], unresolved_labels: [] }));
    expect(take.logged_by).toEqual(REF_A);
    const fixed = as(B, () => updateTake(db, take.id, { expected_revision: take.revision, rating: 'good', reason: '看回放后改评级' }));
    // the correction does not rewrite who logged the take
    expect(fixed.logged_by).toEqual(REF_A);
    const audit = takeAudit(db, take.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe('acc-b');
    expect(audit[0]!.before.logged_by).toEqual(REF_A);

    const local = updateTake(db, take.id, { expected_revision: fixed.revision, notes: '本机改', reason: '本机' });
    expect(local.revision).toBe(fixed.revision + 1);
    expect(takeAudit(db, take.id).at(-1)!.actor_id ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('S4 plans: who created and who approved', () => {
  let w: World;
  beforeEach(async () => {
    w = await seedWorld(app);
    // seedWorld imported the script over HTTP (outside any request): use its scenes
    const s1 = w.scenes[0]!;
    await makeResource(app, 'location', '书店实景', [W('07:00', '21:00')], [w.shop.id]);
    await makeShot(app, s1, {});
    const setups = await expectOk<{ id: string }[]>(app.post('/api/v1/setups/derive', { keep_edited: false, default_durations: DUR }));
    for (const s of setups) await expectOk(app.patch(`/api/v1/setups/${s.id}`, { estimate_confirmed: true }));
  });

  test('created by A, approved by B; recomputing takes the approval away again', () => {
    const created = as(A, () => createPlan(db, { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }));
    expect(created.approval, JSON.stringify(created.plan.result.outcome)).toEqual({ ok: true, blockers: [] });
    expect(created.plan.created_by).toEqual(REF_A);
    expect(created.plan.approved_by ?? null).toBeNull();
    expect(created.plan.approved_at ?? null).toBeNull();

    const approved = as(B, () => approvePlan(db, created.plan.id, { expected_revision: created.plan.revision }));
    expect(approved.plan.status).toBe('approved');
    expect(approved.plan.created_by).toEqual(REF_A);
    expect(approved.plan.approved_by).toEqual(REF_B);
    expect(approved.plan.approved_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));

    // read back from the database, as the plan page would
    const reread = getPlanDetail(db, created.plan.id).plan;
    expect(reread.created_by).toEqual(REF_A);
    expect(reread.approved_by).toEqual(REF_B);

    // going back to draft means nobody stands behind the new result
    const again = as(A, () => recomputePlan(db, created.plan.id, { expected_revision: approved.plan.revision }));
    expect(again.plan.status).toBe('draft');
    expect(again.plan.approved_by ?? null).toBeNull();
    expect(again.plan.approved_at ?? null).toBeNull();
    expect(again.plan.created_by).toEqual(REF_A);
  });

  test('a local plan has no creator or approver (the approval time is still kept)', () => {
    const created = createPlan(db, { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' });
    expect(created.plan.created_by ?? null).toBeNull();
    const approved = approvePlan(db, created.plan.id, { expected_revision: created.plan.revision });
    expect(approved.plan.status).toBe('approved');
    expect(approved.plan.approved_by ?? null).toBeNull();
    expect(approved.plan.approved_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });
});

// ---------------------------------------------------------------------------

const draftFor = (scope: Record<string, unknown>): ShotDraft => ({
  id: randomUUID(),
  kind: 'entities',
  scope,
  model: 'fake-model',
  prompt_version: 'entities-v1',
  raw_output: '{}',
  parsed: { characters: [], locations: [], props: [] },
  issues: [],
  attempts: 1,
  usage: null,
  status: 'pending',
  created_at: new Date().toISOString(),
});

describe('S4 jobs remember who started them (run and commit happen after the request returned)', () => {
  test('job.actor, the draft it commits and currentActor() inside run all name the requester', async () => {
    const queue = new JobQueue(db);
    const seen: { run: string | null; commit: string | null } = { run: null, commit: null };
    let draftId = '';
    let release: () => void = () => undefined;
    const gate = { promise: new Promise<void>((r) => (release = r)), resolve: () => release() };
    const spec: JobSpec = {
      kind: 'extract_entities',
      idempotency_key: 'k-a',
      input_hash: 'h',
      remote: true,
      lane: 'llm',
      model_source: 'own',
      run: async () => {
        await gate.promise; // the request that queued this has long returned
        seen.run = actorId();
        return {
          status: 'succeeded',
          attempts: 1,
          usage: null,
          commit: () => {
            seen.commit = actorId();
            const d = draftFor({ script_version_id: 'x' });
            draftId = d.id;
            insertDraft(db, d);
            return d.id;
          },
        };
      },
    };
    const queued = as(A, () => queue.enqueue(spec));
    // as returned to the requester right away
    expect(queued.status).toBe('queued');
    expect(queued.actor).toEqual(REF_A);
    expect(queued.model_source).toBe('own');
    expect(currentActor()).toBeNull(); // we are out of the request now
    gate.resolve();
    await queue.idle();

    expect(seen).toEqual({ run: 'acc-a', commit: 'acc-a' });
    const done = getJob(db, queued.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.actor).toEqual(REF_A);
    expect(done.model_source).toBe('own');
    expect(done.result_ref).toBe(draftId);
    expect(getDraft(db, draftId)!.actor).toEqual(REF_A);
  });

  test('two members queue back to back: each job runs and commits as its own requester; a local job stays anonymous', async () => {
    const queue = new JobQueue(db);
    const order: string[] = [];
    const draftIds: Record<string, string> = {};
    const mk = (key: string): JobSpec => ({
      kind: 'extract_entities',
      idempotency_key: key,
      input_hash: key,
      remote: true,
      lane: 'llm',
      model_source: null,
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${key}:${actorId() ?? 'none'}`);
        return {
          status: 'succeeded',
          attempts: 1,
          usage: null,
          commit: () => {
            const d = draftFor({ key });
            draftIds[key] = d.id;
            insertDraft(db, d);
            return d.id;
          },
        };
      },
    });
    const ja = as(A, () => queue.enqueue(mk('ja')));
    const jb = as(B, () => queue.enqueue(mk('jb')));
    const jn = queue.enqueue(mk('jn'));
    await queue.idle();

    expect(order).toEqual(['ja:acc-a', 'jb:acc-b', 'jn:none']);
    expect(getJob(db, ja.id)!.actor).toEqual(REF_A);
    expect(getJob(db, jb.id)!.actor).toEqual(REF_B);
    expect(getJob(db, jn.id)!.actor ?? null).toBeNull();
    expect(getDraft(db, draftIds.ja!)!.actor).toEqual(REF_A);
    expect(getDraft(db, draftIds.jb!)!.actor).toEqual(REF_B);
    expect(getDraft(db, draftIds.jn!)!.actor ?? null).toBeNull();
    // model_source is only recorded when the caller knows it
    expect(getJob(db, ja.id)!.model_source ?? null).toBeNull();
  });

  test('a job that failed still says who started it, and a departed starter shows left', async () => {
    const queue = new JobQueue(db);
    const j = as(A, () =>
      queue.enqueue({
        kind: 'extract_entities',
        idempotency_key: 'k-fail',
        input_hash: 'h',
        remote: true,
        model_source: 'group',
        run: async () => ({ status: 'failed', attempts: 1, usage: null, error: { code: 'X', message: '失败了' } }),
      }),
    );
    await queue.idle();
    expect(getJob(db, j.id)).toMatchObject({ status: 'failed', actor: REF_A, model_source: 'group' });
    expect(as(B, () => getJob(db, j.id)!.actor, roster(B))).toEqual({ ...REF_A, left: true });
  });
});

// ---------------------------------------------------------------------------

describe('migration 004: who did it', () => {
  let root: string;
  let old: DbPort;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ssm-s4mig-'));
    old = openDb(join(root, 'p.sqlite'));
  });
  afterEach(() => {
    old.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('v3 → v4 adds the member table and nullable actor columns; existing rows keep their data with no actor', async () => {
    await migrate(old, { backupDir: join(root, 'rc'), migrations: MIGRATIONS.filter((m) => m.version <= 3) });
    expect(userVersion(old)).toBe(3);
    old.run(
      `INSERT INTO shot_draft (id, kind, scope_json, prompt_version, status, created_at) VALUES ('d1', 'breakdown', '{}', 'breakdown-v1', 'pending', '2026-09-29T00:00:00.000Z')`,
    );
    // (only up to 004: later milestones add their own migrations after it)
    const r = await migrate(old, { backupDir: join(root, 'rc'), migrations: MIGRATIONS.filter((m) => m.version <= 4) });
    expect(r.applied).toEqual(['004_actors']);
    expect(userVersion(old)).toBe(4);
    expect(PROJECT_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);

    const cols = (table: string) => old.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const t of ['shot_revision', 'board', 'board_raster', 'script_version', 'coverage_decision', 'shot_draft', 'job']) {
      expect(cols(t), t).toContain('actor_id');
    }
    expect(cols('job')).toContain('model_source');
    expect(cols('plan')).toEqual(expect.arrayContaining(['created_by', 'approved_by', 'approved_at']));
    expect(cols('take')).toContain('logged_by');
    expect(cols('member')).toEqual(['id', 'name', 'crew_roles_json', 'updated_at']);

    expect(old.get<{ id: string; actor_id: string | null }>('SELECT id, actor_id FROM shot_draft WHERE id = ?', 'd1')).toEqual({ id: 'd1', actor_id: null });
    expect(() => old.run(`UPDATE job SET model_source = 'nope'`)).not.toThrow(); // no rows yet
    expect(() =>
      old.run(
        `INSERT INTO job (id, kind, idempotency_key, remote, status, attempts, input_hash, created_at, updated_at, model_source) VALUES ('j', 'extract_entities', 'k', 1, 'queued', 0, 'h', 't', 't', 'nope')`,
      ),
    ).toThrow(/CHECK/);
  });
});

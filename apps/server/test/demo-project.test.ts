import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BoardView, CoverageResult, HealthInfo, Job, MediaAssetView, Plan, PlanDetail, Project, Shot, ShotMediaLink, Take } from '@storyscript/contracts';
import { ProjectExport } from '@storyscript/contracts';
import { demoAssetsAt, readDemoMedia, resolveDemoAssets } from '../src/demo/assets.ts';
import { DEMO_MEDIA_BUDGET_BYTES } from '../src/demo/media-manifest.ts';
import { DEMO_MARKER_FILE, DEMO_PROJECT_NAME, DemoSetupError, demoProjectDir, openDemoProject } from '../src/demo/seed.ts';
import { BREAKDOWN_REQUEST, makeM3App, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * `--demo` (M7): the demo project is rebuilt under the state directory on
 * every start and opened; each page has content; AI answers from the replay
 * recordings; nothing leaves the machine.
 */

let app: M3App;

beforeEach(async () => {
  app = await makeM3App({ demo: true, openProject: false });
});

afterEach(() => {
  app.close();
});

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

describe('demo data on disk', () => {
  test('sample script, recordings and pre-probed footage are found in the checkout; media ≤ 2 MB', () => {
    const assets = resolveDemoAssets();
    expect(assets).not.toBeNull();
    expect(existsSync(assets!.scriptFile)).toBe(true);
    expect(assets!.mediaDir).not.toBeNull();
    const manifest = readDemoMedia(assets!.mediaDir!);
    expect(manifest.clips.length).toBeGreaterThanOrEqual(4);
    for (const c of manifest.clips) {
      expect(c.poster === null || existsSync(join(assets!.mediaDir!, c.poster))).toBe(true);
      if (manifest.clips_included) expect(existsSync(join(assets!.mediaDir!, 'clips', c.rel_path))).toBe(true);
    }
    expect(dirBytes(assets!.mediaDir!)).toBeLessThanOrEqual(DEMO_MEDIA_BUDGET_BYTES);
    expect(demoAssetsAt(join(assets!.root, 'no-such-dir'))).toBeNull();
  });
});

describe('--demo project', () => {
  test('created under the state dir and opened: script, shots with boards, approved plan, takes, footage, all four coverage states', async () => {
    const summary = await openDemoProject(app.handle.deps);
    expect(summary.warnings).toEqual([]);
    expect(summary.dir).toBe(demoProjectDir(app.stateDir));
    expect(existsSync(join(summary.dir, DEMO_MARKER_FILE))).toBe(true);

    const health = (await app.get<HealthInfo>('/api/v1/health')).data;
    expect(health).toMatchObject({ demo: true, project_open: true });
    expect((await app.get<Project>('/api/v1/project')).data.name).toBe(DEMO_PROJECT_NAME);

    const shots = (await app.get<Shot[]>('/api/v1/shots')).data;
    expect(shots).toHaveLength(17);
    expect(shots.every((s) => s.origin === 'ai')).toBe(true);
    const boards = (await app.get<BoardView[]>('/api/v1/boards')).data;
    expect(boards).toHaveLength(17);
    expect(boards.every((b) => !b.stale)).toBe(true);

    const plans = (await app.get<Plan[]>('/api/v1/plans')).data;
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe('approved');
    const detail = (await app.get<PlanDetail>(`/api/v1/plans/${plans[0]!.id}`)).data;
    expect(detail.stale).toBe(false);
    expect(detail.plan.result.outcome).toBe('feasible');

    const takes = (await app.get<Take[]>('/api/v1/takes')).data;
    expect(takes).toHaveLength(7);
    expect(takes.some((t) => t.shot_ids.length === 2)).toBe(true);
    expect(takes.some((t) => t.unresolved_labels.length > 0)).toBe(true);

    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    expect(assets.length).toBe(summary.assets);
    expect(assets.every((a) => a.availability === 'online' && a.hash_status === 'done' && a.poster_url)).toBe(true);
    expect(assets.some((a) => a.playable_direct)).toBe(true);
    expect(assets.some((a) => !a.playable_direct)).toBe(true);
    const poster = await app.handle.app.request(assets[0]!.poster_url!, { headers: { host: '127.0.0.1:43203' } });
    expect(poster.status).toBe(401); // binary endpoints still need the session cookie

    const links = (await app.get<ShotMediaLink[]>('/api/v1/links')).data;
    expect(links.some((l) => l.status === 'confirmed')).toBe(true);
    expect(links.some((l) => l.status === 'candidate')).toBe(true);

    const coverage = (await app.get<CoverageResult[]>('/api/v1/coverage')).data;
    const states = new Set(coverage.map((c) => c.status));
    for (const s of ['usable', 'attempted', 'needs_pickup', 'waived', 'planned'] as const) expect(states, s).toContain(s);

    // nothing was sent: the demo AI is the replay (job.remote = false)
    const db = app.handle.projectSession.require().db;
    const jobs = db.all<{ remote: number; status: string }>('SELECT remote, status FROM job');
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    expect(jobs.every((j) => j.remote === 0 && j.status === 'succeeded')).toBe(true);

    // the export of the demo validates
    const res = await app.handle.app.request('/api/v1/export/project.json', {
      headers: { host: '127.0.0.1:43203', cookie: await cookieOf(app) },
    });
    expect(res.status).toBe(200);
    expect(ProjectExport.safeParse(await res.json()).success).toBe(true);
  });

  test('a second start resets the copy (edits are gone), AI buttons replay, a missing recording explains itself', async () => {
    await openDemoProject(app.handle.deps);
    const first = (await app.get<Shot[]>('/api/v1/shots')).data;
    await app.patch(`/api/v1/shots/${first[0]!.id}`, { expected_revision: first[0]!.revision, locked: true });

    const again = await openDemoProject(app.handle.deps);
    expect(again.warnings).toEqual([]);
    const shots = (await app.get<Shot[]>('/api/v1/shots')).data;
    expect(shots).toHaveLength(17);
    expect(shots.some((s) => s.locked)).toBe(false);
    expect(shots.map((s) => s.id)).not.toContain(first[0]!.id);

    // replayed breakdown of scene 1 → a new draft, nothing sent
    const scene = shots[0]!.scene_id;
    const accepted = await app.post<{ job_id: string }>(`/api/v1/scenes/${scene}/breakdown`, BREAKDOWN_REQUEST);
    expect(accepted.status).toBe(202);
    const job = await waitJob(app, accepted.data.job_id);
    expect(job).toMatchObject<Partial<Job>>({ status: 'succeeded', remote: false });

    // the order suggestion has no recording for this plan → a clear failure, not a silent fallback
    const plans = (await app.get<Plan[]>('/api/v1/plans')).data;
    const sug = await app.post<{ job_id: string }>(`/api/v1/plans/${plans[0]!.id}/suggest-order`);
    expect(sug.status).toBe(202);
    const sj = await waitJob(app, sug.data.job_id);
    expect(sj.status).toBe('failed');
    expect(sj.error?.message).toMatch(/演示模式/);
  });

  test('refuses to reset a folder that is not a demo copy', async () => {
    const dir = demoProjectDir(app.stateDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'important.txt'), 'not ours');
    await expect(openDemoProject(app.handle.deps)).rejects.toBeInstanceOf(DemoSetupError);
    expect(existsSync(join(dir, 'important.txt'))).toBe(true);
  });

  test('without footage on disk the clips are offline but posters and metadata still load', async () => {
    const assets = resolveDemoAssets()!;
    const copy = join(app.root, 'media-copy');
    mkdirSync(copy, { recursive: true });
    cpSync(join(assets.mediaDir!, 'media.json'), join(copy, 'media.json'));
    cpSync(join(assets.mediaDir!, 'posters'), join(copy, 'posters'), { recursive: true });
    const summary = await openDemoProject(app.handle.deps, { assets: { ...assets, mediaDir: copy } });
    expect(summary.clips_online).toBe(false);
    expect(summary.warnings.join('\n')).toMatch(/离线/);
    const list = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((a) => a.availability === 'offline' && a.poster_url !== null)).toBe(true);
    const coverage = (await app.get<CoverageResult[]>('/api/v1/coverage')).data;
    expect(coverage.some((c) => c.status === 'needs_pickup')).toBe(true);
    expect(coverage.some((c) => c.status === 'usable')).toBe(false); // usable needs an online clip

    const noMedia = await openDemoProject(app.handle.deps, { assets: { ...assets, mediaDir: null } });
    expect(noMedia.assets).toBe(0);
    expect(noMedia.warnings.join('\n')).toMatch(/samples\/demo-media/);
  });
});

async function cookieOf(a: M3App): Promise<string> {
  const session = await a.handle.app.request('/api/v1/session', {
    method: 'POST',
    headers: { host: '127.0.0.1:43203', origin: 'http://127.0.0.1:43203', 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'm3-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF' }),
  });
  return (session.headers.get('set-cookie') ?? '').split(';')[0]!;
}

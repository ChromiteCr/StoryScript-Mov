import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { Job, MediaAssetView, RecentProject, SourceRoot } from '@storyscript/contracts';
import { listRoots } from '../src/db/repos/root.ts';
import { isAppError } from '../src/http/errors.ts';
import { createProject, openProject, type OpenedProject } from '../src/project/project.ts';
import { HAS_FFMPEG, makeWorkspace, snapshotDir, startApp, waitJob, type MediaApp, type Workspace } from './media-fixture.ts';

/**
 * S1e: a project is a folder the user opens, like a folder in VS Code. The
 * project's data goes into its hidden .storyscript-mov/; the footage in the
 * folder (A-roll/, B-roll/ …) is the project root, scanned when the project
 * opens and still online after the whole folder moves. Projects made before
 * this layout (project.json in the folder itself) keep working.
 */

const CLIPS = join(import.meta.dirname, '..', '..', '..', 'samples', 'demo-media', 'clips');
const input = { name: '我的短片', timezone: 'Asia/Shanghai', default_aspect: '2.39' as const, target_duration_s: null };

function withFootage(folder: string): void {
  mkdirSync(join(folder, 'A-roll'), { recursive: true });
  mkdirSync(join(folder, 'B-roll'), { recursive: true });
  cpSync(join(CLIPS, 'A001C003.mov'), join(folder, 'A-roll', 'A001C003.mov'));
  cpSync(join(CLIPS, 'S01-001-T01.mp4'), join(folder, 'A-roll', 'S01-001-T01.mp4'));
  cpSync(join(CLIPS, 'B002C001.mov'), join(folder, 'B-roll', 'B002C001.mov'));
}

async function expectAppError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(isAppError(err) && err.code).toBe(code);
}

describe('project folder layout', () => {
  let root = '';
  const opened: OpenedProject[] = [];
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ssm-folder-')));
  });
  afterEach(() => {
    while (opened.length) opened.pop()!.close();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a folder with footage becomes a project; data goes into .storyscript-mov and the folder is the project root', async () => {
    const folder = join(root, '我的短片');
    withFootage(folder);
    const before = await snapshotDir(join(folder, 'A-roll'));
    const p = await createProject(folder, input);
    opened.push(p);
    expect(p.folder).toBe(folder);
    expect(p.dir).toBe(join(folder, '.storyscript-mov'));
    expect(readdirSync(folder).sort()).toEqual(['.storyscript-mov', 'A-roll', 'B-roll']);
    expect(existsSync(join(p.dir, 'project.json'))).toBe(true);
    expect(await snapshotDir(join(folder, 'A-roll'))).toEqual(before);
    const roots = listRoots(p.db);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ kind: 'project', abs_path: 'project:', label: '我的短片' });
  });

  test('opening the folder or its .storyscript-mov gives the same project; a folder that already is one cannot be created again', async () => {
    const folder = join(root, 'again');
    const p = await createProject(folder, input);
    const id = p.project().id;
    p.close();
    for (const dir of [folder, join(folder, '.storyscript-mov')]) {
      const q = await openProject(dir);
      expect(q.project().id).toBe(id);
      expect(q.folder).toBe(folder);
      q.close();
    }
    await expectAppError(createProject(folder, input), 'PROJECT_EXISTS');
  });

  test('a folder that is not a project opens as NOT_FOUND (the UI then offers to make it one)', async () => {
    const folder = join(root, 'plain');
    mkdirSync(folder);
    await expectAppError(openProject(folder), 'NOT_FOUND');
  });

  test('legacy layout (project.json in the folder itself) still opens, and cannot be re-created', async () => {
    const made = join(root, 'made');
    const p = await createProject(made, input);
    const id = p.project().id;
    p.close();
    const legacy = join(root, 'legacy');
    renameSync(join(made, '.storyscript-mov'), legacy);
    const q = await openProject(legacy);
    expect(q.project().id).toBe(id);
    expect(q.folder).toBe(legacy);
    expect(q.dir).toBe(legacy);
    q.close();
    await expectAppError(createProject(legacy, input), 'PROJECT_EXISTS');
  });

  test('a hosted team project has no project root (its folder is on the server)', async () => {
    const p = await createProject(join(root, 'team'), input, { projectRoot: false });
    opened.push(p);
    expect(listRoots(p.db)).toEqual([]);
  });
});

describe.skipIf(!HAS_FFMPEG)('project folder footage: scanned on open, survives a move', () => {
  let ws: Workspace;
  let app: MediaApp | null = null;
  beforeAll(() => {
    ws = makeWorkspace('ssm-s1e-');
    withFootage(ws.projectDir);
  });
  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  const settle = async (a: MediaApp) => {
    for (const j of (await a.get<Job[]>('/api/v1/jobs')).data) if (j.kind === 'scan_root') await waitJob(a, j.id);
  };

  test('creating the project scans its folder: footage in subfolders, nothing from .storyscript-mov', async () => {
    app = await startApp(ws, { create: true });
    await settle(app);
    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    expect(assets.map((a) => a.rel_path).sort()).toEqual(['A-roll/A001C003.mov', 'A-roll/S01-001-T01.mp4', 'B-roll/B002C001.mov']);
    expect(assets.every((a) => a.root_kind === 'project' && a.availability === 'online')).toBe(true);
    expect(assets.find((a) => a.rel_path.endsWith('S01-001-T01.mp4'))!.stream_url).not.toBeNull();
    const recent = (await app.get<RecentProject[]>('/api/v1/projects/recent')).data;
    expect(recent[0]!.dir).toBe(ws.projectDir);
  });

  test('the whole folder moves; opening it again finds the same footage online', async () => {
    const ids = (await app!.get<MediaAssetView[]>('/api/v1/media/assets')).data.map((a) => a.id).sort();
    app!.shutdown();
    app = null;
    const moved = join(ws.root, '搬家后');
    renameSync(ws.projectDir, moved);
    const ws2: Workspace = { ...ws, projectDir: moved, dataDir: join(moved, '.storyscript-mov') };
    app = await startApp(ws2, { create: false });
    await settle(app);
    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    expect(assets.map((a) => a.id).sort()).toEqual(ids);
    expect(assets.every((a) => a.availability === 'online')).toBe(true);
    const roots = (await app.get<SourceRoot[]>('/api/v1/media/roots')).data;
    expect(roots.map((r) => r.kind)).toEqual(['project']);
  });
});

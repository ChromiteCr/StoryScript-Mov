import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntitiesOutput, type Entity, type Job, type Project, type Shot, type ShotMediaLink } from '@storyscript/contracts';
import { deriveMediaFlags, localWindowToUtc, utcToLocal } from '@storyscript/core';
import { hashFile } from '../adapters/media/hash.ts';
import { startBreakdown, startEntityExtraction } from '../ai/jobs.ts';
import { configureAi, projectContext } from '../ai/runtime.ts';
import type { DbPort } from '../db/port.ts';
import { getDraft } from '../db/repos/draft.ts';
import { listEntities } from '../db/repos/entity.ts';
import { listLinks } from '../db/repos/link.ts';
import { insertAsset, setAssetAvailability, setAssetHash, setAssetPoster, setAssetProbe } from '../db/repos/media.ts';
import { insertRoot } from '../db/repos/root.ts';
import { latestScriptVersion, listScenes, updateSceneRow, type SceneRecord } from '../db/repos/script.ts';
import { getShot, listActiveShots } from '../db/repos/shot.ts';
import type { AppDeps } from '../deps.ts';
import { isAppError } from '../http/errors.ts';
import { isPidAlive, LOCK_FILE, readLock } from '../project/lock.ts';
import { ensuringBoards } from '../services/boards/boards.ts';
import { addCoverageDecision } from '../services/coverage/coverage.ts';
import { applyBreakdown } from '../services/drafts.ts';
import { applyEntityDraft, createEntity } from '../services/entities.ts';
import { buildLinkCandidates, reviewLink } from '../services/media/links.ts';
import { addRoot } from '../services/media/roots.ts';
import { createTake } from '../services/media/takes.ts';
import { approvePlan, createPlan } from '../services/plan/plans.ts';
import { createResource } from '../services/plan/resources.ts';
import { deriveSetups, updateSetup } from '../services/plan/setups.ts';
import { importScript } from '../services/scripts.ts';
import { setRequirement } from '../services/shots.ts';
import { readDemoMedia, resolveDemoAssets, type DemoAssets } from './assets.ts';

/**
 * `storyscript-mov --demo`: a fresh copy of the demo project under the global
 * state directory (<STORYSCRIPT_HOME>/demo/bookshop), rebuilt on every start
 * and opened right away. Everything goes through the same services the API
 * uses, so the demo is an ordinary project:
 *
 *   script   the original sample 01-bookshop.txt, scenes by the rule parser
 *   AI       entity extraction and per-scene breakdown answered by the replay
 *            recordings (fixtures/replay), applied → shots + automatic boards
 *   plan     cast, two locations and a dolly; setups derived and confirmed;
 *            one shooting day computed and approved (today, project zone)
 *   set      takes, one of them covering two shots, one with a clip name,
 *            one with a hand-written label that matches no shot
 *   media    pre-probed lavfi footage from samples/demo-media (metadata and
 *            480px posters from media.json; clips read-only from clips/, or
 *            offline when the clips are not there)
 *   links    candidates by rule R1/R2, some confirmed, one usable decision,
 *            one pickup, one waived shot → usable / attempted / needs_pickup /
 *            waived all appear in coverage
 * Nothing is sent anywhere (demo AI = replay). The folder is only ever
 * deleted when it carries the demo marker file and no live process holds it.
 */

export const DEMO_PROJECT_NAME = '旧书（演示）';
export const DEMO_MARKER_FILE = 'storyscript-demo.json';
export const DEMO_TIMEZONE = 'Asia/Shanghai';

export const demoProjectDir = (stateDir: string) => join(stateDir, 'demo', 'bookshop');

export interface DemoSummary {
  dir: string;
  project: Project;
  scenes: number;
  shots: number;
  boards: number;
  takes: number;
  assets: number;
  plan: { id: string; date: string; approved: boolean } | null;
  /** clips were found on disk (false → assets are offline) */
  clips_online: boolean;
  warnings: string[];
}

export class DemoSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSetupError';
  }
}

/** Remove a previous demo copy; refuses anything that is not ours or is still open elsewhere. */
export function resetDemoDir(dir: string): void {
  if (!existsSync(dir)) return;
  const lock = readLock(join(dir, LOCK_FILE));
  if (lock && lock.pid !== process.pid && isPidAlive(lock.pid)) {
    throw new DemoSetupError(`演示项目正被另一个 storyscript-mov 进程使用（pid ${lock.pid}）。先关闭它，或用 STORYSCRIPT_HOME 指定另一个状态目录。`);
  }
  const entries = readdirSync(dir);
  if (entries.length > 0 && !entries.includes(DEMO_MARKER_FILE)) {
    throw new DemoSetupError(`${dir} 里的内容不是演示项目，为避免误删，没有重置。请移走该文件夹后再用 --demo 启动。`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ helpers

async function settle(deps: AppDeps, job: Job): Promise<Job> {
  const { jobs } = projectContext(deps);
  await jobs.idle();
  return jobs.require(job.id);
}

const byCode = (shots: readonly Shot[], sceneId: string, code: string) => shots.find((s) => s.scene_id === sceneId && s.code === code) ?? null;

function locationFor(scene: SceneRecord, locations: readonly Entity[]): Entity | null {
  // the longest location name inside the heading ("旧书店后屋" before "旧书店")
  const hits = locations.filter((l) => [l.name, ...l.aliases].some((n) => n && scene.heading.includes(n)));
  return hits.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

/** Apply a breakdown draft: every item without errors (the recordings are valid; this only guards). */
function applyAll(db: DbPort, draftId: string, count: number): number {
  let selected = Array.from({ length: count }, (_, i) => i);
  for (let round = 0; round < 3 && selected.length > 0; round++) {
    try {
      const r = db.tx(() => ensuringBoards(db, applyBreakdown(db, draftId, { selected, replace_existing: false, expected_revisions: {} })));
      return r.created.length;
    } catch (err) {
      const bad = isAppError(err, 'VALIDATION_ERROR') ? ((err.details as { items?: number[] } | undefined)?.items ?? null) : null;
      if (!bad) throw err;
      selected = selected.filter((i) => !bad.includes(i));
    }
  }
  return 0;
}

// ------------------------------------------------------------------ seed

export interface OpenDemoOptions {
  assets?: DemoAssets | null;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Create (or reset) the demo project, fill it, leave it open in
 * deps.projectSession. Throws DemoSetupError when it cannot be created at all;
 * a missing optional input (footage, a recording) only adds a warning.
 */
export async function openDemoProject(deps: AppDeps, opts: OpenDemoOptions = {}): Promise<DemoSummary> {
  const assets = opts.assets === undefined ? resolveDemoAssets() : opts.assets;
  if (!assets) {
    throw new DemoSetupError('找不到演示数据（fixtures/scripts/01-bookshop.txt）。请在源码仓库里运行 npm start -- --demo。');
  }
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const warnings: string[] = [];
  const warn = (w: string) => {
    warnings.push(w);
    opts.log?.(`演示数据：${w}`);
  };

  const dir = demoProjectDir(deps.stateDir);
  await deps.projectSession.close();
  resetDemoDir(dir);
  const project = await deps.projectSession.create({
    dir,
    name: DEMO_PROJECT_NAME,
    timezone: DEMO_TIMEZONE,
    default_aspect: '2.39',
    target_duration_s: 300,
  });
  writeFileSync(
    join(dir, DEMO_MARKER_FILE),
    `${JSON.stringify({ format: 'storyscript-mov-demo', note: '由 storyscript-mov --demo 生成，每次以演示模式启动时重置', created_at: iso() }, null, 2)}\n`,
  );
  configureAi(deps, { replayDir: assets.replayDir });
  const { project: opened } = projectContext(deps);
  const db = opened.db;

  // ---- script
  const text = readFileSync(assets.scriptFile, 'utf8');
  importScript(db, { text, source_name: 'demo-01-bookshop.txt', format: 'txt', heading_overrides: [] }, iso());
  const version = latestScriptVersion(db)!;
  const scenes = listScenes(db, version.id);

  // ---- entities (replay), manual fallback
  const ex = await settle(deps, startEntityExtraction(deps));
  const exDraft = ex.status === 'succeeded' && ex.result_ref ? getDraft(db, ex.result_ref) : null;
  const exParsed = exDraft ? EntitiesOutput.safeParse(exDraft.parsed) : null;
  if (exDraft && exParsed?.success) {
    const items = (['characters', 'locations', 'props'] as const).flatMap((kind) =>
      exParsed.data[kind].map((e, index) => ({ kind, index, name: e.name, aliases: e.aliases })),
    );
    applyEntityDraft(db, exDraft.id, { items });
  } else {
    warn(`实体抽取回放不可用（${ex.error?.message ?? ex.status}），改为手工创建角色和地点`);
    createEntity(db, { type: 'character', name: '周明远', aliases: ['老周'] });
    createEntity(db, { type: 'character', name: '林晓', aliases: [] });
    createEntity(db, { type: 'location', name: '旧书店', aliases: [] });
    createEntity(db, { type: 'location', name: '旧书店后屋', aliases: ['后屋'] });
  }
  const entities = listEntities(db);
  const locations = entities.filter((e) => e.type === 'location');
  for (const scene of scenes) {
    const loc = locationFor(scene, locations);
    if (loc) updateSceneRow(db, scene.id, { location_entity_id: loc.id });
  }

  // ---- breakdown (replay) → shots + boards
  for (const scene of scenes) {
    const job = await settle(deps, startBreakdown(deps, scene.id, { technique_id: null, reference_note: null, max_shots: 16, target_seconds: null }));
    const draft = job.status === 'succeeded' && job.result_ref ? getDraft(db, job.result_ref) : null;
    const count = draft && draft.parsed && typeof draft.parsed === 'object' ? ((draft.parsed as { shots?: unknown[] }).shots?.length ?? 0) : 0;
    if (!draft || count === 0) {
      warn(`第 ${scene.display_no} 场的拆镜回放不可用（${job.error?.message ?? job.status}）`);
      continue;
    }
    applyAll(db, draft.id, count);
  }

  const [s1, s2] = scenes;
  let shots = listActiveShots(db);
  const shot = (scene: SceneRecord | undefined, code: string) => (scene ? byCode(shots, scene.id, code) : null);

  // ---- requirements: one waived, one optional
  const waive = shot(s2, '003');
  if (waive) setRequirement(db, waive.id, { expected_revision: waive.revision, required_status: 'waived', reason: '与 2-002 合并拍：墙上合影用一个推镜完成' }, iso());
  const optional = shot(s1, '012');
  if (optional) setRequirement(db, optional.id, { expected_revision: optional.revision, required_status: 'optional', reason: '时间够再拍的补充反打' }, iso());

  // ---- plan: cast, locations, dolly; setups; one approved day
  const today = utcToLocal(iso(), DEMO_TIMEZONE).date;
  const W = (a: string, b: string) => localWindowToUtc(today, a, b, DEMO_TIMEZONE);
  const character = (name: string) => entities.find((e) => e.type === 'character' && e.name === name) ?? null;
  const place = (name: string) => locations.find((e) => e.name === name) ?? null;
  const c1 = character('周明远');
  const c2 = character('林晓');
  const shop = place('旧书店');
  const back = place('旧书店后屋');
  if (c1) createResource(db, { type: 'performer', name: '陈远山', windows: [W('08:00', '19:00')], cast_character_ids: [c1.id], confirmed: true });
  if (c2) createResource(db, { type: 'performer', name: '许一禾', windows: [W('09:00', '20:00')], cast_character_ids: [c2.id], confirmed: true });
  if (shop) createResource(db, { type: 'location', name: '书店实景', windows: [W('07:00', '21:00')], cast_character_ids: [shop.id], confirmed: true });
  if (back) createResource(db, { type: 'location', name: '后屋实景', windows: [W('07:00', '21:00')], cast_character_ids: [back.id], confirmed: true });
  const dolly = createResource(db, { type: 'equipment', name: '轨道车', windows: [W('08:00', '20:00')], cast_character_ids: [], confirmed: true });
  const setups = deriveSetups(db, { keep_edited: false, default_durations: { setup_min: 20, per_shot_min: 10, reset_min: 5 } }, iso());
  const trackShots = new Set(listActiveShots(db).filter((s) => s.fields.movement === 'track').map((s) => s.id));
  for (const s of setups) {
    updateSetup(db, s.id, { estimate_confirmed: true, ...(s.shot_ids.some((id) => trackShots.has(id)) ? { resource_ids: [dolly.id] } : {}) });
  }
  let plan: DemoSummary['plan'] = null;
  if (setups.length > 0) {
    const detail = createPlan(db, { date: today, crew_call: '08:00', crew_wrap: '20:00' }, iso());
    let approved = false;
    if (detail.approval.ok) {
      approved = approvePlan(db, detail.plan.id, { expected_revision: detail.plan.revision }, iso()).plan.status === 'approved';
    } else {
      warn(`演示计划没有通过批准校验（${detail.plan.result.outcome}，${detail.approval.blockers.length} 项），保留为草案`);
    }
    plan = { id: detail.plan.id, date: today, approved };
  }

  // ---- set log
  shots = listActiveShots(db);
  const setupOf = (s: Shot | null) => (s ? (getShot(db, s.id)?.setup_id ?? null) : null);
  const take = (list: (Shot | null)[], rating: 'good' | 'alternate' | 'reject' | 'unrated', clip: string | null, notes: string, labels: string[] = []) => {
    const ids = list.filter((s): s is Shot => s !== null).map((s) => s.id);
    if (ids.length === 0 && labels.length === 0) return null;
    return createTake(
      db,
      { setup_id: setupOf(list[0] ?? null), camera_label: 'A', rating, clip_hint: clip, notes, shot_ids: ids, unresolved_labels: labels },
      iso(),
    );
  };
  const t = {
    s001: shot(s1, '001'),
    s002: shot(s1, '002'),
    s003: shot(s1, '003'),
    s004: shot(s1, '004'),
    s005: shot(s1, '005'),
    s006: shot(s1, '006'),
  };
  take([t.s001], 'good', null, '光柱清楚，灰尘够');
  take([t.s002], 'good', null, '');
  take([t.s003], 'reject', null, '跑焦');
  take([t.s003], 'good', null, '门铃声干净');
  take([t.s004, t.s005], 'good', 'A001C003', '一条过两个镜头：过肩接老周近景');
  take([t.s006], 'alternate', 'IMG_1234', '手机补拍的备选，需代理才能在浏览器播放');
  take([], 'unrated', null, '场记本上的镜号对不上，待核对', ['1-13']);

  // ---- media: pre-probed footage, read-only
  let assetCount = 0;
  let clipsOnline = false;
  if (assets.mediaDir) {
    const manifest = readDemoMedia(assets.mediaDir);
    const clipsDir = join(assets.mediaDir, 'clips');
    clipsOnline = manifest.clips_included && existsSync(clipsDir);
    let rootId: string;
    const label = 'A 机 · 演示素材';
    if (clipsOnline) {
      rootId = (await addRoot(db, opened.dir, { abs_path: realpathSync(clipsDir), label }, iso())).root.id;
    } else {
      rootId = randomUUID();
      insertRoot(db, { id: rootId, abs_path: clipsDir, label, created_at: iso() });
      warn('演示素材的原片不在（samples/demo-media/clips），素材显示为离线，海报帧和元数据照常');
    }
    const posterDir = join(opened.dir, 'derivatives', 'posters');
    mkdirSync(posterDir, { recursive: true });
    for (const clip of manifest.clips) {
      const id = randomUUID();
      const file = join(clipsDir, ...clip.rel_path.split('/'));
      const st = clipsOnline ? statSync(file, { throwIfNoEntry: false }) : undefined;
      const ext = clip.rel_path.slice(clip.rel_path.lastIndexOf('.') + 1).toLowerCase();
      const flags = deriveMediaFlags(clip.probe, ext);
      const name = clip.rel_path.split('/').pop() ?? clip.rel_path;
      db.tx(() => {
        insertAsset(db, {
          id,
          source_root_id: rootId,
          rel_path: clip.rel_path,
          size: st?.size ?? clip.size,
          mtime_ms: st?.mtimeMs ?? 0,
          kind: flags.kind,
          search_text: `${name} ${clip.rel_path}`,
          created_at: iso(),
        });
        setAssetProbe(db, id, { probe: clip.probe, ...flags });
      });
      if (clip.poster) {
        const rel = `derivatives/posters/${id}.jpg`;
        copyFileSync(join(assets.mediaDir, ...clip.poster.split('/')), join(opened.dir, ...rel.split('/')));
        setAssetPoster(db, id, rel);
      }
      if (st?.isFile()) {
        const h = await hashFile(file, { expect: { size: st.size, mtimeMs: st.mtimeMs } });
        if (h.status === 'done') setAssetHash(db, id, 'done', h.sha256);
        else setAssetHash(db, id, 'source_changed', null);
      } else {
        setAssetAvailability(db, id, 'offline');
      }
      assetCount++;
    }
  } else {
    warn('没有找到 samples/demo-media，演示项目不含素材');
  }

  // ---- links and coverage decisions
  if (assetCount > 0) {
    buildLinkCandidates(db, { user_regex: null }, iso());
    const linkOf = (s: Shot | null): ShotMediaLink | null => (s ? (listLinks(db).find((l) => l.shot_id === s.id) ?? null) : null);
    const confirm = (s: Shot | null) => {
      const l = linkOf(s);
      return l ? reviewLink(db, l.id, { expected_revision: l.revision, action: 'confirm' }, iso()) : null;
    };
    const first = confirm(t.s001);
    confirm(t.s002);
    confirm(t.s004);
    if (first && clipsOnline && t.s001) {
      addCoverageDecision(db, t.s001.id, { decision: 'usable', selected_link_ids: [first.id], reason: '光柱和灰尘都在，构图可用' }, iso());
    }
  }
  if (t.s005) addCoverageDecision(db, t.s005.id, { decision: 'needs_pickup', selected_link_ids: [], reason: '老周停手的动作穿帮，需要补拍近景' }, iso());

  const summary: DemoSummary = {
    dir: opened.dir,
    project,
    scenes: scenes.length,
    shots: listActiveShots(db).length,
    boards: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM board')!.n,
    takes: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM take')!.n,
    assets: assetCount,
    plan,
    clips_online: clipsOnline,
    warnings,
  };
  opts.log?.(`演示项目已就绪：${summary.shots} 个镜头、${summary.takes} 条场记、${summary.assets} 条素材（${opened.dir}）`);
  return summary;
}

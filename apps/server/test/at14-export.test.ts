import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ProjectExport,
  type CoverageResult,
  type CurrentScript,
  type Entity,
  type MediaAssetView,
  type Plan,
  type Resource,
  type Setup,
  type Shot,
  type ShotMediaLink,
  type SourceRoot,
  type Take,
} from '@storyscript/contracts';
import {
  buildPlanLookup,
  callSheetCsv,
  coverageCsv,
  exportShotRefs,
  parseCsv,
  shotListCsv,
  SOURCE_RANGE_COLUMNS,
  sourceRangeFromColumns,
  takeMediaCsv,
} from '@storyscript/core';
import { openDemoProject } from '../src/demo/seed.ts';
import { llmEnv, makeM3App, TEST_KEY, type M3App } from './helpers/m3-app.ts';

/**
 * AT-14 (export only, SPEC §7 / FR-10): Chinese CSV and JSON stay readable
 * (UTF-8, optional BOM), formula cells are neutralised, the five source_range
 * columns read back without loss, the project JSON validates against
 * ProjectExport and carries no absolute path, no key and no private log. The
 * server's CSV is the same text the page builds with the same core function.
 */

const HOST = '127.0.0.1:43203';
const TOKEN = 'm3-token-0123456789abcdefghijklmnopqrstuvwxyz_ABCDEF';

let app: M3App;
let cookie: string;

interface Download {
  status: number;
  type: string | null;
  disposition: string | null;
  bytes: Uint8Array;
  text: string;
}

async function download(path: string, withCookie = true): Promise<Download> {
  const res = await app.handle.app.request(path, { headers: { host: HOST, ...(withCookie ? { cookie } : {}) } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  // fatal: any invalid UTF-8 byte sequence throws (no silent U+FFFD)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), bytes, text };
}

beforeEach(async () => {
  // a text key is configured (env): it must never reach an export
  app = await makeM3App({ demo: true, openProject: false, env: llmEnv('http://127.0.0.1:9/v1', 'fake-model', TEST_KEY) });
  const session = await app.handle.app.request('/api/v1/session', {
    method: 'POST',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]!;
  await openDemoProject(app.handle.deps);
});

afterEach(() => {
  app.close();
});

const INJECTIONS = ['=HYPERLINK("http://example.invalid","点我")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=2'];

async function addInjections(): Promise<{ shot: Shot; take: Take }> {
  const shots = (await app.get<Shot[]>('/api/v1/shots')).data;
  const s = shots[6]!;
  const edited = await app.patch<Shot>(`/api/v1/shots/${s.id}`, {
    expected_revision: s.revision,
    fields: { ...s.fields, action: INJECTIONS[0], narrative_purpose: '中文：「引号」、逗号,和换行\n第二行' },
  });
  expect(edited.status, edited.text).toBe(200);
  const take = await app.post<Take>('/api/v1/takes', {
    setup_id: null,
    camera_label: INJECTIONS[3],
    rating: 'good',
    clip_hint: INJECTIONS[1],
    notes: INJECTIONS[4],
    shot_ids: [s.id],
    unresolved_labels: [INJECTIONS[2], INJECTIONS[5]],
  });
  expect(take.status, take.text).toBe(201);
  return { shot: edited.data, take: take.data };
}

/** What the page has when it builds the same CSV in the browser. */
async function pageData() {
  const script = (await app.get<CurrentScript>('/api/v1/scripts/current')).data;
  const shots = (await app.get<Shot[]>('/api/v1/shots')).data;
  const refs = exportShotRefs(shots, script.scenes);
  const assets = new Map((await app.get<MediaAssetView[]>('/api/v1/media/assets')).data.map((a) => [a.id, a] as const));
  return {
    script,
    shots,
    refs,
    assets,
    takes: (await app.get<Take[]>('/api/v1/takes')).data,
    links: (await app.get<ShotMediaLink[]>('/api/v1/links')).data,
    coverage: (await app.get<CoverageResult[]>('/api/v1/coverage')).data,
    entities: (await app.get<Entity[]>('/api/v1/entities')).data,
    plans: (await app.get<Plan[]>('/api/v1/plans')).data,
    setups: (await app.get<Setup[]>('/api/v1/setups')).data,
    resources: (await app.get<Resource[]>('/api/v1/resources')).data,
  };
}

describe('AT-14 CSV', () => {
  test('UTF-8 with optional BOM, Chinese headers, attachment names, same text as the page builds', async () => {
    await addInjections();
    const d = await pageData();
    const names = new Map(d.entities.filter((e) => e.type === 'character').map((e) => [e.alias, e.name] as const));
    const plan = d.plans[0]!;
    const lookup = buildPlanLookup({ timezone: plan.timezone, date: plan.date, setups: d.setups, shots: d.shots, resources: d.resources, scenes: d.script.scenes });
    const expected: Record<string, (bom: boolean) => string> = {
      shots: (bom) => shotListCsv({ refs: d.refs, characterNames: names }, { bom }),
      callsheet: (bom) => callSheetCsv(plan, lookup, bom),
      'takes-media': (bom) => takeMediaCsv({ refs: d.refs, takes: d.takes, links: d.links, assets: d.assets }, { bom }),
      coverage: (bom) => coverageCsv(d.coverage, d.refs, { bom }),
    };
    const header: Record<string, string> = { shots: '场', callsheet: '开始', 'takes-media': '场', coverage: '场' };
    for (const kind of Object.keys(expected)) {
      for (const bom of [false, true]) {
        const r = await download(`/api/v1/export/csv/${kind}${bom ? '?bom=1' : ''}`);
        expect(r.status, `${kind} ${r.text.slice(0, 200)}`).toBe(200);
        expect(r.type).toBe('text/csv; charset=utf-8');
        expect(r.disposition).toMatch(/^attachment; filename="storyscript-[a-z-]+-\d{4}-\d{2}-\d{2}\.csv"; filename\*=UTF-8''/);
        const star = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(r.disposition!)![1]!);
        expect(star.startsWith('旧书（演示）-')).toBe(true);
        expect([...r.bytes.slice(0, 3)]).toEqual(bom ? [0xef, 0xbb, 0xbf] : [...new TextEncoder().encode(r.text.slice(0, 1))].slice(0, 3));
        expect(r.text.startsWith('﻿')).toBe(bom);
        expect(r.text).not.toContain('�');
        expect(r.text).toBe(expected[kind]!(bom));
        const rows = parseCsv(r.text);
        expect(rows[0]![0]).toBe(header[kind]);
        expect(rows.length).toBeGreaterThan(1);
      }
    }
    // the plan is approved → no 草案 in the call sheet name; a draft plan says so
    const cs = await download('/api/v1/export/csv/callsheet');
    expect(decodeURIComponent(cs.disposition!)).not.toContain('草案');
  });

  test('formula cells are neutralised with a leading apostrophe; quotes, commas and line breaks survive', async () => {
    const { shot } = await addInjections();
    const shotsCsv = parseCsv((await download('/api/v1/export/csv/shots?bom=1')).text);
    const head = shotsCsv[0]!;
    const row = shotsCsv.find((r) => r[head.indexOf('内容')] === `'${INJECTIONS[0]}`);
    expect(row, 'action cell').toBeDefined();
    expect(row![head.indexOf('叙事目的')]).toBe('中文：「引号」、逗号,和换行\n第二行');
    expect(row![head.indexOf('镜')]).toBe(shot.code);

    const tm = parseCsv((await download('/api/v1/export/csv/takes-media')).text);
    const th = tm[0]!;
    const tr = tm.find((r) => r[th.indexOf('机位')] === `'${INJECTIONS[3]}`)!;
    expect(tr).toBeDefined();
    expect(tr[th.indexOf('机内文件名')]).toBe(`'${INJECTIONS[1]}`);
    // notes are trimmed on input (\t=1 → =1), then neutralised on output
    expect(tr[th.indexOf('备注')]).toBe(`'${INJECTIONS[4]!.trim()}`);
    expect(tr[th.indexOf('未对上的镜号')]).toBe(`'${INJECTIONS[2]}、${INJECTIONS[5]}`);
    // no string cell anywhere starts a formula
    for (const rows of [shotsCsv, tm]) {
      for (const r of rows.slice(1)) for (const cell of r) if (!/^-?\d+(\.\d+)?$/.test(cell)) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  test('source_range: five integer columns, read back exactly (big PTS too)', async () => {
    const tm = parseCsv((await download('/api/v1/export/csv/takes-media')).text);
    const head = tm[0]!;
    expect(head.slice(-5)).toEqual([...SOURCE_RANGE_COLUMNS]);
    const links = (await app.get<ShotMediaLink[]>('/api/v1/links')).data.filter((l) => l.status !== 'rejected');
    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    const rows = tm.slice(1).filter((r) => r[head.indexOf('文件')] !== '' && r[head.indexOf('in_pts')] !== '');
    expect(rows.length).toBe(links.length);
    for (const r of rows) {
      const cells = Object.fromEntries(head.map((h, i) => [h, r[i]]));
      const range = sourceRangeFromColumns(cells);
      expect(range).not.toBeNull();
      const asset = assets.find((a) => a.rel_path === cells['文件'])!;
      const link = links.find((l) => l.media_asset_id === asset.id && JSON.stringify(l.source_range) === JSON.stringify(range))!;
      expect(link, cells['文件']).toBeDefined();
      for (const k of SOURCE_RANGE_COLUMNS) expect(Number.isSafeInteger(Number(cells[k]))).toBe(true);
    }
    // a PTS beyond 2^53/2 written from a stored link comes back unchanged
    const db = app.handle.projectSession.require().db;
    const big = { stream_index: 0, in_pts: 4_503_599_627_370_000, out_pts: 4_503_599_627_371_000, time_base_num: 1, time_base_den: 90_000 };
    db.run('UPDATE shot_media_link SET source_range_json = ? WHERE id = ?', JSON.stringify(big), links[0]!.id);
    const again = parseCsv((await download('/api/v1/export/csv/takes-media')).text);
    const hit = again.slice(1).map((r) => sourceRangeFromColumns(Object.fromEntries(head.map((h, i) => [h, r[i]])))).find((x) => x?.in_pts === big.in_pts);
    expect(hit).toEqual(big);
  });

  test('bad requests: unknown kind 404, bom must be 0/1, plan_id only for the call sheet, no cookie 401', async () => {
    expect((await download('/api/v1/export/csv/everything')).status).toBe(404);
    expect((await download('/api/v1/export/csv/shots?bom=yes')).status).toBe(400);
    const plans = (await app.get<Plan[]>('/api/v1/plans')).data;
    expect((await download(`/api/v1/export/csv/shots?plan_id=${plans[0]!.id}`)).status).toBe(400);
    expect((await download('/api/v1/export/csv/callsheet?plan_id=00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await download(`/api/v1/export/csv/callsheet?plan_id=${plans[0]!.id}`)).status).toBe(200);
    expect((await download('/api/v1/export/csv/shots', false)).status).toBe(401);
    expect((await download('/api/v1/export/project.json', false)).status).toBe(401);
  });
});

describe('AT-14 project JSON', () => {
  test('validates against ProjectExport; Chinese intact; no absolute path, key, jobs, drafts or audit log', async () => {
    await addInjections();
    const r = await download('/api/v1/export/project.json');
    expect(r.status).toBe(200);
    expect(r.type).toBe('application/json; charset=utf-8');
    expect(r.disposition).toMatch(/^attachment; filename="storyscript-project-\d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''/);
    const json = JSON.parse(r.text) as unknown;
    const parsed = ProjectExport.safeParse(json);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    const x = parsed.data!;
    expect(x.project.name).toBe('旧书（演示）');
    expect(x.format).toBe('storyscript-mov-export');

    // counts match what the API shows (archived shots included in the export)
    const db = app.handle.projectSession.require().db;
    const count = (t: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
    expect(x.shots).toHaveLength(count('shot'));
    expect(x.boards).toHaveLength(count('board'));
    expect(x.takes).toHaveLength(count('take'));
    expect(x.media_assets).toHaveLength(count('media_asset'));
    expect(x.shot_media_links).toHaveLength(count('shot_media_link'));
    expect(x.coverage_decisions).toHaveLength(count('coverage_decision'));
    expect(x.plans).toHaveLength(1);
    expect(x.script_versions).toHaveLength(1);
    expect(x.scenes).toHaveLength(2);
    expect((x.script_versions[0] as { raw_text: string }).raw_text).toContain('旧书店');

    // privacy
    const roots = (await app.get<SourceRoot[]>('/api/v1/media/roots')).data;
    expect(roots.length).toBe(1);
    expect(x.source_roots).toEqual(roots.map((s) => ({ id: s.id, label: s.label })));
    for (const secret of [roots[0]!.abs_path, app.handle.projectSession.require().dir, app.stateDir, app.root, TEST_KEY]) {
      expect(r.text).not.toContain(secret);
    }
    for (const key of ['abs_path', 'api_key', 'raw_output', 'idempotency_key', 'credentials', 'authorization']) {
      expect(r.text).not.toContain(`"${key}"`);
    }
    // the take correction audit (kv) is not exported
    const t = (await app.get<Take[]>('/api/v1/takes')).data[0]!;
    await app.patch(`/api/v1/takes/${t.id}`, { expected_revision: t.revision, notes: '更正后的备注', reason: '现场记错了：审计原因' });
    const again = await download('/api/v1/export/project.json');
    expect(again.text).toContain('更正后的备注');
    expect(again.text).not.toContain('审计原因');
    // media carry root label + relative path + hash for re-linking
    for (const a of x.media_assets as { rel_path: string; sha256: string | null }[]) {
      expect(a.rel_path.startsWith('/')).toBe(false);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

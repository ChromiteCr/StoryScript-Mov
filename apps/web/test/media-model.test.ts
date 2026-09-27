import { describe, expect, it } from 'vitest';
import type { CoverageResult, MediaAssetView, ProbeNormalized, Shot, ShotMediaLink, Take } from '@storyscript/contracts';
import { parseCsv, sourceRangeFromColumns } from '@storyscript/core';
import * as labels from '../src/lib/labels-media.ts';
import type { ShotRef } from '../src/views/set/model.ts';
import {
  candidateGroups,
  conflictedAssets,
  coverageCsv,
  exportName,
  formatBytes,
  formatClipDuration,
  formatRate,
  isRangeExact,
  missingReport,
  takeMediaCsv,
  TAKE_MEDIA_COLUMNS,
  usableChoices,
} from '../src/views/media/model.ts';

/** Media page logic (FR-08…10): conflicts, usable choices, the missing list and CSV. Pure. */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ref(n: number, sceneNo: string, code: string, order: number, required: Shot['required_status'] = 'required', action = `动作 ${code}`): ShotRef {
  return {
    shot: { id: id(n), code, required_status: required, fields: { action } } as Shot,
    scene_no: sceneNo,
    scene_heading: '内景 书店 日',
    label: `${sceneNo}-${code}`,
    order,
  };
}

const refs = [ref(1, '1', '001', 1), ref(2, '1', '002', 2), ref(3, '1', '003', 3, 'optional'), ref(4, '2', '001', 4, 'waived'), ref(5, '2', '002', 5)];

const probe = (startPts: number | null, durationTs: number | null): ProbeNormalized => ({
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration_s: 2,
  timecode: null,
  creation_time: null,
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: 1920,
      height: 1080,
      time_base_num: 1,
      time_base_den: 12800,
      start_pts: startPts,
      duration_ts: durationTs,
      r_frame_rate: '25/1',
      avg_frame_rate: '25/1',
      bits_per_raw_sample: 8,
    },
  ],
});

function asset(n: number, name: string, extra: Partial<MediaAssetView> = {}): MediaAssetView {
  return {
    id: id(100 + n),
    source_root_id: id(900),
    rel_path: name,
    size: 1000,
    mtime_ms: 1,
    kind: 'video',
    probe: probe(0, 25600),
    video_stream_index: 0,
    playable_direct: true,
    is_vfr_suspect: false,
    has_timecode: false,
    sha256: 'ab'.repeat(32),
    hash_status: 'done',
    poster_path: null,
    availability: 'online',
    created_at: '2026-09-26T00:00:00.000Z',
    root_label: '卡 A',
    root_kind: 'fs',
    poster_url: null,
    stream_url: null,
    link_count: 0,
    candidate_count: 0,
    ...extra,
  };
}

const RANGE = { stream_index: 0, in_pts: 0, out_pts: 25600, time_base_num: 1, time_base_den: 12800 };

function link(n: number, shot: number, assetN: number, status: ShotMediaLink['status'], take: string | null = null, range = RANGE): ShotMediaLink {
  return {
    id: id(300 + n),
    shot_id: id(shot),
    media_asset_id: id(100 + assetN),
    take_id: take,
    source_range: range,
    evidence: 'R1',
    status,
    confirmed_at: status === 'confirmed' ? '2026-09-26T00:00:00.000Z' : null,
    revision: 0,
    created_at: '2026-09-26T00:00:00.000Z',
  };
}

describe('conflicts and candidate groups', () => {
  const takes: Pick<Take, 'id' | 'shot_ids'>[] = [
    { id: id(501), shot_ids: [id(1), id(2)] },
    { id: id(502), shot_ids: [id(5)] },
  ];

  it('one multi-shot take explains several shots on one clip; unrelated shots conflict', () => {
    expect([...conflictedAssets([link(1, 1, 1, 'candidate', id(501)), link(2, 2, 1, 'candidate', id(501))], takes)]).toEqual([]);
    expect([...conflictedAssets([link(1, 1, 1, 'candidate', id(501)), link(2, 5, 1, 'candidate', id(502))], takes)]).toEqual([id(101)]);
    expect([...conflictedAssets([link(1, 1, 1, 'candidate'), link(2, 5, 1, 'candidate')], takes)]).toEqual([id(101)]);
    // a rejected claim no longer competes
    expect([...conflictedAssets([link(1, 1, 1, 'candidate'), link(2, 5, 1, 'rejected')], takes)]).toEqual([]);
  });

  it('groups only candidate links, by shot, in narrative order', () => {
    const g = candidateGroups([link(1, 5, 1, 'candidate'), link(2, 1, 2, 'candidate'), link(3, 1, 3, 'confirmed')], refs);
    expect(g.map((x) => [x.ref?.label, x.links.length])).toEqual([
      ['1-001', 1],
      ['2-002', 1],
    ]);
  });
});

describe('usable choices', () => {
  const assets = new Map([
    [id(101), asset(1, 'A.mov')],
    [id(102), asset(2, 'B.mov', { availability: 'offline' })],
    [id(103), asset(3, 'C.mov', { probe: probe(null, null) })],
  ]);

  it('only confirmed links of this shot, file online, range exact', () => {
    const links = [
      link(1, 1, 1, 'confirmed'),
      link(2, 1, 1, 'candidate'),
      link(3, 1, 2, 'confirmed'), // offline
      link(4, 1, 3, 'confirmed'), // probe without start/duration → inexact
      link(5, 2, 1, 'confirmed'), // other shot
      link(6, 1, 1, 'confirmed', null, { ...RANGE, time_base_den: 90000 }), // wrong time base
    ];
    expect(usableChoices(id(1), links, assets).map((l) => l.id)).toEqual([id(301)]);
    expect(isRangeExact(link(4, 1, 3, 'confirmed'), assets.get(id(103)))).toBe(false);
    expect(isRangeExact(link(1, 1, 1, 'confirmed'), undefined)).toBe(false);
  });
});

describe('missing list', () => {
  const cov = (n: number, status: CoverageResult['status'], required: CoverageResult['required_status'], missing: CoverageResult['missing_reason']): CoverageResult => ({
    shot_id: id(n),
    status,
    required_status: required,
    facts: { take_count: 0, link_count: 0, confirmed_link_count: 0, offline_link_count: 0 },
    flags: [],
    missing_reason: missing,
  });

  it('four reasons for required shots; optional and waived listed apart, never counted', () => {
    const r = missingReport(
      [cov(5, 'attempted', 'required', 'file_offline'), cov(1, 'usable', 'required', null), cov(2, 'planned', 'required', 'no_take'), cov(3, 'planned', 'optional', null), cov(4, 'waived', 'waived', null)],
      refs,
    );
    expect(r.total).toBe(2);
    expect(r.byReason.no_take.map((x) => x.ref.label)).toEqual(['1-002']);
    expect(r.byReason.file_offline.map((x) => x.ref.label)).toEqual(['2-002']);
    expect(r.byReason.no_link).toEqual([]);
    expect(r.notCounted.map((x) => x.ref.label)).toEqual(['1-003', '2-001']);
  });

  it('coverage CSV: one row per shot with Chinese labels', () => {
    const csv = coverageCsv([cov(2, 'planned', 'required', 'no_take'), cov(4, 'waived', 'waived', null)], refs);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['场', '镜', '内容', '必拍状态', '覆盖状态', '漏拍原因', '条次数', '关联数', '已确认', '离线关联', '提示']);
    expect(rows[1]!.slice(0, 6)).toEqual(['1', '002', '动作 002', '必拍', '未拍', '无场记']);
    expect(rows[2]!.slice(3, 6)).toEqual(['免拍', '免拍', '']);
  });
});

describe('set log + media CSV (FR-10)', () => {
  const takes: Take[] = [
    {
      id: id(501),
      setup_id: null,
      take_no: 2,
      camera_label: 'A',
      rating: 'good',
      clip_hint: 'A001C003',
      notes: '=SUM(A1) 注意',
      unresolved_labels: [],
      logged_at: '2026-09-26T01:00:00.000Z',
      shot_ids: [id(1), id(2)],
      revision: 0,
    },
    {
      id: id(502),
      setup_id: null,
      take_no: 1,
      camera_label: null,
      rating: 'reject',
      clip_hint: null,
      notes: '',
      unresolved_labels: ['3A-2'],
      logged_at: '2026-09-26T01:05:00.000Z',
      shot_ids: [],
      revision: 0,
    },
  ];
  const big = { stream_index: 1, in_pts: -1024, out_pts: 9_007_199_254_740_991, time_base_num: 1001, time_base_den: 30000 };
  const links = [link(1, 1, 1, 'confirmed', id(501), big), link(2, 2, 1, 'candidate', null), link(3, 5, 1, 'rejected', null)];
  const assets = new Map([[id(101), asset(1, 'day1/A001C003.mov')]]);
  const csv = takeMediaCsv({ refs, takes, links, assets });
  const rows = parseCsv(csv);
  const header = rows[0]!;
  const col = (row: string[], key: string) => row[TAKE_MEDIA_COLUMNS.findIndex((c) => c.key === key)];

  it('starts with a BOM and ends with the five integer source_range columns', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(header.slice(-5)).toEqual(['stream_index', 'in_pts', 'out_pts', 'time_base_num', 'time_base_den']);
  });

  it('round-trips source_range exactly, negative and max-safe PTS included', () => {
    const r = rows.find((x) => col(x, 'file') === 'day1/A001C003.mov' && col(x, 'take') === '2')!;
    const cells = Object.fromEntries(header.map((h, i) => [h, r[i]]));
    expect(sourceRangeFromColumns(cells)).toEqual(big);
  });

  it('one row per take × shot (with or without media), rejected links left out, formulas neutralised', () => {
    const shotsCol = rows.slice(1).map((r) => `${col(r, 'scene')}-${col(r, 'shot')}:${col(r, 'take')}:${col(r, 'link_status')}`);
    expect(shotsCol).toEqual(['1-001:2:已确认', '1-002:2:', '1-002::候选', '-:1:']);
    const first = rows[1]!;
    expect(col(first, 'notes')).toBe("'=SUM(A1) 注意");
    expect(col(first, 'rating')).toBe('好');
    expect(col(rows[4]!, 'unresolved')).toBe('3A-2');
    expect(rows.some((r) => col(r, 'scene') === '2' && col(r, 'shot') === '002')).toBe(false);
  });

  it('export names are safe file names', () => {
    expect(exportName('雨/夜:旧书', '场记与素材', new Date(2026, 8, 6))).toBe('雨_夜_旧书-场记与素材-2026-09-06');
  });
});

describe('display helpers', () => {
  it('formats durations, sizes and frame rates', () => {
    expect(formatClipDuration(2.04)).toBe('0:02');
    expect(formatClipDuration(3725)).toBe('1:02:05');
    expect(formatClipDuration(null)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatRate('30000/1001')).toBe('29.97');
    expect(formatRate('25/1')).toBe('25');
    expect(formatRate(null)).toBe('');
  });
});

describe('INV-08 wording: nothing claims a backup or a safe card format', () => {
  const sources = import.meta.glob(['../src/views/set/**/*.{ts,tsx}', '../src/views/media/**/*.{ts,tsx}', '../src/lib/*-media.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('covers the set/media sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(8);
  });

  it.each(['备份', '已备份', '可以格式化', '格式化存储卡', 'backed up', 'safe to format'])('no "%s"', (word) => {
    for (const [file, text] of Object.entries(sources)) expect(text.includes(word), file).toBe(false);
    for (const v of Object.values(labels)) if (typeof v !== 'function') expect(JSON.stringify(v).includes(word)).toBe(false);
  });

  it('every coverage status and missing reason has a label and an icon-backed badge text', () => {
    expect(Object.keys(labels.COVERAGE_STATUS_LABEL).sort()).toEqual(['attempted', 'needs_pickup', 'planned', 'usable', 'waived']);
    expect(labels.MISSING_ORDER).toEqual(['no_take', 'no_link', 'no_confirmed_usable', 'file_offline']);
    expect(labels.NEEDS_PROXY_LABEL).toBe('需代理（v0.2）');
  });
});

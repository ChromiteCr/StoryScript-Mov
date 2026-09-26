import { CoverageResult } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { type CoverageInput, computeCoverage } from '../../src/coverage/compute.ts';
import { RANGE, T, asset, decision, link, shotOf, take, uid } from './fixtures.ts';

const S = uid(1);
const OTHER = uid(2);
const [K1, K2] = [uid(11), uid(12)];
const [L1, L2, L3] = [uid(21), uid(22), uid(23)];
const [A1, A2] = [uid(31), uid(32)];

type Row = {
  name: string;
  input: Partial<CoverageInput> & Pick<CoverageInput, 'shot'>;
  status: CoverageResult['status'];
  missing: CoverageResult['missing_reason'];
  flags?: CoverageResult['flags'];
};

const base = (parts: Row['input']): CoverageInput => ({ takes: [], links: [], assets: [], decisions: [], ...parts });

// SPEC §5.9 priority table, one row per rule plus the edge cases around it.
const rows: Row[] = [
  // 1. waived wins over everything
  {
    name: 'waived shot with a usable decision is still waived',
    input: {
      shot: shotOf(S, 'waived'),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1)],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'waived',
    missing: null,
  },
  { name: 'waived shot with nothing', input: { shot: shotOf(S, 'waived') }, status: 'waived', missing: null },

  // 2. needs_pickup decision
  {
    name: 'needs_pickup overrides confirmed online footage',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1)],
      decisions: [decision(S, 'needs_pickup', T(12))],
    },
    status: 'needs_pickup',
    missing: 'no_confirmed_usable',
  },
  {
    name: 'needs_pickup after usable: the latest decision wins',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1)],
      decisions: [decision(S, 'needs_pickup', T(13)), decision(S, 'usable', T(12), [L1])],
    },
    status: 'needs_pickup',
    missing: 'no_confirmed_usable',
  },
  {
    name: 'stale needs_pickup still applies but is flagged',
    input: { shot: shotOf(S), decisions: [decision(S, 'needs_pickup', T(12), [], 'h-old')] },
    status: 'needs_pickup',
    missing: 'no_take',
    flags: ['decision_stale'],
  },

  // 3. usable decision with a qualifying selected link
  {
    name: 'usable: selected link confirmed, range valid, file online',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1, 'online', true)],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'usable',
    missing: null,
  },
  {
    name: 'usable after needs_pickup (decisions given out of order)',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1)],
      decisions: [decision(S, 'usable', T(14), [L1]), decision(S, 'needs_pickup', T(12))],
    },
    status: 'usable',
    missing: null,
  },
  {
    name: 'usable with one offline and one online selected link',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1), link(L2, S, A2)],
      assets: [asset(A1, 'offline'), asset(A2)],
      decisions: [decision(S, 'usable', T(12), [L1, L2])],
    },
    status: 'usable',
    missing: null,
  },

  // usable decision that no longer qualifies → falls back
  {
    name: 'usable but every selected link is offline → attempted + previously_usable + source_offline',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1, 'offline')],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'attempted',
    missing: 'file_offline',
    flags: ['previously_usable', 'source_offline'],
  },
  {
    name: 'stale usable decision is not usable (content changed)',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1)],
      decisions: [decision(S, 'usable', T(12), [L1], 'h-old')],
    },
    status: 'attempted',
    missing: 'no_confirmed_usable',
    flags: ['decision_stale'],
  },
  {
    name: 'usable decision whose selected link is only a candidate',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1, 'candidate')],
      assets: [asset(A1)],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'attempted',
    missing: 'no_confirmed_usable',
    flags: ['previously_usable'],
  },
  {
    name: 'usable decision whose selected link was rejected later',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1, 'rejected')],
      assets: [asset(A1)],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'attempted',
    missing: 'no_link',
    flags: ['previously_usable'],
  },
  {
    name: 'usable decision selecting a link of another shot does not count',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, OTHER, A1), link(L2, S, A2, 'candidate')],
      assets: [asset(A1), asset(A2)],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'attempted',
    missing: 'no_confirmed_usable',
    flags: ['previously_usable'],
  },
  {
    name: 'usable decision on a range whose time base disagrees with the stream',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1, 'confirmed', { ...RANGE, time_base_den: 25 })],
      assets: [asset(A1, 'online', true)],
      decisions: [decision(S, 'usable', T(12), [L1])],
    },
    status: 'attempted',
    missing: 'no_confirmed_usable',
    flags: ['previously_usable'],
  },
  {
    name: 'clear revokes the previous decision',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1)],
      assets: [asset(A1)],
      decisions: [decision(S, 'usable', T(12), [L1]), decision(S, 'clear', T(13))],
    },
    status: 'attempted',
    missing: 'no_confirmed_usable',
  },
  {
    name: 'a newer decision after clear applies again',
    input: {
      shot: shotOf(S),
      decisions: [decision(S, 'usable', T(12)), decision(S, 'clear', T(13)), decision(S, 'needs_pickup', T(14))],
    },
    status: 'needs_pickup',
    missing: 'no_take',
  },
  {
    name: "another shot's decisions are ignored",
    input: { shot: shotOf(S), takes: [take(K1, [S])], decisions: [decision(OTHER, 'needs_pickup', T(12))] },
    status: 'attempted',
    missing: 'no_link',
  },

  // 4. attempted
  {
    name: 'take logged (TakeShotLink), no media yet',
    input: { shot: shotOf(S), takes: [take(K1, [S, OTHER])] },
    status: 'attempted',
    missing: 'no_link',
  },
  {
    name: 'confirmed link without a take log',
    input: { shot: shotOf(S), links: [link(L1, S, A1)], assets: [asset(A1)] },
    status: 'attempted',
    missing: 'no_take',
  },
  {
    name: 'good rating with confirmed online footage is still only attempted',
    input: { shot: shotOf(S), takes: [take(K1, [S], 'good')], links: [link(L1, S, A1)], assets: [asset(A1)] },
    status: 'attempted',
    missing: 'no_confirmed_usable',
  },
  {
    name: 'all confirmed links offline → file_offline',
    input: {
      shot: shotOf(S),
      takes: [take(K1, [S])],
      links: [link(L1, S, A1), link(L2, S, A2), link(L3, S, A1, 'candidate')],
      assets: [asset(A1, 'offline'), asset(A2, 'offline')],
    },
    status: 'attempted',
    missing: 'file_offline',
  },
  {
    name: 'only candidate links → no_confirmed_usable, still attempted via the take',
    input: { shot: shotOf(S), takes: [take(K1, [S])], links: [link(L1, S, A1, 'candidate')], assets: [asset(A1)] },
    status: 'attempted',
    missing: 'no_confirmed_usable',
  },

  // 5. planned
  { name: 'nothing at all', input: { shot: shotOf(S) }, status: 'planned', missing: 'no_take' },
  {
    name: 'candidate link only, no take',
    input: { shot: shotOf(S), links: [link(L1, S, A1, 'candidate')], assets: [asset(A1)] },
    status: 'planned',
    missing: 'no_take',
  },
  {
    name: "another shot's take does not count",
    input: { shot: shotOf(S), takes: [take(K1, [OTHER])] },
    status: 'planned',
    missing: 'no_take',
  },

  // optional shots are never "missing"
  { name: 'optional and never shot', input: { shot: shotOf(S, 'optional') }, status: 'planned', missing: null },
  {
    name: 'optional with offline footage',
    input: { shot: shotOf(S, 'optional'), takes: [take(K1, [S])], links: [link(L1, S, A1)], assets: [asset(A1, 'offline')] },
    status: 'attempted',
    missing: null,
  },
];

describe('computeCoverage — SPEC §5.9 table', () => {
  test.each(rows)('$name', ({ input, status, missing, flags }) => {
    const result = computeCoverage(base(input));
    expect(CoverageResult.parse(result)).toEqual(result);
    expect(result.status).toBe(status);
    expect(result.missing_reason).toBe(missing);
    expect(result.flags).toEqual(flags ?? []);
    expect(result.shot_id).toBe(input.shot.id);
    expect(result.required_status).toBe(input.shot.required_status);
  });

  test('facts count only this shot, ignore rejected links, and count offline files', () => {
    const r = computeCoverage(
      base({
        shot: shotOf(S),
        takes: [take(K1, [S]), take(K2, [OTHER])],
        links: [link(L1, S, A1), link(L2, S, A2, 'candidate'), link(L3, S, A1, 'rejected'), link(uid(24), OTHER, A1)],
        assets: [asset(A1, 'offline'), asset(A2)],
      }),
    );
    expect(r.facts).toEqual({ take_count: 1, link_count: 2, confirmed_link_count: 1, offline_link_count: 1 });
  });

  test('decision stale does not delete the decision: restoring the content hash restores usable', () => {
    const decisions = [decision(S, 'usable', T(12), [L1], 'h-v1')];
    const facts = { takes: [take(K1, [S])], links: [link(L1, S, A1)], assets: [asset(A1)], decisions };
    expect(computeCoverage({ ...facts, shot: { ...shotOf(S), content_hash: 'h-v2' } }).status).toBe('attempted');
    expect(computeCoverage({ ...facts, shot: { ...shotOf(S), content_hash: 'h-v1' } }).status).toBe('usable');
  });

  test('ties on `at` resolve by decision id, independent of array order', () => {
    const d1 = decision(S, 'usable', T(12), [L1]);
    const d2 = decision(S, 'needs_pickup', T(12));
    const facts = { shot: shotOf(S), takes: [take(K1, [S])], links: [link(L1, S, A1)], assets: [asset(A1)] };
    const x = computeCoverage({ ...facts, decisions: [d1, d2] });
    const y = computeCoverage({ ...facts, decisions: [d2, d1] });
    expect(x).toEqual(y);
  });
});

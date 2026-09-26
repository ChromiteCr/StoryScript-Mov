import { describe, expect, test } from 'vitest';
import { computeCoverage, computeCoverageAll, effectiveDecision } from '../../src/coverage/compute.ts';
import { parseCsv, toCsv } from '../../src/export/csv.ts';
import { T, asset, decision, link, shotOf, take, uid } from './fixtures.ts';

// AT-13: required / optional / cancelled shots mixed; takes without media;
// media not yet confirmed; a manual pickup; a cancellation.
const shots = {
  loggedNoMedia: shotOf(uid(1)), // take logged, nothing linked
  mediaUnconfirmed: shotOf(uid(2)), // candidate link only
  usable: shotOf(uid(3)), // confirmed online + usable decision
  optionalUnshot: shotOf(uid(4), 'optional'),
  cancelled: shotOf(uid(5), 'waived'),
  pickup: shotOf(uid(6)), // director asked for a pickup
  neverShot: shotOf(uid(7)),
  goodButUnreviewed: shotOf(uid(8)), // good rating, confirmed online, no decision
};
const [A1, A2, A3] = [uid(31), uid(32), uid(33)];
const takes = [
  take(uid(11), [shots.loggedNoMedia.id]),
  take(uid(12), [shots.mediaUnconfirmed.id, shots.usable.id]), // one take covers two shots
  take(uid(13), [shots.pickup.id], 'reject'),
  take(uid(14), [shots.goodButUnreviewed.id], 'good'),
  take(uid(15), [shots.cancelled.id]),
];
const links = [
  link(uid(21), shots.mediaUnconfirmed.id, A1, 'candidate'),
  link(uid(22), shots.usable.id, A1, 'confirmed'),
  link(uid(23), shots.pickup.id, A2, 'confirmed'),
  link(uid(24), shots.goodButUnreviewed.id, A3, 'confirmed'),
];
const assets = [asset(A1), asset(A2), asset(A3)];
const decisions = [
  decision(shots.usable.id, 'usable', T(15), [uid(22)], 'h-current', 'clean take, focus ok'),
  decision(shots.pickup.id, 'needs_pickup', T(16), [], 'h-current', 'boom in frame, pick up tomorrow'),
];
const facts = { takes, links, assets, decisions };
const list = Object.values(shots);

describe('AT-13 mixed coverage', () => {
  const results = computeCoverageAll(list, facts);
  const by = (s: { id: string }) => results.find((r) => r.shot_id === s.id)!;

  test('statuses and missing reasons', () => {
    expect([by(shots.loggedNoMedia).status, by(shots.loggedNoMedia).missing_reason]).toEqual(['attempted', 'no_link']);
    expect([by(shots.mediaUnconfirmed).status, by(shots.mediaUnconfirmed).missing_reason]).toEqual(['attempted', 'no_confirmed_usable']);
    expect([by(shots.usable).status, by(shots.usable).missing_reason]).toEqual(['usable', null]);
    expect([by(shots.optionalUnshot).status, by(shots.optionalUnshot).missing_reason]).toEqual(['planned', null]);
    expect([by(shots.cancelled).status, by(shots.cancelled).missing_reason]).toEqual(['waived', null]);
    expect([by(shots.pickup).status, by(shots.pickup).missing_reason]).toEqual(['needs_pickup', 'no_confirmed_usable']);
    expect([by(shots.neverShot).status, by(shots.neverShot).missing_reason]).toEqual(['planned', 'no_take']);
    expect([by(shots.goodButUnreviewed).status, by(shots.goodButUnreviewed).missing_reason]).toEqual([
      'attempted',
      'no_confirmed_usable',
    ]);
  });

  test('usable is never derived from a good rating', () => {
    expect(by(shots.goodButUnreviewed).status).not.toBe('usable');
  });

  test('the missing list holds required shots only; optional and cancelled shots are not missing', () => {
    const missing = results.filter((r) => r.missing_reason !== null).map((r) => r.shot_id);
    expect(missing).toEqual([
      shots.loggedNoMedia.id,
      shots.mediaUnconfirmed.id,
      shots.pickup.id,
      shots.neverShot.id,
      shots.goodButUnreviewed.id,
    ]);
    expect(missing).not.toContain(shots.optionalUnshot.id);
    expect(missing).not.toContain(shots.cancelled.id);
  });

  test('pickup and usable reasons stay auditable on the decision in force', () => {
    expect(effectiveDecision(decisions, shots.pickup.id)?.reason).toBe('boom in frame, pick up tomorrow');
    expect(effectiveDecision(decisions, shots.usable.id)?.reason).toBe('clean take, focus ok');
  });

  test('page and export agree: batch = per-shot, and the CSV round-trips the same values', () => {
    expect(results).toEqual(list.map((shot) => computeCoverage({ ...facts, shot })));
    const csv = toCsv(
      results.map((r) => ({ shot: r.shot_id, status: r.status, missing: r.missing_reason, takes: r.facts.take_count })),
      [
        { key: 'shot', header: '镜头' },
        { key: 'status', header: '覆盖状态' },
        { key: 'missing', header: '缺失原因' },
        { key: 'takes', header: '条次数' },
      ],
    );
    const [header, ...rows] = parseCsv(csv);
    expect(header).toEqual(['镜头', '覆盖状态', '缺失原因', '条次数']);
    expect(rows).toEqual(results.map((r) => [r.shot_id, r.status, r.missing_reason ?? '', String(r.facts.take_count)]));
  });
});

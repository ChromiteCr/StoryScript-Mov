import { describe, expect, test } from 'vitest';
import { reorder, schedule } from '../../src/schedule/schedule.ts';
import { validate } from '../../src/schedule/validate.ts';
import { Z, before, input, locked, notAfter, resource, setup, shot, uid, win } from './fixtures.ts';

const P = uid(1);
const Q = uid(2);
const L1 = uid(11);
const L2 = uid(12);
const [a, b, c, d] = [101, 102, 103, 104].map(uid) as [string, string, string, string];
const [X, Y, W, V] = [201, 202, 203, 204].map(uid) as [string, string, string, string];

describe('AT-08 feasible data where the greedy heuristic fails → partial with reasons (never proven_infeasible)', () => {
  test('tight-window-first ordering pushes the cursor past the only room for a long setup', () => {
    // X needs performer P 14:00–15:00; Y is a 5 h setup. Valid plan: Y 09–14, X 14–15.
    // Greedy ranks X first (its window ends earlier), places it at 14:00, then Y has no 5 h left.
    const data = input({
      crew_window: win('09:00', '18:00'),
      resources: [resource(P, 'performer', 'P', [win('14:00', '15:00')]), resource(L1, 'location', 'L1', [win('09:00', '18:00')])],
      shots: [shot(a, [P]), shot(b)],
      setups: [
        setup(X, 'X', { location: L1, shots: [a], perShot: 60 }),
        setup(Y, 'Y', { location: L1, shots: [b], setup: 60, perShot: 180, reset: 60 }),
      ],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('partial');
    expect(r.contradictions).toEqual([]);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0]!.setup_id).toBe(Y);
    expect(r.unplaced[0]!.reason).toMatch(/^ORDER: /);
    expect(r.violations.map((v) => v.code)).toEqual(['UNPLACED_REQUIRED']);
    // everything that was placed still passes validation
    expect(validate(data, r.blocks).filter((v) => v.code !== 'UNPLACED_REQUIRED')).toEqual([]);

    // proof that a plan exists: the other order is feasible
    const fixed = reorder(data, [Y, X]);
    expect(fixed.outcome).toBe('feasible');
    expect(validate(data, fixed.blocks)).toEqual([]);
  });

  test('same-location adjacency blocks a later tight window', () => {
    // Group L1 = {W (deadline 11:00, 1 h), V (4 h, open)}; group L2 = {X with Q only 12:00–14:00}.
    // Greedy keeps L1 together: W 09–10, V 10–14 → X cannot get Q. Valid: W, X 12–14, V 14–18.
    const data = input({
      crew_window: win('09:00', '18:00'),
      resources: [
        resource(Q, 'performer', 'Q', [win('12:00', '14:00')]),
        resource(L1, 'location', 'L1', [win('09:00', '18:00')]),
        resource(L2, 'location', 'L2', [win('09:00', '18:00')]),
      ],
      shots: [shot(a), shot(b), shot(c, [Q])],
      setups: [
        setup(W, 'W', { location: L1, shots: [a], perShot: 60 }),
        setup(V, 'V', { location: L1, shots: [b], perShot: 240 }),
        setup(X, 'X', { location: L2, shots: [c], perShot: 120 }),
      ],
      constraints: [notAfter(W, Z('11:00'))],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('partial');
    expect(r.contradictions).toEqual([]);
    expect(r.unplaced.map((u) => u.setup_id)).toEqual([X]);
    expect(r.unplaced[0]!.reason).toMatch(/^(ORDER|OCCUPIED): /);
    expect(reorder(data, [W, X, V]).outcome).toBe('feasible');
  });

  test('an optional setup that can never fit is unplaced, not proof of infeasibility', () => {
    const data = input({
      resources: [resource(P, 'performer', 'P', [])],
      shots: [shot(a, [P], 'optional'), shot(b)],
      setups: [setup(X, 'X', { shots: [a] }), setup(Y, 'Y', { shots: [b] })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('partial');
    expect(r.contradictions).toEqual([]);
    expect(r.unplaced).toEqual([{ setup_id: X, reason: expect.stringMatching(/^NO_SLOT: /) }]);
    expect(r.violations).toEqual([]); // nothing required is missing
  });
});

describe('AT-08 explicit contradictions → proven_infeasible with evidence', () => {
  test('NO_WINDOW: a confirmed required performer has no window that day', () => {
    const data = input({
      resources: [resource(P, 'performer', 'P', [win('08:00', '20:00', '2026-10-06')])],
      shots: [shot(a, [P]), shot(b, [P])],
      setups: [setup(X, 'X', { shots: [a] }), setup(Y, 'Y', { shots: [b] })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('proven_infeasible');
    expect(r.blocks).toEqual([]);
    expect(r.contradictions).toEqual([
      { code: 'NO_WINDOW', message: expect.stringContaining('"P" is confirmed'), setup_ids: [X, Y], resource_ids: [P] },
    ]);
  });

  test('BLOCK_EXCEEDS_WINDOWS: 3 shots × 60 min but the performer is only free for 2 h', () => {
    const data = input({
      resources: [resource(P, 'performer', 'P', [win('09:00', '11:00'), win('13:00', '14:00')])],
      shots: [shot(a, [P]), shot(b, [P]), shot(c, [P])],
      setups: [setup(X, 'X', { shots: [a, b, c], perShot: 60 })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('proven_infeasible');
    expect(r.contradictions).toHaveLength(1);
    expect(r.contradictions[0]).toMatchObject({ code: 'BLOCK_EXCEEDS_WINDOWS', setup_ids: [X], resource_ids: [P] });
    expect(r.contradictions[0]!.message).toContain('needs 180 min');
    expect(r.contradictions[0]!.message).toContain('is 120 min');
  });

  test('BLOCK_EXCEEDS_WINDOWS honours not_after', () => {
    const data = input({
      resources: [],
      shots: [shot(a)],
      setups: [setup(X, 'X', { shots: [a], perShot: 120 })],
      constraints: [notAfter(X, Z('09:00'))],
    });
    expect(schedule(data).contradictions.map((x) => x.code)).toEqual(['BLOCK_EXCEEDS_WINDOWS']);
  });

  test('performers only occupy the shoot block, so a long setup/reset is not a false contradiction', () => {
    const data = input({
      resources: [resource(P, 'performer', 'P', [win('10:00', '11:00')])],
      shots: [shot(a, [P])],
      setups: [setup(X, 'X', { shots: [a], setup: 60, perShot: 60, reset: 60 })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('feasible');
    expect(r.blocks.map((blk) => [blk.kind, blk.start_utc])).toEqual([
      ['setup', Z('09:00')],
      ['shoot', Z('10:00')],
      ['reset', Z('11:00')],
    ]);
  });

  test('PRECEDENCE_CYCLE among required setups', () => {
    const data = input({
      resources: [],
      shots: [shot(a), shot(b), shot(c), shot(d)],
      setups: [setup(X, 'X', { shots: [a] }), setup(Y, 'Y', { shots: [b] }), setup(W, 'W', { shots: [c] }), setup(V, 'V', { shots: [d] })],
      constraints: [before(X, Y), before(Y, W), before(W, X), before(X, V)],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('proven_infeasible');
    expect(r.contradictions).toEqual([
      { code: 'PRECEDENCE_CYCLE', message: expect.stringContaining('cycle'), setup_ids: [X, Y, W].sort(), resource_ids: [] },
    ]);
  });

  test('unconfirmed constraints are drafts and prove nothing', () => {
    const data = input({
      resources: [],
      shots: [shot(a), shot(b)],
      setups: [setup(X, 'X', { shots: [a] }), setup(Y, 'Y', { shots: [b] })],
      constraints: [before(X, Y), before(Y, X, false)],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('feasible');
    expect(r.order).toEqual([X, Y]);
  });

  test('LOCKED_CONFLICT: two locked blocks overlap', () => {
    const data = input({
      resources: [],
      shots: [shot(a), shot(b)],
      setups: [setup(X, 'X', { shots: [a], perShot: 60 }), setup(Y, 'Y', { shots: [b], perShot: 60 })],
      constraints: [locked(X, Z('10:00'), Z('11:00')), locked(Y, Z('10:30'), Z('11:30'))],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('proven_infeasible');
    expect(r.contradictions).toEqual([
      { code: 'LOCKED_CONFLICT', message: expect.stringContaining('overlap'), setup_ids: [X, Y], resource_ids: [] },
    ]);
  });

  test('LOCKED_CONFLICT: locked block falls outside a performer window', () => {
    const data = input({
      resources: [resource(P, 'performer', 'P', [win('13:00', '18:00')])],
      shots: [shot(a, [P])],
      setups: [setup(X, 'X', { shots: [a], perShot: 60 })],
      constraints: [locked(X, Z('12:30'), Z('13:30'))],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('proven_infeasible');
    expect(r.contradictions).toEqual([
      { code: 'LOCKED_CONFLICT', message: expect.stringContaining('outside the windows of "P"'), setup_ids: [X], resource_ids: [P] },
    ]);
  });

  test('LOCKED_CONFLICT: locked span shorter than the setup', () => {
    const data = input({
      resources: [],
      shots: [shot(a)],
      setups: [setup(X, 'X', { shots: [a], setup: 30, perShot: 60 })],
      constraints: [locked(X, Z('10:00'), Z('11:00'))],
    });
    expect(schedule(data).contradictions.map((x) => x.code)).toEqual(['LOCKED_CONFLICT']);
  });
});

describe('missing data → needs_input (not a contradiction, not partial)', () => {
  test('unconfirmed performer without a window', () => {
    const data = input({
      resources: [resource(P, 'performer', 'P', [], false)],
      shots: [shot(a, [P])],
      setups: [setup(X, 'X', { shots: [a] })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('needs_input');
    expect(r.contradictions).toEqual([]);
    expect(r.violations).toEqual([expect.objectContaining({ code: 'MISSING_INPUT', resource_id: P, setup_id: X })]);
  });

  test('setup without working time, unknown resource, unknown shot', () => {
    const data = input({
      resources: [],
      shots: [shot(a), shot(b, [Q])],
      setups: [setup(X, 'X', { shots: [a], perShot: 0 }), setup(Y, 'Y', { shots: [b, c] })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('needs_input');
    expect(r.violations.map((v) => v.message)).toEqual([
      expect.stringContaining('no per-shot duration'),
      expect.stringContaining(`unknown shot ${c}`),
      expect.stringContaining(`unknown resource ${Q}`),
    ]);
  });

  test('a waived-only setup is not planned at all', () => {
    const data = input({
      resources: [],
      shots: [shot(a, [], 'waived'), shot(b)],
      setups: [setup(X, 'X', { shots: [a], perShot: 0 }), setup(Y, 'Y', { shots: [b] })],
    });
    const r = schedule(data);
    expect(r.outcome).toBe('feasible');
    expect(r.order).toEqual([Y]);
    expect(r.blocks.every((blk) => blk.setup_id === Y)).toBe(true);
  });
});

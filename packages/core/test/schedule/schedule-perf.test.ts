import { describe, expect, test } from 'vitest';
import { schedule } from '../../src/schedule/schedule.ts';
import { validate } from '../../src/schedule/validate.ts';
import type { ScheduleInput } from '../../src/schedule/types.ts';
import { Z, before, input, locked, notBefore, resource, setup, shot, uid, win } from './fixtures.ts';
import { budget } from '../perf-budget.ts';

/** A realistic full day: 10 setups, 30 shots, 4 performers, 3 locations, 2 pieces of equipment. */
function day(): ScheduleInput {
  const performers = [1, 2, 3, 4].map(uid);
  const locations = [11, 12, 13].map(uid);
  const equipment = [21, 22].map(uid);
  const perfWindows = [win('06:00', '18:00'), win('08:00', '20:00'), win('10:00', '22:00'), win('06:00', '22:00')];
  // each setup's shots feature the performer who works at its location (k mod 3); every 9th shot also needs the all-day performer
  const shots = Array.from({ length: 30 }, (_, i) =>
    shot(uid(100 + i), [performers[Math.floor(i / 3) % 3]!, ...(i % 9 === 0 ? [performers[3]!] : [])], i % 7 === 6 ? 'optional' : 'required'),
  );
  const setups = Array.from({ length: 10 }, (_, k) =>
    setup(uid(200 + k), `${k + 1} setup`, {
      location: locations[k % 3]!,
      equipment: k % 4 === 0 ? [equipment[k % 2]!] : [],
      shots: shots.slice(k * 3, k * 3 + 3).map((s) => s.id),
      setup: 20 + (k % 3) * 10,
      perShot: 12,
      reset: 10,
    }),
  );
  return input({
    crew_window: win('06:00', '22:00'),
    resources: [
      ...performers.map((id, i) => resource(id, 'performer', `P${i}`, [perfWindows[i]!])),
      ...locations.map((id, i) => resource(id, 'location', `L${i}`, [win('06:00', '22:00')])),
      ...equipment.map((id, i) => resource(id, 'equipment', `E${i}`, [win('06:00', '22:00')])),
    ],
    shots,
    setups,
    constraints: [before(uid(200), uid(203)), notBefore(uid(207), Z('10:00')), locked(uid(209), Z('16:00'), Z('17:30'))],
  });
}

describe('schedule performance (30 shots / 10 setups)', () => {
  test('plans and validates a full day well under interactive latency', () => {
    const data = day();
    const r = schedule(data);
    expect(r.outcome).toBe('feasible');
    expect(validate(data, r.blocks)).toEqual([]);
    expect(r.blocks.filter((b) => b.kind === 'shoot').flatMap((b) => b.shot_ids)).toHaveLength(30);

    for (let k = 0; k < 5; k++) schedule(data); // warm-up
    const samples: number[] = [];
    for (let k = 0; k < 50; k++) {
      const t0 = performance.now();
      schedule(data);
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    const median = samples[25]!;
    const p95 = samples[47]!;
    console.info(`[schedule perf] 30 shots / 10 setups: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`);
    expect(median).toBeLessThan(budget(50));
  });
});

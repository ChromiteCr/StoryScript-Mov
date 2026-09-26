import fc from 'fast-check';
import type { BoardCamera, FrameFormat, ShotFields, ShotSize, Technique } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import {
  framingBand,
  hFov,
  horizonLine,
  poseTopY,
  project,
  shotFields,
  solveBand,
  solveCamera,
  STANDARD_LOOK,
  unprojectAtDepth,
  unprojectToPlane,
  vFov,
  visibleHeight,
} from '../../src/index.ts';
import { subjectSpan, visibleRangeAt } from './helpers.ts';

const SIZES: ShotSize[] = ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'FS'];
const ASPECT: FrameFormat = '2.39';
const fields = (p: Partial<ShotFields>) => shotFields({ subjects: [], ...p });

describe('field of view', () => {
  test('vFOV = 2·atan(sensor_h / 2f), hFOV = 2·atan(18 / f)', () => {
    expect(vFov(40, '2.39')).toBeCloseTo(2 * Math.atan(36 / 2.39 / 80), 12);
    expect(hFov(24)).toBeCloseTo(2 * Math.atan(18 / 24), 12);
    expect(vFov(50, '1.78')).toBeCloseTo(2 * Math.atan(36 / 1.78 / 100), 12);
  });
});

describe('shot size → visible height on the subject axis (eye level)', () => {
  const V: Record<string, number> = { ECU: 0.25, CU: 0.45, MCU: 0.7, MS: 1.0, MLS: 1.4, FS: 2.0 };
  for (const size of SIZES) {
    for (const focal of [24, 40, 85]) {
      test(`${size} @ ${focal}mm: visible range error ≤ 3%`, () => {
        const sol = solveCamera(fields({ shot_size: size, focal_mm: focal }), { aspect: ASPECT });
        const vis = visibleRangeAt(sol.camera, ASPECT, sol.subject.z);
        const measured = vis.top - vis.bottom;
        expect(Math.abs(measured - (V[size] as number)) / (V[size] as number)).toBeLessThanOrEqual(0.03);
        // the band lands where the grammar says: head room / crop at the top edge
        const band = framingBand(size, 1.7, poseTopY('stand') * 1.7);
        expect(Math.abs(vis.top - band.top)).toBeLessThan(0.03 * (V[size] as number));
      });
    }
  }

  test('FS keeps head and feet in frame with room; MS cuts near the waist; ECU may crop the head top', () => {
    const fs = solveCamera(fields({ shot_size: 'FS' }), { aspect: ASPECT });
    const s = subjectSpan(fs.camera, ASPECT, 0, fs.subject.z, 1.7);
    expect(s.head.y).toBeGreaterThan(0.02);
    expect(s.foot.y).toBeLessThan(0.98);
    const ms = solveCamera(fields({ shot_size: 'MS' }), { aspect: ASPECT });
    const bottom = visibleRangeAt(ms.camera, ASPECT, ms.subject.z).bottom;
    expect(bottom).toBeGreaterThan(0.7);
    expect(bottom).toBeLessThan(0.95);
    const ecu = solveCamera(fields({ shot_size: 'ECU' }), { aspect: ASPECT });
    expect(visibleRangeAt(ecu.camera, ASPECT, ecu.subject.z).top).toBeLessThan(1.7);
  });

  test('distance at the band centre equals D = V·f/sensor_h', () => {
    const f = 50;
    const band = framingBand('MS', 1.7, poseTopY('stand') * 1.7);
    const t = 36 / 2.39 / (2 * f);
    const r = solveBand((band.top + band.bottom) / 2, band.bottom, band.top, t);
    expect(r?.theta).toBeCloseTo(0, 12);
    expect(r?.d).toBeCloseTo((1.0 * f) / (36 / 2.39), 9);
  });

  test('WS ≈ 1/3 frame height, EWS < 10 %', () => {
    const ws = solveCamera(fields({ shot_size: 'WS' }), { aspect: ASPECT });
    expect(subjectSpan(ws.camera, ASPECT, 0, ws.subject.z, 1.7).h).toBeCloseTo(1 / 3, 1);
    const ews = solveCamera(fields({ shot_size: 'EWS' }), { aspect: ASPECT });
    expect(subjectSpan(ews.camera, ASPECT, 0, ews.subject.z, 1.7).h).toBeLessThan(0.1);
    expect(visibleHeight('EWS')).toBeGreaterThan(17);
  });

  test('taller subjects scale V', () => {
    const a = solveCamera(fields({ shot_size: 'MCU' }), { aspect: ASPECT, subject_height_m: 1.87 });
    const vis = visibleRangeAt(a.camera, ASPECT, a.subject.z);
    expect((vis.top - vis.bottom) / (0.7 * 1.1)).toBeCloseTo(1, 2);
  });
});

describe('focal slider keeps the shot size', () => {
  // "Subject projected height" = the subject's in-frame span (head top down to the
  // frame bottom or the feet, whichever is higher) and, independently, the head size.
  const inFrameSpan = (cam: BoardCamera, z: number) => {
    const top = poseTopY('stand') * 1.7;
    const head = project(cam, ASPECT, [0, top, z]).y;
    const chin = project(cam, ASPECT, [0, top - 0.227, z]).y;
    const feet = Math.min(1, project(cam, ASPECT, [0, 0, z]).y);
    return { span: feet - head, head: chin - head };
  };
  for (const size of ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'FS'] as const) {
    test(`${size}: in-frame subject height varies ≤ 3% from 24 to 85 mm; camera dollies back`, () => {
      const base = fields({ shot_size: size });
      const spans: number[] = [];
      const heads: number[] = [];
      const ds: number[] = [];
      for (const f of [24, 35, 50, 85]) {
        const sol = solveCamera(base, { aspect: ASPECT, focal_mm: f });
        expect(sol.focal_source).toBe('override');
        const m = inFrameSpan(sol.camera, sol.subject.z);
        spans.push(m.span);
        heads.push(m.head);
        ds.push(sol.distance_m);
      }
      const ref = spans[0] as number;
      for (const v of spans) expect(Math.abs(v - ref) / ref).toBeLessThanOrEqual(0.03);
      // the head alone may grow a little at 24 mm (closer, tilted camera): real wide-angle perspective
      const h0 = heads[heads.length - 1] as number;
      for (const v of heads) expect(Math.abs(v - h0) / h0).toBeLessThanOrEqual(0.1);
      for (let i = 1; i < ds.length; i++) expect(ds[i] as number).toBeGreaterThan(ds[i - 1] as number);
      // background perspective changes: an object 3 m behind the subject shrinks less at 24 mm
      const bg = [24, 85].map((f) => {
        const sol = solveCamera(base, { aspect: ASPECT, focal_mm: f });
        return project(sol.camera, ASPECT, [1, sol.camera.y, sol.subject.z + 3]).x - 0.5;
      });
      expect((bg[1] as number) / (bg[0] as number)).toBeGreaterThan(1.2);
    });
  }
});

describe('angles', () => {
  const horizonY = (cam: BoardCamera) => {
    const h = horizonLine(cam, ASPECT);
    return h ? (h[0][1] + h[1][1]) / 2 : null;
  };

  test('low angle: camera 0.4–0.8 m, tilts up, horizon in the lower half', () => {
    for (const size of ['MS', 'MLS', 'FS', 'WS'] as const) {
      const sol = solveCamera(fields({ shot_size: size, angle: 'low' }), { aspect: ASPECT });
      expect(sol.camera.y).toBeGreaterThanOrEqual(0.4);
      expect(sol.camera.y).toBeLessThanOrEqual(0.8);
      expect(sol.camera.pitch_deg).toBeGreaterThan(0);
      expect(horizonY(sol.camera)).toBeGreaterThan(0.5);
    }
  });

  test('high angle: camera 2.5–4 m, tilts down, horizon in the upper half', () => {
    for (const size of ['MS', 'MLS', 'FS', 'WS', 'EWS'] as const) {
      const sol = solveCamera(fields({ shot_size: size, angle: 'high' }), { aspect: ASPECT });
      expect(sol.camera.y).toBeGreaterThanOrEqual(2.5);
      expect(sol.camera.y).toBeLessThanOrEqual(4);
      expect(sol.camera.pitch_deg).toBeLessThan(0);
      expect(horizonY(sol.camera)).toBeLessThan(0.5);
    }
  });

  test('close high/low angles stay solvable (pitch capped, camera height eased)', () => {
    const cu = solveCamera(fields({ shot_size: 'CU', angle: 'high' }), { aspect: ASPECT });
    expect(Math.abs(cu.camera.pitch_deg)).toBeLessThanOrEqual(40.01);
    const vis = visibleRangeAt(cu.camera, ASPECT, cu.subject.z);
    expect(Math.abs(vis.top - vis.bottom - 0.45) / 0.45).toBeLessThanOrEqual(0.03);
    const lo = solveCamera(fields({ shot_size: 'ECU', angle: 'low' }), { aspect: ASPECT });
    expect(lo.camera.pitch_deg).toBeGreaterThan(0);
    expect(lo.camera.pitch_deg).toBeLessThanOrEqual(35.01);
  });

  test('eye level sits at the subject eye height; dutch adds 15° roll; overhead looks straight down', () => {
    const eye = solveCamera(fields({ shot_size: 'MS' }), { aspect: ASPECT, subject_height_m: 1.8 });
    expect(eye.camera.y).toBeCloseTo(0.93 * 1.8, 3);
    const dutch = solveCamera(fields({ shot_size: 'MS', angle: 'dutch' }), { aspect: ASPECT });
    expect(dutch.camera.roll_deg).toBe(15);
    const top = solveCamera(fields({ shot_size: 'FS', angle: 'overhead' }), { aspect: ASPECT });
    expect(top.camera.pitch_deg).toBe(-90);
    expect(top.camera.y).toBeGreaterThan(1.7);
    expect(horizonLine(top.camera, ASPECT)).toBeNull();
  });

  test('set piece with the low/wide look: 24 mm, 0.6 m, tilt up 5–10°', () => {
    const sol = solveCamera(fields({ shot_size: 'EWS', set_piece: true }), { aspect: ASPECT, look: STANDARD_LOOK });
    expect(sol.camera.focal_mm).toBe(24);
    expect(sol.focal_source).toBe('set_piece');
    expect(sol.camera.y).toBeCloseTo(0.6, 6);
    expect(sol.camera.pitch_deg).toBeGreaterThanOrEqual(5);
    expect(sol.camera.pitch_deg).toBeLessThanOrEqual(10);
    expect(horizonY(sol.camera)).toBeGreaterThan(0.6);
  });
});

describe('focal priority: slider > shot.focal_mm > technique > set piece > lens class', () => {
  const tech = (focal: number | null): Technique => ({
    id: 't',
    version: 1,
    name: 't',
    intended_effect: '',
    shot_grammar: '',
    camera_defaults: {
      focal_mm: focal,
      camera_height_m: null,
      pitch_deg: null,
      shot_size_bias: [],
      angle_bias: [],
      lens_bias: [],
      movement_bias: [],
    },
    applicable_scenes: '',
    resource_cost_notes: '',
    low_budget_alternative: '',
    sources: [],
    limitations: '',
    builtin: true,
  });
  test('lens classes map to 24 / 40 / 85', () => {
    expect(solveCamera(fields({ lens: 'wide' }), { aspect: ASPECT }).camera.focal_mm).toBe(24);
    expect(solveCamera(fields({ lens: 'normal' }), { aspect: ASPECT }).camera.focal_mm).toBe(40);
    expect(solveCamera(fields({ lens: 'tele' }), { aspect: ASPECT }).camera.focal_mm).toBe(85);
  });
  test('overrides stack in order', () => {
    const f = fields({ lens: 'wide', focal_mm: 65, set_piece: true, shot_size: 'EWS' });
    expect(solveCamera(f, { aspect: ASPECT, technique: tech(100), look: STANDARD_LOOK, focal_mm: 32 }).camera.focal_mm).toBe(32);
    expect(solveCamera(f, { aspect: ASPECT, technique: tech(100), look: STANDARD_LOOK }).camera.focal_mm).toBe(65);
    expect(solveCamera({ ...f, focal_mm: null }, { aspect: ASPECT, technique: tech(100), look: STANDARD_LOOK }).camera.focal_mm).toBe(100);
    expect(solveCamera({ ...f, focal_mm: null, lens: 'tele' }, { aspect: ASPECT, technique: tech(null), look: STANDARD_LOOK }).camera.focal_mm).toBe(24);
    expect(solveCamera({ ...f, focal_mm: -5, lens: 'tele', set_piece: false }, { aspect: ASPECT }).camera.focal_mm).toBe(85);
  });
});

describe('projection', () => {
  test('a point on the optical axis lands at the frame centre; +x goes right, +y goes up', () => {
    const cam: BoardCamera = { x: 0, y: 1.5, z: 0, yaw_deg: 0, pitch_deg: 0, roll_deg: 0, focal_mm: 40, sensor_w_mm: 36 };
    const c = project(cam, ASPECT, [0, 1.5, 5]);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0.5, 12);
    expect(c.depth).toBeCloseTo(5, 12);
    expect(project(cam, ASPECT, [1, 1.5, 5]).x).toBeCloseTo(0.5 + (40 * 1) / 5 / 36, 12);
    expect(project(cam, ASPECT, [0, 2.5, 5]).y).toBeLessThan(0.5);
    expect(project(cam, ASPECT, [0, 1.5, -1]).visible).toBe(false);
  });

  test('project ∘ unproject round-trips < 1e-6 (any camera)', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.double({ min: -5, max: 5, noNaN: true }),
          y: fc.double({ min: 0.2, max: 6, noNaN: true }),
          z: fc.double({ min: -5, max: 5, noNaN: true }),
          yaw: fc.double({ min: -180, max: 180, noNaN: true }),
          pitch: fc.double({ min: -85, max: 85, noNaN: true }),
          roll: fc.double({ min: -30, max: 30, noNaN: true }),
          f: fc.double({ min: 12, max: 200, noNaN: true }),
          fx: fc.double({ min: 0, max: 1, noNaN: true }),
          fy: fc.double({ min: 0, max: 1, noNaN: true }),
          depth: fc.double({ min: 0.2, max: 200, noNaN: true }),
          aspect: fc.constantFrom<FrameFormat>('2.39', '2.20', '1.90', '1.78', '1.43'),
        }),
        (r) => {
          const cam: BoardCamera = { x: r.x, y: r.y, z: r.z, yaw_deg: r.yaw, pitch_deg: r.pitch, roll_deg: r.roll, focal_mm: r.f, sensor_w_mm: 36 };
          const w = unprojectAtDepth(cam, r.aspect, r.fx, r.fy, r.depth);
          const p = project(cam, r.aspect, w);
          expect(Math.abs(p.x - r.fx)).toBeLessThan(1e-6);
          expect(Math.abs(p.y - r.fy)).toBeLessThan(1e-6);
          expect(Math.abs(p.depth - r.depth)).toBeLessThan(1e-6);
          const g = unprojectToPlane(cam, r.aspect, r.fx, r.fy, 0);
          if (g) {
            const q = project(cam, r.aspect, g);
            expect(Math.abs(q.x - r.fx)).toBeLessThan(1e-6);
            expect(Math.abs(q.y - r.fy)).toBeLessThan(1e-6);
          }
        },
      ),
      { numRuns: 300, seed: 1234 },
    );
  });

  test('ground unprojection matches the frame point', () => {
    const cam: BoardCamera = { x: 0, y: 1.6, z: 0, yaw_deg: 0, pitch_deg: -10, roll_deg: 0, focal_mm: 35, sensor_w_mm: 36 };
    const g = unprojectToPlane(cam, ASPECT, 0.3, 0.8, 0);
    expect(g).not.toBeNull();
    expect(g?.[1]).toBe(0);
    expect(unprojectToPlane({ ...cam, pitch_deg: 20 }, ASPECT, 0.5, 0.2, 0)).toBeNull(); // above the horizon
  });
});

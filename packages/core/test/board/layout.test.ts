import { BoardSpec, type BoardTemplate, type ShotFields } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import {
  facingBucket,
  horizonLine,
  inferTemplate,
  isEnvProp,
  layoutBoard,
  project,
  relativeYaw,
  shotFields,
  STANDARD_LOOK,
  STANDARD_ROSTER,
  STANDARD_SHOTS,
  STANDARD_SIDES,
  standardBoard,
  standardSubject as subject,
  subjectFrameBoxes,
  subjectFramePoints,
  type LayoutContext,
} from '../../src/index.ts';

const ctx = (p: Partial<LayoutContext> = {}): LayoutContext => ({
  scene_sides: STANDARD_SIDES,
  roster: STANDARD_ROSTER,
  look: STANDARD_LOOK,
  technique: null,
  aspect: '2.39',
  seed: 11,
  ...p,
});
const byKey = (k: string) => {
  const s = STANDARD_SHOTS.find((x) => x.key.endsWith(k));
  if (!s) throw new Error(k);
  return s;
};

describe('template inference', () => {
  const t = (p: Partial<ShotFields>) => inferTemplate(shotFields(p));
  test.each<[string, Partial<ShotFields>, BoardTemplate]>([
    ['1 person ≤ MCU → single', { subjects: [subject('c1')], shot_size: 'CU' }, 'single'],
    ['2 people + pov → ots', { subjects: [subject('c1'), subject('c2')], pov_owner: 'c1', shot_size: 'MS' }, 'ots'],
    ['INSERT → insert', { subjects: [], shot_size: 'INSERT' }, 'insert'],
    ['l2r motion → lateral_move', { subjects: [subject('c1')], shot_size: 'FS', subject_motion: 'l2r' }, 'lateral_move'],
    ['r2l motion → lateral_move', { subjects: [subject('c1'), subject('c2')], shot_size: 'MS', subject_motion: 'r2l' }, 'lateral_move'],
    ['EWS set piece → scale', { subjects: [subject('c1')], shot_size: 'EWS', set_piece: true }, 'scale'],
    ['2 people → two_shot', { subjects: [subject('c1'), subject('c2')], shot_size: 'MS' }, 'two_shot'],
    ['WS → establishing', { subjects: [subject('c1'), subject('c2'), subject('c3')], shot_size: 'WS' }, 'establishing'],
    ['otherwise single', { subjects: [subject('c1')], shot_size: 'MS' }, 'single'],
    ['single ≤MCU wins over motion', { subjects: [subject('c1')], shot_size: 'MCU', subject_motion: 'l2r' }, 'single'],
  ])('%s', (_n, p, want) => expect(t(p)).toBe(want));

  test('the 12 standard shots cover all 7 templates', () => {
    const got = new Set(STANDARD_SHOTS.map((s) => s.fields.template ?? inferTemplate(s.fields)));
    expect([...got].sort()).toEqual(['establishing', 'insert', 'lateral_move', 'ots', 'scale', 'single', 'two_shot']);
  });
});

describe('every standard shot', () => {
  for (const shot of STANDARD_SHOTS) {
    test(`${shot.key}: parses as BoardSpec, deterministic, people accounted for`, () => {
      const a = standardBoard(shot, 3);
      const b = standardBoard(shot, 3);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(BoardSpec.safeParse(JSON.parse(JSON.stringify(a))).success).toBe(true);
      expect(a.scene.subjects).toHaveLength(shot.fields.subjects.length);
      expect(a.frame.guides).toEqual(['1.43']);
      expect(a.overlay.camera_move).toBe(shot.fields.movement);
      const ids = a.scene.props.map((p) => p.id).concat(a.scene.subjects.map((s) => s.id));
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
});

describe('staging rules', () => {
  test('screen L/C/R → frame x 1/3, 1/2, 2/3; depth fg/mg/bg → distance ×0.6/1/2', () => {
    const f = shotFields({
      shot_size: 'WS',
      template: 'establishing',
      subjects: [
        subject('c1', { screen: 'L', depth: 'fg' }),
        subject('c2', { screen: 'C', depth: 'mg' }),
        subject('c3', { screen: 'R', depth: 'bg' }),
      ],
    });
    const spec = layoutBoard(f, ctx({ roster: STANDARD_ROSTER.map((r) => ({ ...r, height_m: 1.7 })) }));
    const pts = subjectFramePoints(spec);
    const [a, b, c] = spec.scene.subjects;
    // x is solved at 55 % of the subject height
    const at = (id: string) => {
      const p = pts.get(id);
      return p?.foot && p.head ? p.foot[0] + (p.head[0] - p.foot[0]) * 0.55 : Number.NaN;
    };
    expect(at('s0')).toBeCloseTo(1 / 3, 2);
    expect(at('s1')).toBeCloseTo(1 / 2, 2);
    expect(at('s2')).toBeCloseTo(2 / 3, 2);
    expect((a?.z ?? 0) / (b?.z ?? 1)).toBeCloseTo(0.6, 3);
    expect((c?.z ?? 0) / (b?.z ?? 1)).toBeCloseTo(2.0, 3);
  });

  test('facing enum → yaw relative to the camera line', () => {
    const facings = ['camera', 'away', 'screen_right', 'screen_left', '3q_right', '3q_left'] as const;
    const want = [
      ['front', false],
      ['back', false],
      ['side', false],
      ['side', true],
      ['3q', false],
      ['3q', true],
    ] as const;
    facings.forEach((facing, i) => {
      const spec = layoutBoard(shotFields({ shot_size: 'MS', subjects: [subject('c1', { facing, screen: 'L' })] }), ctx());
      const s = spec.scene.subjects[0]!;
      const rel = relativeYaw(s, spec.camera);
      const b = facingBucket(rel);
      expect([b.view, b.mirror]).toEqual(want[i]);
    });
  });
});

describe('templates', () => {
  test('ots: foreground (pov owner) sits ~0.55× the target distance, back to camera, cut by the frame on its scene side', () => {
    for (const [key, fgId, side] of [
      ['ots-a', 's0', 'left'],
      ['ots-b', 's1', 'right'],
    ] as const) {
      const spec = standardBoard(byKey(key));
      const fg = spec.scene.subjects.find((s) => s.id === fgId)!;
      const tg = spec.scene.subjects.find((s) => s.id !== fgId)!;
      expect(fg.z / tg.z).toBeCloseTo(0.55, 2);
      expect(Math.abs(fg.x)).toBeGreaterThan(0.2);
      expect(Math.abs(fg.x)).toBeLessThan(0.75);
      expect(facingBucket(relativeYaw(fg, spec.camera)).view).toBe('back');
      const box = subjectFrameBoxes(spec).get(fgId)!;
      const width = box.x1 - box.x0;
      const cut = side === 'left' ? -box.x0 : box.x1 - box.W;
      expect(cut / width).toBeGreaterThan(0.15);
      expect(cut / width).toBeLessThan(0.5);
      // target on the opposite third, three-quarter to camera
      const tp = subjectFramePoints(spec).get(tg.id)!;
      expect(tp.foot![0]).toBeCloseTo(side === 'left' ? 2 / 3 : 1 / 3, 1);
      expect(facingBucket(relativeYaw(tg, spec.camera)).view).toBe('3q');
      // eyeline from the foreground to the target
      const eye = spec.overlay.arrows.find((a) => a.kind === 'eyeline');
      expect(eye?.subject_id).toBe(fgId);
    }
  });

  test('ots respects scene_sides when no pov side is given', () => {
    const f = shotFields({ shot_size: 'MCU', subjects: [subject('c1'), subject('c2')], pov_owner: 'c2' });
    const spec = layoutBoard(f, ctx({ scene_sides: { left: 'c2', right: 'c1' } }));
    const fg = spec.scene.subjects[1]!;
    expect(fg.x).toBeLessThan(0);
    expect(subjectFrameBoxes(spec).get('s1')!.x0).toBeLessThan(0);
  });

  test('scale: EWS, 24 mm low camera, subject < 10 % frame height, giant masses, low horizon', () => {
    const spec = standardBoard(byKey('ews-scale'));
    expect(spec.camera.focal_mm).toBe(24);
    expect(spec.camera.y).toBeLessThanOrEqual(0.8);
    const p = subjectFramePoints(spec).get('s0')!;
    expect(p.foot![1] - p.head![1]).toBeLessThan(0.1);
    expect(p.foot![1] - p.head![1]).toBeGreaterThan(0.03);
    const tall = spec.scene.props.filter((q) => !isEnvProp(q) && q.h >= 20);
    expect(tall.length).toBeGreaterThanOrEqual(1);
    const hz = horizonLine(spec.camera, spec.frame.aspect)!;
    expect(hz[0][1]).toBeGreaterThan(0.6);
  });

  test('two_shot: people on the left/right thirds, three-quarter toward each other', () => {
    const spec = layoutBoard(shotFields({ shot_size: 'MS', subjects: [subject('c1'), subject('c2')] }), ctx());
    const pts = subjectFramePoints(spec);
    const x = (id: string) => {
      const p = pts.get(id)!;
      return p.foot![0] + (p.head![0] - p.foot![0]) * 0.55;
    };
    expect(x('s0')).toBeCloseTo(1 / 3, 2);
    expect(x('s1')).toBeCloseTo(2 / 3, 2);
    const [a, b] = spec.scene.subjects;
    expect(relativeYaw(a!, spec.camera)).toBeGreaterThan(30);
    expect(relativeYaw(b!, spec.camera)).toBeLessThan(-30);
  });

  test('two_shot follows scene_sides (c2 on the left when the scene says so)', () => {
    const spec = layoutBoard(shotFields({ shot_size: 'MS', subjects: [subject('c1'), subject('c2')] }), ctx({ scene_sides: { left: 'c2', right: 'c1' } }));
    const [a, b] = spec.scene.subjects;
    expect(b!.x).toBeLessThan(a!.x);
  });

  test('single: subject centred (or on the requested third), in frame', () => {
    const spec = standardBoard(byKey('mcu'));
    const box = subjectFrameBoxes(spec).get('s0')!;
    expect((box.x0 + box.x1) / 2 / box.W).toBeCloseTo(1 / 3, 1);
    const c = layoutBoard(shotFields({ shot_size: 'MS', subjects: [subject('c4')] }), ctx());
    expect(c.scene.subjects[0]!.x).toBeCloseTo(0, 6);
  });

  test('insert: featured prop centred on the table, no people in frame', () => {
    const spec = standardBoard(byKey('insert'));
    expect(spec.scene.subjects).toHaveLength(0);
    const box = spec.scene.props.find((p) => p.kind === 'box')!;
    const table = spec.scene.props.find((p) => p.kind === 'table')!;
    expect(box.y).toBeCloseTo(table.h, 6);
    expect(box.w).toBeLessThan(0.35);
    expect(spec.camera.pitch_deg).toBeLessThan(0);
  });

  // An insert that lists only a support is about a small item on it; the
  // camera must frame that item, not the support's front face or the floor.
  const itemCentre = (spec: BoardSpec) => {
    const item = spec.scene.props.find((p) => p.kind === 'box' && !isEnvProp(p))!;
    return { item, at: project(spec.camera, spec.frame.aspect, [item.x, item.y + item.h / 2, item.z]) };
  };

  test.each(['eye', 'high', 'low'] as const)('insert with only a table (%s): a small item on the tabletop, centred', (angle) => {
    const spec = layoutBoard(shotFields({ shot_size: 'INSERT', angle, props: ['table'], action: '桌上摊开的信' }), ctx());
    const table = spec.scene.props.find((p) => p.kind === 'table')!;
    const { item, at } = itemCentre(spec);
    expect(item.y).toBeCloseTo(table.h, 6);
    expect(item.w).toBeLessThan(0.35);
    expect(at.visible).toBe(true);
    expect(Math.abs(at.x - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(at.y - 0.5)).toBeLessThan(0.15);
  });

  test.each(['eye', 'high', 'low'] as const)('insert with only a wall (%s): an item hung at eye height, wall right behind it', (angle) => {
    const spec = layoutBoard(shotFields({ shot_size: 'INSERT', angle, props: ['wall'], action: '墙上的旧照片' }), ctx());
    const wall = spec.scene.props.find((p) => p.kind === 'wall' && !isEnvProp(p))!;
    const { item, at } = itemCentre(spec);
    expect(item.y).toBeGreaterThan(1.2);
    expect(item.d).toBeLessThan(0.05);
    expect(wall.yaw_deg).toBe(0);
    expect(wall.z - wall.d / 2).toBeCloseTo(item.z + item.d / 2, 3);
    expect(Math.abs(spec.camera.pitch_deg)).toBeLessThanOrEqual(20);
    expect(at.visible).toBe(true);
    expect(Math.abs(at.x - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(at.y - 0.5)).toBeLessThan(0.15);
  });

  test('lateral_move: side-on runners, motion arrow l2r, track marker', () => {
    const spec = standardBoard(byKey('chase'));
    for (const s of spec.scene.subjects) {
      expect(s.pose).toBe('run');
      expect(facingBucket(relativeYaw(s, spec.camera))).toEqual({ view: 'side', mirror: false });
    }
    const moves = spec.overlay.arrows.filter((a) => a.kind === 'subject_move');
    expect(moves.length).toBeGreaterThanOrEqual(1);
    for (const a of moves) if (a.mode === 'anchored') expect(a.world_to.x).toBeGreaterThan(a.world_from.x);
    expect(spec.overlay.camera_move).toBe('track');
    const r2l = layoutBoard(shotFields({ shot_size: 'FS', subject_motion: 'r2l', subjects: [subject('c1')] }), ctx());
    const a = r2l.overlay.arrows[0]!;
    expect(a.mode === 'anchored' && a.world_to.x < a.world_from.x).toBe(true);
    expect(facingBucket(relativeYaw(r2l.scene.subjects[0]!, r2l.camera))).toEqual({ view: 'side', mirror: true });
  });

  test('vehicle: car rides with the camera on a foreground flank', () => {
    const spec = standardBoard(byKey('vehicle'));
    const car = spec.scene.props.find((p) => p.kind === 'car')!;
    expect(car.attach).toBe('camera');
    expect(car.z - car.w / 2).toBeLessThan(1);
    expect(spec.overlay.camera_move).toBe('vehicle');
  });

  test('establishing: everyone visible, environment dominates', () => {
    const spec = standardBoard(byKey('group'));
    const boxes = subjectFrameBoxes(spec);
    for (const s of spec.scene.subjects) {
      const b = boxes.get(s.id)!;
      expect(b.x0).toBeGreaterThan(0);
      expect(b.x1).toBeLessThan(b.W);
      expect((b.y1 - b.y0) / b.H).toBeLessThan(0.45);
    }
  });

  test('environments: interior shell walls, street blocks, open ground', () => {
    const mk = (env: 'interior' | 'street' | 'open') => layoutBoard(shotFields({ shot_size: 'MS', env, subjects: [subject('c1')] }), ctx());
    const walls = mk('interior').scene.props.filter((p) => p.id.startsWith('env-wall-'));
    expect(walls.map((w) => w.id).sort()).toEqual(['env-wall-back', 'env-wall-left', 'env-wall-right']);
    expect(mk('street').scene.props.filter(isEnvProp).length).toBeGreaterThanOrEqual(8);
    expect(mk('open').scene.props.filter(isEnvProp)).toHaveLength(0);
  });

  test('default prop sizes; door and window sit on the back wall', () => {
    const spec = layoutBoard(shotFields({ shot_size: 'FS', env: 'interior', props: ['door', 'window', 'chair', 'stairs'], subjects: [subject('c1')] }), ctx());
    const back = spec.scene.props.find((p) => p.id === 'env-wall-back')!;
    const door = spec.scene.props.find((p) => p.kind === 'door')!;
    const win = spec.scene.props.find((p) => p.kind === 'window')!;
    expect([door.w, door.h, door.d]).toEqual([0.9, 2.1, 0.1]);
    expect(door.z + door.d / 2).toBeCloseTo(back.z - back.d / 2, 6);
    expect(win.y).toBe(1);
    const chair = spec.scene.props.find((p) => p.kind === 'chair')!;
    expect([chair.w, chair.h, chair.d]).toEqual([0.5, 0.9, 0.5]);
  });

  test('guides: 2.39 + centre guide → 1.43; other aspects none', () => {
    const f = shotFields({ shot_size: 'MS', subjects: [subject('c1')] });
    expect(layoutBoard(f, ctx()).frame.guides).toEqual(['1.43']);
    expect(layoutBoard({ ...f, frame_format: '1.78' }, ctx()).frame.guides).toEqual([]);
    expect(layoutBoard(f, ctx({ look: { ...STANDARD_LOOK, center_guide: false } })).frame.guides).toEqual([]);
  });

  test('focal slider through layout keeps the subject size (≤ 3 %)', () => {
    const f = shotFields({ shot_size: 'MS', subjects: [subject('c1')] });
    const spans = [24, 50, 85].map((focal) => {
      const spec = layoutBoard(f, ctx({ focal_mm: focal }));
      expect(spec.camera.focal_mm).toBe(focal);
      const p = subjectFramePoints(spec).get('s0')!;
      return Math.min(1, p.foot![1]) - p.head![1];
    });
    for (const s of spans) expect(Math.abs(s - spans[0]!) / spans[0]!).toBeLessThanOrEqual(0.03);
  });

  test('roster fallbacks: unknown alias still gets a unique badge and default height', () => {
    const spec = layoutBoard(shotFields({ shot_size: 'WS', subjects: [subject('c1'), subject('c9'), subject('c8')] }), ctx());
    const badges = spec.scene.subjects.map((s) => s.badge);
    expect(new Set(badges).size).toBe(3);
    expect(spec.scene.subjects[1]!.height_m).toBe(1.7);
    expect(spec.scene.subjects[1]!.label).toBe('c9');
  });

  test('light defaults and seed pass-through', () => {
    const spec = layoutBoard(shotFields({ subjects: [subject('c1')] }), ctx({ seed: 99 }));
    expect(spec.scene.light).toEqual({ azimuth_deg: 45, elevation_deg: 40 });
    expect(spec.seed).toBe(99);
  });
});

import { BoardSpec, PropKind, type EnvKind } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import {
  buildFrameScene,
  isEnvProp,
  layoutBoard,
  renderBoard,
  RENDERER_VERSION,
  shotFields,
  STANDARD_LOOK,
  STANDARD_ROSTER,
  STANDARD_SHOTS,
  STANDARD_SIDES,
  standardBoard,
  standardSubject as subject,
  subjectFrameBoxes,
  VARIETY_SHOTS,
  type LayoutContext,
} from '../../src/index.ts';

/**
 * S4c sets and composition: dressing per place (deterministic, never in front
 * of a person), the new props, and singles on a third with look room.
 */

const ctx = (p: Partial<LayoutContext> = {}): LayoutContext => ({
  scene_sides: STANDARD_SIDES,
  roster: STANDARD_ROSTER,
  look: STANDARD_LOOK,
  technique: null,
  aspect: '2.39',
  seed: 11,
  ...p,
});
const ids = (spec: BoardSpec) => spec.scene.props.map((p) => p.id);
const mk = (env: EnvKind, extra: Parameters<typeof shotFields>[0] = {}, seed = 11) =>
  layoutBoard(shotFields({ shot_size: 'WS', env, subjects: [subject('c1')], ...extra }), ctx({ seed }));

describe('dressing per place', () => {
  test('classroom: a blackboard on the back wall and rows of desks with chairs', () => {
    const spec = mk('classroom');
    expect(ids(spec)).toContain('env-board-0');
    const desks = spec.scene.props.filter((p) => p.id.startsWith('env-desk-') && p.kind === 'table');
    expect(desks.length).toBeGreaterThanOrEqual(4);
    expect(spec.scene.props.filter((p) => p.id.startsWith('env-desk-chair-')).length).toBe(desks.length);
  });

  test('corridor: narrow, doors along both walls, a ceiling', () => {
    const spec = mk('corridor', { subjects: [subject('c1', { pose: 'walk' })] });
    const left = spec.scene.props.find((p) => p.id === 'env-wall-left')!;
    const right = spec.scene.props.find((p) => p.id === 'env-wall-right')!;
    expect(right.x - left.x).toBeLessThan(3.2);
    const doors = spec.scene.props.filter((p) => p.kind === 'door' && isEnvProp(p));
    expect(doors.some((d) => d.x < 0)).toBe(true);
    expect(doors.some((d) => d.x > 0)).toBe(true);
    expect(ids(spec).some((id) => id.startsWith('env-ceiling'))).toBe(true);
  });

  test('street: lamps and trees along the pavements; interior: a window or door and one piece of furniture', () => {
    const street = mk('street');
    expect(street.scene.props.some((p) => p.kind === 'lamp' && isEnvProp(p))).toBe(true);
    expect(street.scene.props.some((p) => p.kind === 'tree' && isEnvProp(p))).toBe(true);
    const room = mk('interior');
    expect(room.scene.props.some((p) => isEnvProp(p) && (p.kind === 'window' || p.kind === 'door'))).toBe(true);
    expect(room.scene.props.filter((p) => isEnvProp(p) && ['shelf', 'lamp', 'sofa'].includes(p.kind)).length).toBeLessThanOrEqual(1);
  });

  test('nature: a few trees, some of them in frame', () => {
    const spec = mk('nature');
    const trees = spec.scene.props.filter((p) => p.kind === 'tree');
    expect(trees.length).toBeGreaterThanOrEqual(3);
    const scene = buildFrameScene(spec);
    expect(scene.items.some((it) => it.type === 'prop' && it.kind === 'tree' && it.faces.length > 0)).toBe(true);
  });

  test('listed props are not doubled by the dressing', () => {
    const spec = mk('interior', { props: ['window', 'shelf'] });
    expect(spec.scene.props.filter((p) => p.kind === 'window')).toHaveLength(1);
    expect(spec.scene.props.filter((p) => p.kind === 'shelf')).toHaveLength(1);
  });

  test('deterministic: the same shot and seed lay out the same set', () => {
    for (const env of ['classroom', 'corridor', 'street', 'nature', 'interior'] as const) {
      expect(mk(env, {}, 5)).toEqual(mk(env, {}, 5));
    }
    expect(BoardSpec.safeParse(mk('classroom')).success).toBe(true);
  });
});

describe('dressing never stands in front of a person', () => {
  const shots = [...STANDARD_SHOTS, ...VARIETY_SHOTS];
  for (const shot of shots) {
    test(shot.key, () => {
      for (const seed of [3, 7, 19]) {
        const spec = standardBoard(shot, seed);
        const scene = buildFrameScene(spec);
        const boxes = subjectFrameBoxes(spec);
        for (const s of spec.scene.subjects) {
          const box = boxes.get(s.id);
          const item = scene.items.find((it) => it.type === 'subject' && it.id === s.id);
          if (!box || !item) continue;
          const area = (box.x1 - box.x0) * (box.y1 - box.y0);
          for (const it of scene.items) {
            // set pieces on the walls and the shell itself are behind everyone
            if (it.type !== 'prop' || !it.env || it.kind === 'wall' || it.kind === 'building' || it.kind === 'window' || it.kind === 'door') continue;
            if (it.depth >= item.depth) continue;
            const xs = it.faces.flatMap((f) => f.pts.map((q) => q[0]));
            const ys = it.faces.flatMap((f) => f.pts.map((q) => q[1]));
            const ox = Math.max(0, Math.min(box.x1, Math.max(...xs)) - Math.max(box.x0, Math.min(...xs)));
            const oy = Math.max(0, Math.min(box.y1, Math.max(...ys)) - Math.max(box.y0, Math.min(...ys)));
            expect((ox * oy) / area, `${it.id} over ${s.id} (seed ${seed})`).toBeLessThan(0.1);
          }
        }
      }
    });
  }
});

describe('the new props', () => {
  test('every kind lays out, projects and draws in all three modes', () => {
    for (const kind of PropKind.options) {
      const spec = layoutBoard(shotFields({ shot_size: 'FS', env: 'interior', props: kind === 'table' ? ['table'] : ['table', kind], subjects: [subject('c1')] }), ctx());
      expect(BoardSpec.safeParse(spec).success, kind).toBe(true);
      for (const mode of ['structure', 'pencil', 'topview'] as const) {
        const svg = renderBoard(spec, mode);
        expect(svg, `${kind} ${mode}`).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  test('an insert of a phone puts a table under it; a cup is the subject of its insert', () => {
    const phone = layoutBoard(shotFields({ shot_size: 'INSERT', props: ['phone'], env: 'interior' }), ctx());
    const p = phone.scene.props.find((x) => x.kind === 'phone')!;
    const t = phone.scene.props.find((x) => x.kind === 'table')!;
    expect(p.y).toBeCloseTo(t.h, 6);
    const cup = layoutBoard(shotFields({ shot_size: 'INSERT', props: ['table', 'cup'], env: 'interior' }), ctx());
    expect(cup.scene.props.find((x) => x.kind === 'cup')!.x).toBe(0);
  });

  test('a lying person lies on the bed and is drawn over it; a sitter sits on the sofa', () => {
    const lie = layoutBoard(shotFields({ shot_size: 'MS', env: 'interior', props: ['bed'], subjects: [subject('c2', { pose: 'lie' })] }), ctx());
    const s = lie.scene.subjects[0]!;
    const bed = lie.scene.props.find((x) => x.kind === 'bed')!;
    expect(s.z_override).toBe(1);
    expect(bed.h).toBeLessThan(0.2);
    expect(Math.hypot(bed.x - s.x, bed.z - s.z)).toBeLessThan(1.2);
    const sit = layoutBoard(shotFields({ shot_size: 'MS', env: 'interior', props: ['sofa'], subjects: [subject('c1', { pose: 'sit' })] }), ctx());
    const p = sit.scene.subjects[0]!;
    const sofa = sit.scene.props.find((x) => x.kind === 'sofa')!;
    expect(Math.hypot(sofa.x - p.x, sofa.z - p.z)).toBeLessThan(0.4);
  });

  test('small things go on the table; a bag at the feet', () => {
    const spec = layoutBoard(shotFields({ shot_size: 'FS', env: 'interior', props: ['cup', 'table', 'book', 'bag'], subjects: [subject('c1')] }), ctx());
    const table = spec.scene.props.find((x) => x.kind === 'table')!;
    for (const k of ['cup', 'book'] as const) expect(spec.scene.props.find((x) => x.kind === k)!.y).toBeCloseTo(table.h, 6);
    const bag = spec.scene.props.find((x) => x.kind === 'bag')!;
    expect(bag.y).toBe(0);
    expect(Math.abs(bag.z - spec.scene.subjects[0]!.z)).toBeLessThan(0.3);
  });
});

describe('composition', () => {
  const fx = (spec: BoardSpec, id = 's0') => {
    const b = subjectFrameBoxes(spec).get(id)!;
    return (b.x0 + b.x1) / 2 / b.W;
  };

  test('a single sits on a third with the look room in front; shot / reverse alternate', () => {
    const a = layoutBoard(shotFields({ shot_size: 'MCU', subjects: [subject('c1')] }), ctx());
    const b = layoutBoard(shotFields({ shot_size: 'MCU', subjects: [subject('c2')] }), ctx());
    expect(fx(a)).toBeLessThan(0.45);
    expect(fx(b)).toBeGreaterThan(0.55);
    const facingRight = layoutBoard(shotFields({ shot_size: 'MCU', subjects: [subject('c3', { facing: '3q_right' })] }), ctx({ scene_sides: null }));
    expect(fx(facingRight)).toBeLessThan(0.45);
  });

  test('a lone person facing the lens with no axis stays centred', () => {
    const spec = layoutBoard(shotFields({ shot_size: 'MCU', subjects: [subject('c3', { facing: 'camera' })] }), ctx({ scene_sides: null }));
    expect(Math.abs(fx(spec) - 0.5)).toBeLessThan(0.05);
  });

  test('the renderer version marks boards laid out with the S4c rules', () => {
    expect(RENDERER_VERSION).toBe('board-s4c');
  });
});

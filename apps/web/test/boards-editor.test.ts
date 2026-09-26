import { describe, expect, it } from 'vitest';
import { BoardSpec, type BoardArrow } from '@storyscript/contracts';
import { frameSize, poseTopY, project, relativeYaw, renderBoard, STANDARD_SHOTS, standardBoard, subjectBands, subjectFramePoints } from '@storyscript/core';
import {
  arrowHandles,
  canRedo,
  canUndo,
  depthBandOf,
  facing8Of,
  FACING8,
  groundAt,
  historyCommit,
  historyInit,
  historyRedo,
  historyShortcut,
  historyUndo,
  HISTORY_LIMIT,
  isDirty,
  moveArrowEnd,
  moveSubjectFoot,
  pointerToFrame,
  redoLabel,
  setArrowMode,
  setAspect,
  setDepthBand,
  setFacing8,
  setFocal,
  setGuide143,
  setLabelText,
  setLayer,
  setOverlayOffset,
  setPose,
  setTone,
  subjectHandles,
  undoLabel,
} from '../src/lib/board-editor.ts';

/**
 * Board editor model (AT-05, web part): pure operations over BoardSpec and
 * the undo/redo stack. Every edited spec must still pass the contract, and
 * direct manipulation must land exactly under the pointer.
 */

const std = (key: string) => {
  const s = STANDARD_SHOTS.find((x) => x.key === key);
  if (!s) throw new Error(key);
  return { shot: s, spec: standardBoard(s) };
};

const footFrame = (spec: BoardSpec, id: string) => subjectFramePoints(spec).get(id)!.foot!;

describe('history (command stack)', () => {
  const { spec } = std('05-mcu');
  it('commit / undo / redo, no-op commits are dropped', () => {
    let h = historyInit(spec);
    expect(canUndo(h)).toBe(false);
    h = historyCommit(h, '改姿势', setPose(spec, 's0', 'point'));
    h = historyCommit(h, '改明暗', setTone(h.present.spec, 's0', 3));
    expect(h.past).toHaveLength(2);
    expect(undoLabel(h)).toBe('改明暗');
    // same spec again: no entry
    expect(historyCommit(h, '无变化', structuredClone(h.present.spec))).toBe(h);

    h = historyUndo(h);
    expect(h.present.spec.scene.subjects[0]!.tone_override).toBeNull();
    expect(h.present.spec.scene.subjects[0]!.pose).toBe('point');
    expect(redoLabel(h)).toBe('改明暗');
    h = historyUndo(h);
    expect(h.present.spec).toEqual(spec);
    expect(isDirty(h, spec)).toBe(false);
    expect(historyUndo(h)).toBe(h);
    h = historyRedo(historyRedo(h));
    expect(canRedo(h)).toBe(false);
    expect(h.present.spec.scene.subjects[0]!.tone_override).toBe(3);
    expect(isDirty(h, spec)).toBe(true);

    // a new command after undo drops the redo branch
    h = historyCommit(historyUndo(h), '改层级', setLayer(h.present.spec, 's0', 1));
    expect(canRedo(h)).toBe(false);
  });

  it('keeps at most HISTORY_LIMIT steps', () => {
    let h = historyInit(spec);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = historyCommit(h, 'label', setLabelText(h.present.spec, 'l-shot', `标签 ${i}`));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });

  it('keyboard shortcuts: Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z and Ctrl+Y redo', () => {
    const k = (key: string, o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...o,
    });
    expect(historyShortcut(k('z', { metaKey: true }))).toBe('undo');
    expect(historyShortcut(k('z', { ctrlKey: true }))).toBe('undo');
    expect(historyShortcut(k('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(historyShortcut(k('y', { ctrlKey: true }))).toBe('redo');
    expect(historyShortcut(k('z'))).toBeNull();
    expect(historyShortcut(k('z', { metaKey: true, altKey: true }))).toBeNull();
  });
});

describe('dragging a person (foot point: ray ∩ ground)', () => {
  it('the foot lands under the pointer and the facing relative to the lens is kept', () => {
    const { spec } = std('10-depth-two');
    const s0 = spec.scene.subjects[0]!;
    const rel0 = relativeYaw(s0, spec.camera);
    const target = { fx: 0.3, fy: 0.9 };
    const next = moveSubjectFoot(spec, s0.id, target.fx, target.fy);
    expect(BoardSpec.parse(next)).toEqual(next);
    const f = footFrame(next, s0.id);
    expect(f[0]).toBeCloseTo(target.fx, 3);
    expect(f[1]).toBeCloseTo(target.fy, 3);
    const moved = next.scene.subjects[0]!;
    expect(relativeYaw(moved, next.camera)).toBeCloseTo(rel0, 0);
    // nothing else changed
    expect(next.scene.subjects[1]).toEqual(spec.scene.subjects[1]);
    expect(next.camera).toEqual(spec.camera);
    expect(spec.scene.subjects[0]).toEqual(s0); // input untouched
  });

  it('above the horizon the drag is ignored', () => {
    const { spec } = std('05-mcu');
    expect(groundAt(spec, 0.5, 0.01)).toBeNull();
    expect(moveSubjectFoot(spec, 's0', 0.5, 0.01)).toBe(spec);
  });

  it("the person's own anchored arrows travel along", () => {
    const { spec } = std('07-chase');
    const mover = spec.overlay.arrows.find((a) => a.mode === 'anchored' && a.subject_id === 's0') as Extract<BoardArrow, { mode: 'anchored' }>;
    expect(mover).toBeDefined();
    const s0 = spec.scene.subjects[0]!;
    const f = footFrame(spec, 's0');
    const next = moveSubjectFoot(spec, 's0', f[0] + 0.05, f[1] + 0.02);
    const s1 = next.scene.subjects[0]!;
    const moved = next.overlay.arrows.find((a) => a.id === mover.id) as typeof mover;
    expect(moved.world_from.x - mover.world_from.x).toBeCloseTo(s1.x - s0.x, 3);
    expect(moved.world_to.z - mover.world_to.z).toBeCloseTo(s1.z - s0.z, 3);
  });
});

describe('inspector operations', () => {
  it('eight facings round-trip', () => {
    const { spec } = std('05-mcu');
    for (const f of FACING8) expect(facing8Of(setFacing8(spec, 's0', f), 's0')).toBe(f);
  });

  it('depth band: the person moves along the line of sight into the requested band', () => {
    const { spec } = std('10-depth-two');
    const ids = spec.scene.subjects.map((s) => s.id);
    const id = ids[ids.length - 1]!;
    const bearing = (sp: BoardSpec) => {
      const s = sp.scene.subjects.find((x) => x.id === id)!;
      return Math.atan2(s.x - sp.camera.x, s.z - sp.camera.z);
    };
    for (const band of ['fg', 'bg', 'mg'] as const) {
      const next = setDepthBand(spec, id, band);
      expect(depthBandOf(next, id), band).toBe(band);
      // same bearing from the camera (only the distance changes)
      expect(bearing(next)).toBeCloseTo(bearing(spec), 3);
      expect(BoardSpec.parse(next)).toEqual(next);
    }
    // alone in the frame: the layout factors scale the distance
    const single = std('05-mcu').spec;
    const far = setDepthBand(single, 's0', 'bg');
    expect(subjectBands(far)[0]!.depth / subjectBands(single)[0]!.depth).toBeCloseTo(2, 3);
  });

  it('focal slider keeps the shot size (camera dollies), or zooms when unchecked', () => {
    const { shot, spec } = std('05-mcu');
    const s = spec.scene.subjects[0]!;
    const top = poseTopY(s.pose) * s.height_m;
    const span = (sp: BoardSpec) => {
      const a = project(sp.camera, sp.frame.aspect, [s.x, top, s.z]);
      const b = project(sp.camera, sp.frame.aspect, [s.x, top - 0.4, s.z]);
      return Math.abs(b.y - a.y);
    };
    const h0 = span(spec);
    for (const f of [24, 35, 85, 135]) {
      const kept = setFocal(spec, f, { keepSize: true, fields: shot.fields });
      expect(kept.camera.focal_mm).toBe(f);
      expect(BoardSpec.parse(kept)).toEqual(kept);
      expect(Math.abs(span(kept) / h0 - 1), `${f}mm`).toBeLessThanOrEqual(0.03);
      // without the shot's fields: the focal ratio
      const ratio = setFocal(spec, f, { keepSize: true, fields: null });
      expect(Math.abs(span(ratio) / h0 - 1), `${f}mm ratio`).toBeLessThanOrEqual(0.05);
    }
    const zoom = setFocal(spec, 85, { keepSize: false });
    expect(zoom.camera.z).toBe(spec.camera.z);
    expect(span(zoom) / h0).toBeCloseTo(85 / spec.camera.focal_mm, 1);
  });

  it('aspect, 1.43 guide, labels, offset and layer stay valid BoardSpecs', () => {
    const { spec } = std('03-ots-a');
    let next = setAspect(spec, '1.78');
    next = setGuide143(next, false);
    expect(next.frame).toEqual({ aspect: '1.78', guides: [] });
    expect(setGuide143(setGuide143(next, true), true).frame.guides).toEqual(['1.43']);
    next = setLabelText(next, 'l-shot', '中景 · 过肩');
    next = setOverlayOffset(next, 0.9, -0.03);
    expect(next.overlay.offset).toEqual({ x: 0.5, y: -0.03 });
    next = setLayer(setTone(next, 's0', 2), 's0', -1);
    expect(BoardSpec.parse(next)).toEqual(next);
    expect(next.overlay.labels[0]!.text).toBe('中景 · 过肩');
  });
});

describe('arrows', () => {
  it('handle positions match where core renderBoard draws the arrows', () => {
    for (const key of ['03-ots-a', '04-ots-b', '07-chase', '10-depth-two']) {
      const { spec } = std(key);
      const svg = renderBoard(spec, 'structure');
      const handles = arrowHandles(spec);
      expect(handles.length, key).toBe(spec.overlay.arrows.filter((a) => svg.includes(`data-arrow="${a.id}"`)).length);
      for (const h of handles) {
        const m = new RegExp(`data-arrow="${h.id}"[^>]*><path d="M([-\\d.]+) ([-\\d.]+)`).exec(svg);
        expect(m, `${key} ${h.id}`).not.toBeNull();
        expect(h.from[0]).toBeCloseTo(Number(m![1]), 1);
        expect(h.from[1]).toBeCloseTo(Number(m![2]), 1);
      }
    }
  });

  it('dragging an anchored arrow end keeps it under the pointer', () => {
    const { spec } = std('03-ots-a');
    const eye = arrowHandles(spec).find((a) => a.kind === 'eyeline')!;
    const { W, H } = frameSize(spec.frame.aspect);
    const target = { fx: eye.to[0] / W - 0.06, fy: eye.to[1] / H + 0.03 };
    const next = moveArrowEnd(spec, eye.id, 'to', target.fx, target.fy);
    const after = arrowHandles(next).find((a) => a.id === eye.id)!;
    expect(after.to[0] / W).toBeCloseTo(target.fx, 2);
    expect(after.to[1] / H).toBeCloseTo(target.fy, 2);
    expect(after.from).toEqual(eye.from);
  });

  it('free arrows store frame points; the overlay offset is taken out', () => {
    const { spec } = std('03-ots-a');
    const eye = spec.overlay.arrows.find((a) => a.kind === 'eyeline')!;
    const shifted = setOverlayOffset(spec, 0.02, 0.01);
    const free = setArrowMode(shifted, eye.id, 'free');
    const a = free.overlay.arrows.find((x) => x.id === eye.id)!;
    expect(a.mode).toBe('free');
    // switching mode does not move the arrow on screen
    const before = arrowHandles(shifted).find((x) => x.id === eye.id)!;
    const now = arrowHandles(free).find((x) => x.id === eye.id)!;
    expect(now.from[0]).toBeCloseTo(before.from[0], 0);
    expect(now.to[1]).toBeCloseTo(before.to[1], 0);
    const moved = moveArrowEnd(free, eye.id, 'from', 0.3, 0.4);
    const m = moved.overlay.arrows.find((x) => x.id === eye.id)!;
    expect(m.mode === 'free' && m.from).toEqual({ x: 0.28, y: 0.39 });
    // and back to anchored, still on screen where it was
    const back = setArrowMode(free, eye.id, 'anchored');
    const b = arrowHandles(back).find((x) => x.id === eye.id)!;
    const { W } = frameSize(spec.frame.aspect);
    expect(Math.abs(b.from[0] - before.from[0]) / W).toBeLessThan(0.01);
    expect(BoardSpec.parse(back)).toEqual(back);
  });

  it('subject handles sit on the projected feet', () => {
    const { spec } = std('10-depth-two');
    const { W, H } = frameSize(spec.frame.aspect);
    for (const h of subjectHandles(spec)) {
      const f = footFrame(spec, h.id);
      expect(h.foot![0]).toBeCloseTo(f[0] * W, 6);
      expect(h.foot![1]).toBeCloseTo(f[1] * H, 6);
    }
  });

  it('pointer → frame coordinates', () => {
    expect(pointerToFrame(150, 80, { left: 100, top: 40, width: 200, height: 80 })).toEqual({ fx: 0.25, fy: 0.5 });
  });
});

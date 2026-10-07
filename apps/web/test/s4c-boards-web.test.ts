import { describe, expect, it } from 'vitest';
import { Api, BoardSpec, EnvKind, Pose, PolishMode, PropKind, RelayoutBoardsInput, RelayoutBoardsResult, type BoardView } from '@storyscript/contracts';
import { gestureCount, PICTURE_VERSION, POLISH_MODE_HINT, POLISH_MODE_LABEL, RENDERER_VERSION, STANDARD_SHOTS, standardBoard } from '@storyscript/core';
import { defaultSelection, parseBreakdownDraft } from '../src/lib/drafts.ts';
import { gestureOf, nextGesture, setPose, setTone, type GestureTables } from '../src/lib/board-editor.ts';
import { ENV_LABEL, POSE_LABEL, PROP_LABEL } from '../src/lib/labels.ts';
import { polishModeNote } from '../src/lib/polish.ts';
import { relayoutCounts, relayoutLabel, relayoutOffer, relayoutResultLine } from '../src/lib/relayout.ts';
import { isVarietyIssue, splitVariety, VARIETY_BREAKDOWN_HINT, VARIETY_POLISH_HINT, VARIETY_TITLE, varietyLines } from '../src/lib/variety.ts';
import { renderKey } from '../src/views/boards/images.ts';
import { overlayKey } from '../src/views/boards/raster-layers.ts';
import { draft, fields, issue, uuid } from './fixtures.ts';

// S4c web logic: which boards the relayout button counts, the gesture cycle
// ("换个动作"), the variety warnings in drafts, the new enum values reaching
// the editors, and the picture cache key. No DOM: everything here is pure.

const SCENE_A = uuid();
const SCENE_B = uuid();
const NEW = 'board-s4c';
const OLD = 'board-m2.0';

type Row = Pick<BoardView, 'scene_id' | 'renderer_version' | 'user_edited' | 'adopted_raster_id'>;
const row = (scene_id: string, renderer_version: string, user_edited = false, adopted_raster_id: string | null = null): Row => ({ scene_id, renderer_version, user_edited, adopted_raster_id });

describe('relayout: what the button counts', () => {
  const list: Row[] = [
    row(SCENE_A, OLD),
    row(SCENE_A, OLD, false, uuid()),
    row(SCENE_A, OLD, true),
    row(SCENE_A, NEW),
    row(SCENE_B, OLD),
    row(SCENE_B, NEW, true),
    row(SCENE_B, NEW),
  ];

  it('counts old, not hand-edited and without an adopted AI picture; kept boards never count, whatever their renderer', () => {
    expect(relayoutCounts(list, null, NEW)).toEqual({ relayable: 2, kept: 3, current: 2 });
    expect(relayoutCounts(list, SCENE_A, NEW)).toEqual({ relayable: 1, kept: 2, current: 1 });
    expect(relayoutCounts(list, SCENE_B, NEW)).toEqual({ relayable: 1, kept: 1, current: 1 });
  });

  it('is zero when every board is on the current renderer, and for an unknown scene', () => {
    expect(relayoutCounts(list.map((r) => ({ ...r, renderer_version: NEW })), null, NEW).relayable).toBe(0);
    expect(relayoutCounts(list, uuid(), NEW)).toEqual({ relayable: 0, kept: 0, current: 0 });
    expect(relayoutCounts([], null, NEW).relayable).toBe(0);
  });

  it('measures against the renderer in core by default', () => {
    expect(relayoutCounts([row(SCENE_A, RENDERER_VERSION), row(SCENE_A, 'board-from-the-past')], SCENE_A)).toMatchObject({ relayable: 1, current: 1 });
  });

  it('the labels say what is covered; the single button has the plain wording', () => {
    expect(relayoutLabel(12, 'only')).toBe('用新画法重排 12 个分镜');
    expect(relayoutLabel(4, 'scene')).toBe('用新画法重排本场 4 个分镜');
    expect(relayoutLabel(12, 'all')).toBe('用新画法重排全部 12 个分镜');
  });

  it('the offer: nothing when there is nothing to do, one button when this scene holds it all, two when scopes differ', () => {
    const only = [row(SCENE_A, OLD), row(SCENE_A, OLD), row(SCENE_A, NEW), row(SCENE_A, OLD, true)];
    expect(relayoutOffer(only.map((r) => ({ ...r, renderer_version: NEW })), SCENE_A, NEW)).toBeNull();
    expect(relayoutOffer([], SCENE_A, NEW)).toBeNull();
    // this scene has all of them: one button over every scene
    expect(relayoutOffer(only, SCENE_A, NEW)).toEqual({
      relayable: 2,
      buttons: [{ target: null, label: '用新画法重排 2 个分镜' }],
    });
    // another scene has some, this one none: still one button
    expect(relayoutOffer(only, SCENE_B, NEW)?.buttons).toEqual([{ target: null, label: '用新画法重排 2 个分镜' }]);
    // both scenes have some: this scene first, then every scene
    const both = [...only, row(SCENE_B, OLD, false, uuid()), row(SCENE_B, OLD)];
    expect(relayoutOffer(both, SCENE_B, NEW)).toEqual({
      relayable: 3,
      buttons: [
        { target: SCENE_B, label: '用新画法重排本场 1 个分镜' },
        { target: null, label: '用新画法重排全部 3 个分镜' },
      ],
    });
  });

  it('the result line names both counts', () => {
    expect(relayoutResultLine({ relaid: 11, kept_edited: 1, already_current: 0 })).toBe('重排了 11 个，跳过手改过和用了 AI 图的 1 个');
    expect(relayoutResultLine({ relaid: 0, kept_edited: 0, already_current: 12 })).toBe('重排了 0 个，跳过手改过和用了 AI 图的 0 个');
  });

  it('the contract: no scene means every scene, the route and the result schema', () => {
    expect(RelayoutBoardsInput.parse({})).toEqual({ scene_id: null });
    expect(RelayoutBoardsInput.parse({ scene_id: SCENE_A })).toEqual({ scene_id: SCENE_A });
    expect(RelayoutBoardsInput.safeParse({ scene_id: 'x' }).success).toBe(false);
    expect(Api.relayoutBoards).toMatchObject({ method: 'POST', path: '/api/v1/boards/relayout' });
    expect(RelayoutBoardsResult.safeParse({ relaid: 1, kept_edited: 0, already_current: 2 }).success).toBe(true);
  });
});

describe('换个动作: cycling a person\'s gesture', () => {
  const base = standardBoard(STANDARD_SHOTS.find((s) => s.key === '05-mcu')!);
  const id = base.scene.subjects[0]!.id;
  /** the figure track decides the real counts; here a pose has 4 variants, seated people 1 */
  const four: GestureTables = {
    count: (pose) => (pose === 'sit' ? 1 : 4),
    effective: (s) => (s.gesture === undefined || s.gesture === null ? 2 : s.gesture % 4),
  };
  const withGesture = (g: number | null | undefined): BoardSpec => {
    const spec = structuredClone(base);
    const s = spec.scene.subjects[0]!;
    if (g === undefined) delete s.gesture;
    else s.gesture = g;
    return spec;
  };
  const gestureAt = (spec: BoardSpec) => spec.scene.subjects.find((s) => s.id === id)!.gesture;

  it('starts from the variant the person is drawn with now, so the first click changes the picture', () => {
    expect(gestureOf(withGesture(undefined), id, four)).toEqual({ index: 2, count: 4 });
    expect(gestureAt(nextGesture(withGesture(undefined), id, four))).toBe(3);
    expect(gestureAt(nextGesture(withGesture(null), id, four))).toBe(3);
    expect(gestureAt(nextGesture(withGesture(1), id, four))).toBe(2);
  });

  it('wraps around after the last variant and visits every one', () => {
    expect(gestureAt(nextGesture(withGesture(3), id, four))).toBe(0);
    let spec = withGesture(0);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      spec = nextGesture(spec, id, four);
      seen.push(gestureAt(spec)!);
    }
    expect(seen).toEqual([1, 2, 3, 0]);
  });

  it('is hidden (null) and does nothing when the pose has one variant', () => {
    const seated = setPose(withGesture(undefined), id, 'sit');
    expect(gestureOf(seated, id, four)).toBeNull();
    expect(nextGesture(seated, id, four)).toBe(seated);
    expect(gestureOf(withGesture(undefined), 'nobody', four)).toBeNull();
    expect(nextGesture(withGesture(undefined), 'nobody', four)).toEqual(withGesture(undefined));
  });

  it('changes only that person\'s gesture and stays a valid spec within the contract range', () => {
    const next = nextGesture(withGesture(undefined), id, four);
    expect(BoardSpec.parse(next)).toEqual(next);
    expect({ ...next.scene.subjects[0], gesture: undefined }).toEqual({ ...base.scene.subjects[0], gesture: undefined });
    expect(next.camera).toEqual(base.camera);
    // a pose with more variants than the contract can store (0…15) is capped at 16
    const many: GestureTables = { count: () => 40, effective: (s) => s.gesture ?? 15 };
    expect(gestureOf(withGesture(15), id, many)).toEqual({ index: 15, count: 16 });
    expect(gestureAt(nextGesture(withGesture(15), id, many))).toBe(0);
  });

  it('a new pose goes back to the seed\'s pick (a gesture belongs to its pose); other edits keep it', () => {
    expect(gestureAt(setPose(withGesture(3), id, 'walk'))).toBeNull();
    expect(gestureAt(setPose(withGesture(3), id, base.scene.subjects[0]!.pose))).toBe(3);
    expect(gestureAt(setPose(withGesture(undefined), id, 'walk'))).toBeUndefined();
    expect(gestureAt(setTone(withGesture(3), id, 2))).toBe(3);
  });

  it('works with core\'s real tables: hidden for a pose with one variant, otherwise a different variant each click', () => {
    for (const pose of Pose.options) {
      const spec = setPose(base, id, pose);
      const n = gestureCount(pose);
      const g = gestureOf(spec, id);
      if (n <= 1) {
        expect(g, pose).toBeNull();
        expect(nextGesture(spec, id), pose).toBe(spec);
        continue;
      }
      expect(g?.count, pose).toBe(Math.min(n, 16));
      const next = nextGesture(spec, id);
      expect(BoardSpec.safeParse(next).success, pose).toBe(true);
      expect(gestureOf(next, id)?.index, pose).toBe(((g?.index ?? 0) + 1) % (g?.count ?? 1));
    }
  });
});

describe('the new poses, props and places reach the editors', () => {
  it('every Pose / PropKind / EnvKind value has a label, and the labels hold nothing else', () => {
    expect(Object.keys(POSE_LABEL).sort()).toEqual([...Pose.options].sort());
    expect(Object.keys(PROP_LABEL).sort()).toEqual([...PropKind.options].sort());
    expect(Object.keys(ENV_LABEL).sort()).toEqual([...EnvKind.options].sort());
    for (const label of [...Object.values(POSE_LABEL), ...Object.values(PROP_LABEL), ...Object.values(ENV_LABEL)]) expect(label.trim()).not.toBe('');
  });

  it('the pose select can offer 躺 跪 伸手 打电话, the shot editor the nine new props and three new places', () => {
    expect([POSE_LABEL.lie, POSE_LABEL.kneel, POSE_LABEL.reach, POSE_LABEL.phone]).toEqual(['躺', '跪', '伸手', '打电话']);
    expect(['bed', 'sofa', 'shelf', 'lamp', 'tree', 'phone', 'cup', 'book', 'bag'].every((p) => PropKind.options.includes(p as never))).toBe(true);
    expect(PropKind.options).toHaveLength(20); // S5b: + can, bottle
    expect(['nature', 'corridor', 'classroom'].every((e) => EnvKind.options.includes(e as never))).toBe(true);
  });
});

describe('polish ways', () => {
  it('every way has a label and a hint, 丰富变化 included; nothing assumes three', () => {
    expect(PolishMode.options).toContain('vary');
    for (const m of PolishMode.options) {
      expect(POLISH_MODE_LABEL[m].trim(), m).not.toBe('');
      expect(POLISH_MODE_HINT[m].trim(), m).not.toBe('');
    }
    expect(Object.keys(POLISH_MODE_LABEL).sort()).toEqual([...PolishMode.options].sort());
    expect(POLISH_MODE_LABEL.vary).toBe('丰富变化');
  });

  it('丰富变化 on one shot gets a caution; other ways and several shots do not', () => {
    expect(polishModeNote('vary', 1)).toContain('相邻');
    expect(polishModeNote('vary', 0)).not.toBeNull();
    expect(polishModeNote('vary', 2)).toBeNull();
    for (const m of PolishMode.options.filter((x) => x !== 'vary')) expect(polishModeNote(m, 1)).toBeNull();
  });
});

describe('variety warnings in drafts', () => {
  const THREE = { shots: [fields(), fields({ action: '门铃响' }), fields({ action: '店主抬头' })] };
  const issues = [
    issue('warning', null, 'VARIETY_FEW_SIZES', '只用了 2 种景别'),
    issue('warning', 2, 'VARIETY_SIZE_RUN', '连续 3 个镜头景别、角度、运动都一样'),
    issue('warning', 0, 'quote_fuzzy', '引用只是近似匹配'),
    issue('warning', 1, 'VARIETY_MOTION_UNSET', '动作写了走，人物却没有运动'),
    issue('warning', null, 'VARIETY_FEW_SIZES', '只用了 2 种景别'),
  ];

  it('recognises the VARIETY_ codes and splits them from everything else', () => {
    expect(isVarietyIssue({ code: 'VARIETY_NO_WIDE' })).toBe(true);
    expect(isVarietyIssue({ code: 'quote_fuzzy' })).toBe(false);
    expect(isVarietyIssue({ code: 'NOT_VARIETY_X' })).toBe(false);
    const { variety, rest } = splitVariety(issues);
    expect(variety).toHaveLength(4);
    expect(rest.map((i) => i.code)).toEqual(['quote_fuzzy']);
  });

  it('lists whole-draft warnings first, then per item in order (#N as on the cards), each once', () => {
    expect(varietyLines(issues)).toEqual([
      { where: null, message: '只用了 2 种景别' },
      { where: '#2', message: '动作写了走，人物却没有运动' },
      { where: '#3', message: '连续 3 个镜头景别、角度、运动都一样' },
    ]);
    expect(varietyLines([issue('warning', 0, 'quote_fuzzy')])).toEqual([]);
    expect(varietyLines([])).toEqual([]);
  });

  it('never blocks: items with variety warnings stay selectable and ticked', () => {
    const p = parseBreakdownDraft(draft(THREE, issues));
    if (!p.ok) throw new Error('parse failed');
    expect(p.items.map((i) => i.selectable)).toEqual([true, true, true]);
    expect(p.items.map((i) => i.blockedReason)).toEqual([null, null, null]);
    // item 0 only has a fuzzy-quote warning (its match level is "fuzzy": unticked by default)
    expect([...defaultSelection(p.items)]).toEqual([1, 2]);
    // the whole-draft warning does not turn into a draft-level error
    expect(p.draftIssues.every((i) => i.level === 'warning')).toBe(true);
  });

  it('the title and the hints name the way out: 润色 → 丰富变化', () => {
    expect(VARIETY_TITLE).toBe('镜头变化');
    for (const hint of [VARIETY_BREAKDOWN_HINT, VARIETY_POLISH_HINT]) {
      expect(hint).toContain('不影响应用');
      expect(hint).toContain('AI 润色');
      expect(hint).toContain(POLISH_MODE_LABEL.vary);
    }
  });
});

describe('picture cache keys carry the picture version', () => {
  const spec = standardBoard(STANDARD_SHOTS[0]!);

  it('renderKey and overlayKey include PICTURE_VERSION', () => {
    expect(PICTURE_VERSION).not.toBe('');
    expect(renderKey({ spec, mode: 'pencil' }).split('|')).toContain(PICTURE_VERSION);
    expect(renderKey({ spec, mode: 'structure', overlay: false }).split('|')).toContain(PICTURE_VERSION);
    expect(overlayKey(spec, '001').split('|')).toContain(PICTURE_VERSION);
  });

  it('still tells boards, modes, overlays and codes apart', () => {
    const keys = new Set([
      renderKey({ spec, mode: 'pencil' }),
      renderKey({ spec, mode: 'structure' }),
      renderKey({ spec, mode: 'pencil', overlay: false }),
      renderKey({ spec, mode: 'pencil', code: '002' }),
      renderKey({ spec: structuredClone({ ...spec, camera: { ...spec.camera, focal_mm: spec.camera.focal_mm + 5 } }), mode: 'pencil' }),
    ]);
    expect(keys.size).toBe(5);
    expect(renderKey({ spec: structuredClone(spec), mode: 'pencil' })).toBe(renderKey({ spec, mode: 'pencil' }));
  });

  it('a different gesture is a different picture key (the structure hash covers the subjects)', () => {
    const a = structuredClone(spec);
    const b = structuredClone(spec);
    a.scene.subjects[0]!.gesture = 0;
    b.scene.subjects[0]!.gesture = 1;
    expect(renderKey({ spec: a, mode: 'pencil' })).not.toBe(renderKey({ spec: b, mode: 'pencil' }));
  });
});

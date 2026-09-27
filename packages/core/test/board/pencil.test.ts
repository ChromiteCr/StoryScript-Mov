/**
 * Pencil renderer (M2 "宽银幕铅笔分镜"): hygiene, determinism, per-element
 * isolation, composition parity with structure, performance, goldens.
 * Pixel-level look metrics L1–L7 live in apps/server/test/look-metrics.test.ts
 * (they need resvg).
 */
import type { BoardSpec, BoardTemplate } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import {
  inferTemplate,
  PENCIL_VARIANTS,
  renderBoard,
  renderPencil,
  STANDARD_SHOTS,
  standardBoard,
  structureHash,
  subjectFrameBoxes,
} from '../../src/index.ts';
import { budget } from '../perf-budget.ts';

const boards = STANDARD_SHOTS.map((s) => ({ shot: s, spec: standardBoard(s) }));
const board = (key: string): BoardSpec => {
  const b = boards.find((x) => x.shot.key === key);
  if (!b) throw new Error(key);
  return b.spec;
};

const GRAY = /^#([0-9a-f]{2})\1\1$/;

/** Every paint value (fill / stroke / gradient stops / filter colours). */
function paints(svg: string): string[] {
  return [...svg.matchAll(/\s(?:fill|stroke|stop-color|flood-color|lighting-color)="([^"]*)"/g)].map((m) => m[1] as string);
}

/** Content of every `<g ATTR="value">…</g>` (nesting-aware), keyed by value. */
function groups(svg: string, attr: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`<g\\b[^>]*?\\s${attr}="([^"]*)"[^>]*>`, 'g');
  for (const m of svg.matchAll(re)) {
    let depth = 1;
    let i = (m.index as number) + m[0].length;
    const start = i;
    while (depth > 0 && i < svg.length) {
      const open = svg.indexOf('<g', i);
      const close = svg.indexOf('</g>', i);
      if (close < 0) break;
      if (open >= 0 && open < close && /[\s>]/.test(svg[open + 2] ?? '')) {
        depth++;
        i = open + 2;
      } else {
        depth--;
        i = close + 4;
      }
    }
    out.set(m[1] as string, svg.slice(start, i - 4));
  }
  return out;
}

/** Individual hatch marks ("M…Z" sub-paths) of the three hatch layers. */
function hatchMarks(svg: string): string[] {
  const marks: string[] = [];
  for (const [layer, body] of groups(svg, 'data-layer')) {
    if (!layer.startsWith('hatch-')) continue;
    for (const d of body.matchAll(/\sd="([^"]*)"/g)) for (const s of (d[1] as string).split(/(?=M)/)) if (s) marks.push(`${layer}:${s}`);
  }
  return marks;
}

function firstPoint(mark: string): [number, number] {
  const m = /M(-?[\d.]+) (-?[\d.]+)/.exec(mark);
  return [Number(m?.[1]), Number(m?.[2])];
}

describe('pencil SVG hygiene (CSP, greys only, precision)', () => {
  for (const { shot, spec } of boards) {
    test(shot.key, () => {
      const svg = renderBoard(spec, 'pencil', { code: 'S01-001' });
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).not.toMatch(/\sstyle=/i);
      expect(svg).not.toMatch(/<style/i);
      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toMatch(/<image|<foreignObject/i);
      expect(svg).not.toMatch(/\son[a-z]+=/i);
      expect(svg).not.toMatch(/(?:href|src)="(?!#)/);
      // group opacity is 3–4× slower in resvg: jitter goes through fill-/stroke-opacity
      expect(svg).not.toMatch(/\sopacity=/);
      const ids = new Set([...svg.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
      const colors = paints(svg);
      expect(colors.length).toBeGreaterThan(0);
      for (const c of colors) {
        const ref = /^url\(#([^)]+)\)$/.exec(c);
        if (ref) expect(ids.has(ref[1]), c).toBe(true);
        else expect(c === 'none' || GRAY.test(c), c).toBe(true);
      }
      for (const m of svg.matchAll(/(?:href)="#([^"]+)"/g)) expect(ids.has(m[1]), m[1]).toBe(true);
      // colour matrices must not introduce chroma: the R, G and B rows are identical
      for (const m of svg.matchAll(/<feColorMatrix[^>]*values="([^"]*)"/g)) {
        const v = (m[1] as string).trim().split(/\s+/);
        expect(v).toHaveLength(20);
        expect(v.slice(5, 10)).toEqual(v.slice(0, 5));
        expect(v.slice(10, 15)).toEqual(v.slice(0, 5));
      }
      expect(svg).not.toMatch(/\d\.\d{3,}/); // two-decimal coordinates
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    });
  }

  test('every look variant stays grey', () => {
    for (const look of Object.values(PENCIL_VARIANTS)) {
      const svg = renderPencil(board('03-ots-a'), { look });
      for (const c of paints(svg)) expect(c === 'none' || GRAY.test(c) || /^url\(#/.test(c), c).toBe(true);
    }
  });
});

describe('pencil text and overlay', () => {
  const evil = '<script>alert(1)</script>&"\'';
  test('labels, badges and ids are escaped', () => {
    const base = board('03-ots-a');
    const spec: BoardSpec = {
      ...base,
      scene: { ...base.scene, subjects: base.scene.subjects.map((s) => ({ ...s, label: evil, badge: '<b>' })) },
      overlay: { ...base.overlay, labels: [{ id: 'x"><script>', text: evil, x: 0.1, y: 0.5 }] },
    };
    const svg = renderBoard(spec, 'pencil', { code: '<i>S1</i>' });
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<i>');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
    expect(svg).toContain('&lt;i&gt;S1&lt;/i&gt;');
  });

  for (const { shot, spec } of boards) {
    test(`${shot.key}: overlay=false has no <text> and no annotation layer`, () => {
      const svg = renderBoard(spec, 'pencil', { overlay: false, code: 'S01-001' });
      expect(svg).not.toContain('<text');
      expect(svg).not.toContain('data-layer="overlay"');
    });
  }

  test('annotation layer: shot code, badges, arrows, camera move, 1.43 guide; picture layer separate', () => {
    const svg = renderBoard(board('07-chase'), 'pencil', { code: 'S01-007' });
    const overlayAt = svg.indexOf('data-layer="overlay"');
    expect(overlayAt).toBeGreaterThan(svg.indexOf('data-layer="picture"'));
    const ov = svg.slice(overlayAt);
    expect(ov).toContain('data-code="1"');
    expect(ov).toContain('>S01-007</text>');
    expect(ov).toContain('data-badge="s0"');
    expect(ov).toContain('data-kind="subject_move"');
    expect(ov).toContain('data-camera-move="track"');
    expect(ov).toContain('data-guide="1.43"');
    const ots = renderBoard(board('03-ots-a'), 'pencil');
    expect(ots).toContain('data-kind="eyeline"');
  });

  test('overlay offset translates the annotation layer only (M1 semantics)', () => {
    const base = board('05-mcu');
    const moved = { ...base, overlay: { ...base.overlay, offset: { x: 0.1, y: -0.05 } } };
    const a = renderBoard(base, 'pencil', { overlay: true });
    const b = renderBoard(moved, 'pencil', { overlay: true });
    expect(b).toMatch(/data-layer="overlay" transform="translate\(184 -38\.\d+\)"/);
    const pic = (s: string) => groups(s, 'data-layer').get('picture');
    expect(pic(b)).toBe(pic(a));
  });

  test('shot code only when spec.overlay.show_code', () => {
    const base = board('05-mcu');
    const off = renderBoard({ ...base, overlay: { ...base.overlay, show_code: false } }, 'pencil', { code: 'S01-005' });
    expect(off).not.toContain('data-code');
  });
});

describe('pencil determinism and isolation', () => {
  test('same input → byte-identical output', () => {
    for (const shot of STANDARD_SHOTS) {
      expect(renderBoard(standardBoard(shot, 5), 'pencil')).toBe(renderBoard(standardBoard(shot, 5), 'pencil'));
    }
  });

  test('a different seed re-jitters the strokes', () => {
    const shot = STANDARD_SHOTS[4]!;
    expect(renderBoard(standardBoard(shot, 1), 'pencil')).not.toBe(renderBoard(standardBoard(shot, 2), 'pencil'));
  });

  // Moving one person must not change any other person's strokes, and hatch
  // marks may only appear / disappear near the moved person (the hatch field
  // is keyed by line index, not by the picture).
  const cases: { key: string; id: string; dx: number }[] = [
    { key: '10-depth-two', id: 's1', dx: 0.4 },
    { key: '12-group', id: 's3', dx: 0.3 },
    { key: '03-ots-a', id: 's1', dx: 0.15 },
  ];
  for (const c of cases) {
    test(`${c.key}: moving ${c.id} leaves other elements' strokes untouched`, () => {
      const base = board(c.key);
      expect(base.scene.subjects.some((s) => s.id === c.id)).toBe(true);
      const moved: BoardSpec = {
        ...base,
        scene: { ...base.scene, subjects: base.scene.subjects.map((s) => (s.id === c.id ? { ...s, x: s.x + c.dx } : s)) },
      };
      const a = renderPencil(base, { overlay: false });
      const b = renderPencil(moved, { overlay: false });
      expect(b).not.toBe(a);
      const ga = groups(a, 'data-el');
      const gb = groups(b, 'data-el');
      const others = base.scene.subjects.filter((s) => s.id !== c.id);
      expect(others.length).toBeGreaterThan(0);
      for (const s of others) {
        expect(ga.has(`subject:${s.id}`)).toBe(true);
        expect(gb.get(`subject:${s.id}`), s.id).toBe(ga.get(`subject:${s.id}`));
        expect(gb.get(`guide:${s.id}`), `guide ${s.id}`).toBe(ga.get(`guide:${s.id}`));
      }
      for (const [k, v] of ga) if (k.startsWith('prop:')) expect(gb.get(k), k).toBe(v);
      expect(gb.get(`subject:${c.id}`)).not.toBe(ga.get(`subject:${c.id}`));
      // hatch marks: the ones present in both are byte-identical by construction;
      // those that differ sit near the moved person (old or new place)
      const bxA = subjectFrameBoxes(base).get(c.id);
      const bxB = subjectFrameBoxes(moved).get(c.id);
      expect(bxA && bxB).toBeTruthy();
      const pad = 160;
      const near = (p: [number, number]) =>
        [bxA!, bxB!].some((q) => p[0] >= q.x0 - pad && p[0] <= q.x1 + pad && p[1] >= q.y0 - pad && p[1] <= q.y1 + pad);
      const ma = new Set(hatchMarks(a));
      const mb = new Set(hatchMarks(b));
      const changed = [...ma].filter((m) => !mb.has(m)).concat([...mb].filter((m) => !ma.has(m)));
      const common = [...ma].filter((m) => mb.has(m)).length;
      expect(common).toBeGreaterThan(0.5 * ma.size);
      const far = changed.filter((m) => !near(firstPoint(m.slice(m.indexOf(':') + 1))));
      expect(far.length, far.slice(0, 3).join(' | ')).toBe(0);
    });
  }

  test('structureHash: stable for annotation edits, changes with the picture', () => {
    const base = board('07-chase');
    const h = structureHash(base);
    expect(h).toBe(structureHash(standardBoard(STANDARD_SHOTS.find((s) => s.key === '07-chase')!)));
    expect(structureHash({ ...base, overlay: { ...base.overlay, labels: [], offset: { x: 0.2, y: 0 }, show_code: false } })).toBe(h);
    expect(structureHash({ ...base, seed: base.seed + 1 })).not.toBe(h);
    const s0 = base.scene.subjects[0]!;
    expect(structureHash({ ...base, scene: { ...base.scene, subjects: [{ ...s0, x: s0.x + 0.5 }, ...base.scene.subjects.slice(1)] } })).not.toBe(h);
    expect(structureHash(base, PENCIL_VARIANTS.B)).not.toBe(structureHash(base, PENCIL_VARIANTS.C));
  });
});

describe('pencil composition follows structure', () => {
  for (const { shot, spec } of boards) {
    test(`${shot.key}: same elements in the same painter order`, () => {
      const structure = renderBoard(spec, 'structure', { overlay: false });
      const pencil = renderPencil(spec, { overlay: false });
      const sOrder = [...structure.matchAll(/<g data-(prop|subject)="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
      const pOrder = [...pencil.matchAll(/<g data-el="(prop|subject):([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
      expect(pOrder).toEqual(sOrder);
      expect(pencil).toContain('viewBox="0 0 1840 ');
      expect(pencil.slice(0, 200)).toBe(pencil.slice(0, 200)); // sanity
      const vb = (s: string) => /viewBox="([^"]*)"/.exec(s)?.[1];
      expect(vb(pencil)).toBe(vb(structure));
    });
  }

  test('action shots carry speed lines and a dashed after-image; static shots do not', () => {
    const chase = renderPencil(board('07-chase'), { overlay: false });
    expect(chase).toContain('data-speed="1"');
    expect(chase).toContain('data-ghost="1"');
    const mcu = renderPencil(board('05-mcu'), { overlay: false });
    expect(mcu).not.toContain('data-speed');
    expect(mcu).not.toContain('data-ghost');
  });

  test('construction lines are drawn first (before any element), in #8a8a8a at 0.35', () => {
    const svg = renderPencil(board('02-low-hero'), { overlay: false });
    const at = svg.indexOf('data-layer="construction"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(svg.indexOf('data-el="subject:'));
    expect(svg).toMatch(/stroke="#8a8a8a" stroke-opacity="0\.35" stroke-width="0\.6" data-layer="construction"/);
  });

  test('three frame-wide hatch groups, each under a blurred tone mask', () => {
    const svg = renderPencil(board('10-depth-two'), { overlay: false });
    for (const k of [1, 2, 3]) {
      const m = new RegExp(`<g mask="url\\(#([^)]+)\\)" data-layer="hatch-${k}">`).exec(svg);
      expect(m, `hatch-${k}`).toBeTruthy();
      const maskId = m![1] as string;
      const mask = new RegExp(`<mask id="${maskId}"[^>]*><use href="#[^"]+" filter="url\\(#([^)]+)\\)"`).exec(svg);
      expect(mask).toBeTruthy();
      const filter = new RegExp(`<filter id="${mask![1]}"[^>]*>.*?</filter>`).exec(svg)?.[0] ?? '';
      expect(filter).toContain('feGaussianBlur');
    }
    expect(svg).toContain('data-layer="smudge"');
  });
});

describe('pencil performance', () => {
  test('one board < 150 ms (worst of 12, median of 3)', () => {
    for (const { spec } of boards) renderPencil(spec); // warm-up
    let worst = 0;
    for (const { spec } of boards) {
      const t: number[] = [];
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        renderPencil(spec);
        t.push(performance.now() - t0);
      }
      worst = Math.max(worst, t.sort((x, y) => x - y)[1] as number);
    }
    expect(worst).toBeLessThan(budget(150));
  });

  test('path count stays in the 1–2k range (≤ 3000)', () => {
    for (const { shot, spec } of boards) {
      const n = (renderPencil(spec, { overlay: false }).match(/<path/g) ?? []).length;
      expect(n, shot.key).toBeLessThan(3000);
    }
  });
});

describe('golden pencil SVGs (one per template)', () => {
  const pick: Record<BoardTemplate, string> = {
    establishing: '12-group',
    single: '05-mcu',
    two_shot: '10-depth-two',
    ots: '03-ots-a',
    insert: '11-insert',
    lateral_move: '07-chase',
    scale: '01-ews-scale',
  };
  for (const [template, key] of Object.entries(pick) as [BoardTemplate, string][]) {
    test(template, async () => {
      const shot = STANDARD_SHOTS.find((s) => s.key === key)!;
      expect(shot.fields.template ?? inferTemplate(shot.fields)).toBe(template);
      const svg = renderBoard(standardBoard(shot), 'pencil', { code: 'S01-001' });
      await expect(svg).toMatchFileSnapshot(`../__golden__/pencil-${template}.svg`);
    });
  }
});

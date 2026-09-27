import type { BoardSpec, BoardTemplate, RenderMode } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import {
  inferTemplate,
  layoutBoard,
  renderBoard,
  renderPuppetPreview,
  shotFields,
  STANDARD_LOOK,
  STANDARD_ROSTER,
  STANDARD_SHOTS,
  standardBoard,
  standardSubject as subject,
} from '../../src/index.ts';
import { budget } from '../perf-budget.ts';

const MODES: RenderMode[] = ['structure', 'topview', 'pencil'];
const boards = STANDARD_SHOTS.map((s) => ({ shot: s, spec: standardBoard(s) }));

function colorsOf(svg: string): string[] {
  return [...svg.matchAll(/\s(?:fill|stroke|stop-color)="([^"]*)"/g)].map((m) => m[1] as string);
}
const isGray = (c: string) => c === 'none' || /^#([0-9a-f]{2})\1\1$/.test(c);
/** a paint server defined in the same SVG (pencil gradients); its stops are checked as colours too */
const isLocalRef = (c: string, svg: string) => {
  const m = /^url\(#([^)]+)\)$/.exec(c);
  return !!m && svg.includes(` id="${m[1]}"`);
};

describe('SVG hygiene (CSP, greyscale, precision)', () => {
  for (const { shot, spec } of boards) {
    for (const mode of MODES) {
      test(`${shot.key} ${mode}`, () => {
        const svg = renderBoard(spec, mode);
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg).not.toMatch(/\sstyle=/i);
        expect(svg).not.toMatch(/<style/i);
        expect(svg).not.toMatch(/<script/i);
        expect(svg).not.toMatch(/\son[a-z]+=/i);
        expect(svg).not.toMatch(/(?:href|src)="(?!#)/);
        const colors = colorsOf(svg);
        expect(colors.length).toBeGreaterThan(0);
        for (const c of colors) expect(isGray(c) || isLocalRef(c, svg), c).toBe(true);
        expect(svg).not.toMatch(/\d\.\d{3,}/); // two-decimal coordinates
        expect(svg).not.toMatch(/NaN|Infinity|undefined/);
      });
    }
  }
});

describe('text safety', () => {
  const evil = '<script>alert(1)</script>&"\'';
  const spec: BoardSpec = (() => {
    const base = standardBoard(STANDARD_SHOTS[2]!);
    return {
      ...base,
      scene: { ...base.scene, subjects: base.scene.subjects.map((s) => ({ ...s, label: evil, badge: '<b>' })) },
      overlay: { ...base.overlay, labels: [{ id: 'x"><script>', text: evil, x: 0.1, y: 0.5 }] },
    };
  })();
  for (const mode of MODES) {
    test(`${mode}: labels, badges and ids are escaped`, () => {
      const svg = renderBoard(spec, mode);
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<b>');
      if (mode !== 'topview') expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
      else expect(svg).toContain('&lt;script&gt;');
    });
  }
});

describe('overlay switch', () => {
  for (const { shot, spec } of boards) {
    test(`${shot.key}: overlay=false has no <text> (control image)`, () => {
      for (const mode of MODES) {
        const svg = renderBoard(spec, mode, { overlay: false });
        expect(svg).not.toContain('<text');
        expect(svg).not.toContain('data-layer="overlay"');
      }
    });
  }

  test('overlay carries badges, arrows, camera-move symbol, labels, 1.43 guide', () => {
    const chase = boards.find((b) => b.shot.key === '07-chase')!.spec;
    const svg = renderBoard(chase, 'structure');
    expect(svg).toContain('data-badge="s0"');
    expect(svg).toContain('data-arrow=');
    expect(svg).toContain('data-camera-move="track"');
    expect(svg).toContain('>TRACK</text>');
    expect(svg).toContain('data-guide="1.43"');
    const ots = renderBoard(boards[2]!.spec, 'structure');
    expect(ots).toContain('data-kind="eyeline"');
    expect(ots).toContain('stroke-dasharray');
  });

  test('every camera move has a symbol; static has none', () => {
    const base = standardBoard(STANDARD_SHOTS[4]!);
    for (const m of ['push_in', 'pull_out', 'pan', 'tilt', 'track', 'crane', 'handheld', 'vehicle'] as const) {
      const svg = renderBoard({ ...base, overlay: { ...base.overlay, camera_move: m } }, 'structure');
      expect(svg).toContain(`data-camera-move="${m}"`);
    }
    expect(renderBoard({ ...base, overlay: { ...base.overlay, camera_move: 'static' } }, 'structure')).not.toContain('data-camera-move');
  });

  test('overlay offset translates the annotation layer only', () => {
    const base = standardBoard(STANDARD_SHOTS[4]!);
    const svg = renderBoard({ ...base, overlay: { ...base.overlay, offset: { x: 0.1, y: -0.05 } } }, 'structure');
    expect(svg).toMatch(/data-layer="overlay" transform="translate\(184 -38\.\d+\)"/);
  });
});

describe('determinism and options', () => {
  test('same input → byte-identical output (layout + render)', () => {
    for (const shot of STANDARD_SHOTS) {
      for (const mode of MODES) expect(renderBoard(standardBoard(shot, 5), mode)).toBe(renderBoard(standardBoard(shot, 5), mode));
    }
  });

  test('pencil is its own renderer on the same frame as structure', () => {
    const spec = boards[0]!.spec;
    const pencil = renderBoard(spec, 'pencil');
    const structure = renderBoard(spec, 'structure');
    expect(pencil).not.toBe(structure);
    const vb = (s: string) => /viewBox="([^"]*)"/.exec(s)?.[1];
    expect(vb(pencil)).toBe(vb(structure));
    expect(pencil).toContain('data-layer="picture"');
    expect(pencil).toContain('data-layer="hatch-1"');
  });

  test('viewBox is 1840 wide at the frame aspect; width option scales the element only', () => {
    const svg = renderBoard(boards[0]!.spec, 'structure', { width: 460 });
    expect(svg).toContain('viewBox="0 0 1840 769.87"');
    expect(svg).toContain('width="460" height="192.47"');
    const wide = layoutBoard(shotFields({ frame_format: '1.78', subjects: [subject('c1')] }), {
      scene_sides: null,
      roster: STANDARD_ROSTER,
      look: STANDARD_LOOK,
      aspect: '2.39',
      seed: 1,
    });
    expect(renderBoard(wide, 'structure')).toContain('viewBox="0 0 1840 1033.71"');
  });

  test('background=false omits the paper rect', () => {
    const svg = renderBoard(boards[0]!.spec, 'structure', { background: false });
    expect(svg).not.toContain('fill="#ffffff"/><g clip-path');
    expect(svg.indexOf('<rect x="0" y="0" width="1840" height="769.87" fill="#ffffff"/>')).toBe(-1);
  });

  test('topview says it is a schematic', () => {
    expect(renderBoard(boards[0]!.spec, 'topview')).toContain('站位示意（非实景测量）');
  });

  test('overhead topview: camera marker sits under the people and its label says it is above', () => {
    const spec = boards.find((b) => b.shot.key === '09-overhead')!.spec;
    const svg = renderBoard(spec, 'topview');
    const cam = svg.indexOf('data-camera="1"');
    expect(cam).toBeGreaterThan(-1);
    expect(cam).toBeLessThan(svg.indexOf('data-subject='));
    expect(svg).toContain('摄影机（正上方）');
    // ground-level cameras keep the body icon drawn on top
    const eye = renderBoard(boards.find((b) => b.shot.key === '05-mcu')!.spec, 'topview');
    expect(eye.indexOf('data-camera="1"')).toBeGreaterThan(eye.indexOf('data-subject='));
  });

  test('puppet preview renders standalone', () => {
    const svg = renderPuppetPreview('run', 'side', true, 'coat');
    expect(svg).toContain('data-view="side"');
    expect(svg).not.toMatch(/style=|<text/);
  });

  test('puppet preview keeps a pointing arm inside the cell', () => {
    for (const view of ['front', '3q', 'side', 'back'] as const) {
      const svg = renderPuppetPreview('point', view, false, 'regular', { width: 110, height: 190 });
      const xs = [...svg.matchAll(/<path d="([^"]*)"/g)].flatMap((m) =>
        [...(m[1] as string).matchAll(/[ML]\s?(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((q) => Number(q[1])),
      );
      expect(xs.length).toBeGreaterThan(0);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(110);
    }
  });

  test('structure render < 50 ms per board (12-shot average, layout included)', () => {
    for (const s of STANDARD_SHOTS) renderBoard(standardBoard(s), 'structure'); // warm-up
    const rounds = 5;
    const t0 = performance.now();
    for (let r = 0; r < rounds; r++) for (const s of STANDARD_SHOTS) renderBoard(standardBoard(s, r), 'structure');
    const avg = (performance.now() - t0) / (rounds * STANDARD_SHOTS.length);
    expect(avg).toBeLessThan(budget(50));
  });
});

describe('golden structure SVGs (one per template)', () => {
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
      const svg = renderBoard(standardBoard(shot), 'structure');
      await expect(svg).toMatchFileSnapshot(`../__golden__/${template}.svg`);
    });
  }
});

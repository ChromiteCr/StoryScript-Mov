import { describe, expect, test } from 'vitest';
import type { BoardSpec } from '@storyscript/contracts';
import {
  buildImagePrompt,
  DEFAULT_PIXEL_WINDOW,
  IMAGE_PROMPT_VERSION,
  legalOpenAISize,
  OPENAI_EDIT_SIZES,
  padControlSvg,
  parseSize,
  pickAspectValue,
  pixelSize,
  planCanvas,
  rasterPostSvg,
  renderBoard,
  smallestPixelSize,
  standardBoard,
  STANDARD_SHOTS,
  type StandardShot,
} from '../../src/index.ts';

/**
 * Image prompt (SPEC FR-12): fixed skeleton + interpolated fields, trigger
 * terms stripped from free text, byte-identical for identical input. Plus the
 * size arithmetic of the three dialects and the control / post SVGs.
 */

const shot = (key: string): StandardShot => STANDARD_SHOTS.find((s) => s.key === key)!;
const board = (key: string): BoardSpec => standardBoard(shot(key));

const SKELETON_EN = [
  /^Task: redraw image 1 as a hand-drawn pencil storyboard frame\. Keep the composition of image 1 exactly/,
  /^Style: loose graphite pencil storyboard sketch on paper, monochrome, 3–4 tonal values, strong silhouettes, directional hatching, construction lines, widescreen framing \(2\.39:1\)\.$/,
  /^Camera: /,
  /^People: /,
  /^Setting: /,
  /^Action \(from the shot notes\): /,
  /^Avoid: no text, no numbers, no arrows, no borders, no color, no logo, no watermark, no extra people, no grey mannequin look\.$/,
];

describe('image prompt skeleton', () => {
  test('fixed sections in order, version image-v1', () => {
    const s = shot('10-depth-two');
    const p = buildImagePrompt({ spec: board('10-depth-two'), shot: s.fields });
    expect(p.version).toBe(IMAGE_PROMPT_VERSION);
    expect(IMAGE_PROMPT_VERSION).toBe('image-v1');
    const lines = p.text.split('\n');
    expect(lines).toHaveLength(SKELETON_EN.length);
    lines.forEach((line, i) => expect(line).toMatch(SKELETON_EN[i]!));
    expect(p.text).toContain('Camera: medium shot; eye-level camera; wide-angle lens (about 24mm, exaggerated depth); static camera.');
    expect(p.text).toContain('Setting: interior room; props: door; key light from screen left.');
  });

  test('exactly N people with screen side, depth, facing and pose per person', () => {
    const two = buildImagePrompt({ spec: board('10-depth-two'), shot: shot('10-depth-two').fields });
    expect(two.text).toContain('People: exactly 2 people.');
    expect(two.text).toContain('Person 1: screen left, foreground, three-quarter view turned to screen right, standing');
    expect(two.text).toContain('Person 2: screen center, background, facing the camera, standing');
    expect(two.people.map((p) => p.screen)).toEqual(['left', 'center']);

    const one = buildImagePrompt({ spec: board('05-mcu'), shot: shot('05-mcu').fields });
    expect(one.text).toContain('People: exactly 1 person.');

    const four = buildImagePrompt({ spec: board('12-group'), shot: shot('12-group').fields });
    expect(four.text).toContain('People: exactly 4 people.');
    expect(four.text).toMatch(/pointing[\s\S]*sitting[\s\S]*standing[\s\S]*crouching/);

    const none = buildImagePrompt({ spec: board('11-insert'), shot: shot('11-insert').fields });
    expect(none.text).toContain('People: no people in the frame.');
    expect(none.text).not.toMatch(/exactly \d/);
  });

  test('screen left / right follows the board, not list order', () => {
    const spec = board('10-depth-two');
    const mirrored: BoardSpec = {
      ...spec,
      scene: { ...spec.scene, subjects: spec.scene.subjects.map((s) => ({ ...s, x: -s.x })) },
    };
    const p = buildImagePrompt({ spec: mirrored, shot: shot('10-depth-two').fields });
    expect(p.people.at(-1)!.screen).toBe('right');
    expect(p.people[0]!.screen).not.toBe('right');
  });

  test('trigger terms and titles are stripped from free text and reported; labels become person tags', () => {
    const spec = board('10-depth-two');
    const p = buildImagePrompt({ spec, shot: { ...shot('10-depth-two').fields, action: 'IMAX 式构图，甲把《某片》递给乙' } });
    expect(p.text).not.toMatch(/imax/i);
    expect(p.text).not.toContain('《');
    expect(p.removed).toEqual(expect.arrayContaining(['imax', '《某片》']));
    // character labels never leave: they become the prompt's person tags
    expect(p.text).not.toContain('甲');
    expect(p.text).not.toContain('乙');
    expect(p.text).toMatch(/Action \(from the shot notes\): 式构图，Person 1把 ?递给Person 2/);
  });

  test('no action line when the free text is empty after filtering', () => {
    const p = buildImagePrompt({ spec: board('11-insert'), shot: { ...shot('11-insert').fields, action: '《某片》' } });
    expect(p.text).not.toContain('Action');
    expect(p.removed).toEqual(['《某片》']);
  });

  test('deterministic: same input → byte-identical text and hash', () => {
    const input = { spec: board('03-ots-a'), shot: shot('03-ots-a').fields, padded: true, style_anchor: true };
    const a = buildImagePrompt(input);
    const b = buildImagePrompt(structuredClone(input));
    expect(a.text).toBe(b.text);
    expect(a.hash).toBe(b.hash);
    expect(a.text).toContain('Image 2 is a style reference only');
    expect(a.text).toContain('Leave the plain paper margins outside the frame empty.');
  });

  test('zh version keeps the skeleton and the exact count', () => {
    const p = buildImagePrompt({ spec: board('10-depth-two'), shot: shot('10-depth-two').fields, lang: 'zh' });
    expect(p.lang).toBe('zh');
    expect(p.text).toContain('画面中恰好 2 人（exactly 2 people）');
    expect(p.text).toContain('人物1：画面左侧');
    expect(p.text.split('\n').at(-1)).toBe('禁止：不要文字、不要数字、不要箭头、不要边框、不要颜色、不要标志、不要水印、不要多余人物、不要灰色人体模型感。');
  });
});

describe('request sizes', () => {
  test('openai-edits sizes: exact table, 16-multiples, ratio ≤ 3:1', () => {
    expect(OPENAI_EDIT_SIZES).toEqual({
      '2.39': { w: 1840, h: 768 },
      '2.20': { w: 1760, h: 800 },
      '1.90': { w: 1520, h: 800 },
      '1.78': { w: 1536, h: 864 },
      '1.43': { w: 1440, h: 1008 },
    });
    for (const s of Object.values(OPENAI_EDIT_SIZES)) {
      expect(s.w % 16).toBe(0);
      expect(s.h % 16).toBe(0);
      expect(s.w / s.h).toBeLessThanOrEqual(3);
    }
    expect(planCanvas('2.39', { mode: 'exact' }).request_size).toBe('1840x768');
    const wild = legalOpenAISize({ w: 4000, h: 1000 });
    expect(wild.w % 16 + (wild.h % 16)).toBe(0);
    expect(wild.w / wild.h).toBeLessThanOrEqual(3);
    expect(Math.max(wild.w, wild.h)).toBeLessThanOrEqual(3840);
  });

  test('aspect_enum: nearest listed ratio, padded control, crop box recorded', () => {
    const values = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1'];
    expect(pickAspectValue(2.39, values)).toBe('21:9');
    expect(pickAspectValue(1.9, values)).toBe('16:9');
    const plan = planCanvas('2.39', { mode: 'aspect_enum', aspect_values: values });
    expect(plan.request_size).toBe('21:9');
    expect(plan.padded).toBe(true);
    expect(plan.crop.x0).toBe(0);
    expect(plan.crop.x1).toBe(1);
    // the crop box has the frame's ratio
    const ratio = ((plan.crop.x1 - plan.crop.x0) * plan.canvas.w) / ((plan.crop.y1 - plan.crop.y0) * plan.canvas.h);
    expect(ratio).toBeCloseTo(2.39, 2);
  });

  test('pixels: inside the window (2K default, configurable), 16-multiples', () => {
    const s = pixelSize(2.39);
    expect(s.w % 16 + (s.h % 16)).toBe(0);
    expect(s.w * s.h).toBeGreaterThanOrEqual(DEFAULT_PIXEL_WINDOW.min_pixels);
    expect(s.w * s.h).toBeLessThanOrEqual(DEFAULT_PIXEL_WINDOW.max_pixels);
    expect(s.w / s.h).toBeCloseTo(2.39, 1);
    const small = pixelSize(2.39, { tier: '1K', target_pixels: 1024 * 1024, min_pixels: 921_600, max_pixels: 16_777_216, multiple: 8 });
    expect(small.w * small.h).toBeLessThan(s.w * s.h);
    const plan = planCanvas('2.39', { mode: 'pixels' });
    expect(parseSize(plan.request_size)).toEqual(s);
    expect(plan.canvas.w).toBeLessThanOrEqual(1840);
    const sq = smallestPixelSize();
    expect(sq.w * sq.h).toBeGreaterThanOrEqual(DEFAULT_PIXEL_WINDOW.min_pixels);
  });
});

describe('control and post-processing SVG', () => {
  test('padControlSvg nests the text-free board without style attributes', () => {
    const spec = board('10-depth-two');
    const plan = planCanvas('2.39', { mode: 'aspect_enum', aspect_values: ['21:9'] });
    const svg = padControlSvg(renderBoard(spec, 'pencil', { overlay: false }), plan.canvas, plan.frame_box);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1536 658"')).toBe(true);
    // transformed group (no nested <svg>/clip), paper margin rects above and below the frame
    expect(svg).toContain(`<g transform="translate(0 ${plan.frame_box.y}) scale(`);
    expect(svg).not.toMatch(/<svg[^>]*\sx=/);
    expect(svg).toContain(`<rect x="0" y="0" width="1536" height="${plan.frame_box.y}"`);
    expect(svg).not.toMatch(/<text|style=|<style/);
  });

  test('rasterPostSvg: desaturate, level table, crop viewBox, paper layers; only data URLs', () => {
    const svg = rasterPostSvg({
      href: 'data:image/png;base64,iVBORw0KGgo=',
      width: 168,
      height: 72,
      crop: { x0: 0, y0: 0.0125, x1: 1, y1: 0.9875 },
      out: { W: 1840, H: 769.87 },
    });
    expect(svg).toContain('<feColorMatrix type="saturate" values="0"/>');
    expect(svg).toContain('feComponentTransfer');
    expect(svg).toContain('<g transform="scale(10.952381 10.966809) translate(0 -0.9)">');
    expect(svg).not.toMatch(/style=|<style/);
    expect(() => rasterPostSvg({ href: 'https://example.invalid/x.png', width: 1, height: 1, crop: { x0: 0, y0: 0, x1: 1, y1: 1 }, out: { W: 10, H: 10 } })).toThrow();
  });
});

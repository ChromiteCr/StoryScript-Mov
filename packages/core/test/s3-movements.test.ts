import { describe, expect, test } from 'vitest';
import { BreakdownOutput, Movement, ShotFields, type BoardSpec } from '@storyscript/contracts';
import {
  normalizeBreakdownJson,
  normalizeShotFieldsJson,
  parseShotLine,
  renderBoard,
  shotFields,
  shotFieldsFromLine,
  STANDARD_SHOTS,
  standardBoard,
  validateShotFieldsBasic,
  ZH_BOARD,
  ZH_MOVEMENT,
} from '../src/index.ts';

/**
 * S3: three new camera moves (orbit, aerial, dolly_zoom) and the free-text
 * camera_notes field: labels, board marks in both renderers, synonyms, the
 * shot-line vocabulary and the length warning.
 */

const NEW_MOVES = ['orbit', 'aerial', 'dolly_zoom'] as const;

const withMove = (spec: BoardSpec, m: (typeof NEW_MOVES)[number]): BoardSpec => ({ ...spec, overlay: { ...spec.overlay, camera_move: m } });

const isGray = (c: string) => c === 'none' || /^#([0-9a-f]{2})\1\1$/.test(c);
const colorsOf = (svg: string): string[] => [...svg.matchAll(/\s(?:fill|stroke|stop-color)="([^"]*)"/g)].map((m) => m[1] as string);

/** the <g data-camera-move="…"> group of an SVG */
function moveGroup(svg: string, m: string): string {
  const start = svg.indexOf(`<g data-camera-move="${m}"`);
  expect(start).toBeGreaterThan(-1);
  return svg.slice(start, svg.indexOf('</g>', start) + 4);
}

describe('labels', () => {
  test('the contract lists the three new moves and each has a Chinese label', () => {
    for (const m of NEW_MOVES) expect(Movement.options).toContain(m);
    expect(ZH_MOVEMENT.orbit).toBe('环绕');
    expect(ZH_MOVEMENT.aerial).toBe('航拍');
    expect(ZH_MOVEMENT.dolly_zoom).toBe('变焦推拉');
  });
});

describe('board marks for the new moves', () => {
  const base = standardBoard(STANDARD_SHOTS[4]!);

  test.each(NEW_MOVES)('structure renderer draws a %s group', (m) => {
    const svg = renderBoard(withMove(base, m), 'structure');
    const g = moveGroup(svg, m);
    expect(g.length).toBeGreaterThan(80);
    expect(g).toContain('<path');
  });

  test.each(NEW_MOVES)('pencil renderer draws a %s group inside the overlay layer', (m) => {
    const svg = renderBoard(withMove(base, m), 'pencil');
    const at = svg.indexOf('data-layer="overlay"');
    expect(at).toBeGreaterThan(-1);
    const ov = svg.slice(at);
    expect(ov).toContain(`data-camera-move="${m}"`);
    expect(moveGroup(ov, m)).toContain('<path');
  });

  test('no overlay, no camera-move mark', () => {
    for (const m of NEW_MOVES) {
      expect(renderBoard(withMove(base, m), 'structure', { overlay: false })).not.toContain('data-camera-move');
    }
  });

  test('dolly zoom carries its label; the other two carry no text', () => {
    const dz = moveGroup(renderBoard(withMove(base, 'dolly_zoom'), 'structure'), 'dolly_zoom');
    expect(dz).toContain(`>${ZH_BOARD.dollyZoom}</text>`);
    expect(moveGroup(renderBoard(withMove(base, 'orbit'), 'structure'), 'orbit')).not.toContain('<text');
    expect(moveGroup(renderBoard(withMove(base, 'aerial'), 'structure'), 'aerial')).not.toContain('<text');
    const pen = renderBoard(withMove(base, 'dolly_zoom'), 'pencil');
    expect(moveGroup(pen.slice(pen.indexOf('data-layer="overlay"')), 'dolly_zoom')).toContain(`>${ZH_BOARD.dollyZoom}</text>`);
  });

  test.each(NEW_MOVES)('%s: no style attribute or <style>, greyscale only, deterministic', (m) => {
    for (const mode of ['structure', 'pencil'] as const) {
      const svg = renderBoard(withMove(base, m), mode);
      expect(svg).not.toMatch(/\sstyle=/);
      expect(svg).not.toContain('<style');
      for (const c of colorsOf(svg)) expect(isGray(c) || /^url\(#/.test(c)).toBe(true);
      expect(renderBoard(withMove(base, m), mode)).toBe(svg);
    }
  });

  test('the new marks differ from each other and from push_in', () => {
    const marks = ['push_in', ...NEW_MOVES].map((m) => moveGroup(renderBoard({ ...base, overlay: { ...base.overlay, camera_move: m as never } }, 'structure'), m).replace(/data-camera-move="[^"]*"/, ''));
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe('normalize maps synonyms to the new moves', () => {
  const norm = (v: string) => (normalizeShotFieldsJson({ movement: v }) as { movement: string }).movement;

  test.each([
    ['环绕', 'orbit'],
    ['环拍', 'orbit'],
    ['绕拍', 'orbit'],
    ['arc', 'orbit'],
    ['Arc Shot', 'orbit'],
    ['360', 'orbit'],
    ['orbit', 'orbit'],
    ['航拍', 'aerial'],
    ['无人机', 'aerial'],
    ['drone', 'aerial'],
    ['Aerial shot', 'aerial'],
    ['aerial', 'aerial'],
    ['变焦推拉', 'dolly_zoom'],
    ['滑动变焦', 'dolly_zoom'],
    ['Dolly Zoom', 'dolly_zoom'],
    ['vertigo', 'dolly_zoom'],
    ['zolly', 'dolly_zoom'],
    ['dolly_zoom', 'dolly_zoom'],
  ])('%s → %s', (raw, want) => {
    expect(norm(raw)).toBe(want);
  });

  test('plain "dolly" and "推" still mean what they meant', () => {
    expect(norm('dolly')).toBe('track');
    expect(norm('推')).toBe('push_in');
  });
});

describe('camera_notes normalisation', () => {
  test('a missing camera_notes stays missing', () => {
    const out = normalizeShotFieldsJson({ movement: 'pan' }) as Record<string, unknown>;
    expect('camera_notes' in out).toBe(false);
  });

  test('empty and whitespace-only text becomes null; real text is trimmed', () => {
    const n = (v: unknown) => (normalizeShotFieldsJson({ camera_notes: v }) as { camera_notes: unknown }).camera_notes;
    expect(n('')).toBeNull();
    expect(n('   \n ')).toBeNull();
    expect(n(null)).toBeNull();
    expect(n('  倒退跟拍  ')).toBe('倒退跟拍');
  });

  test('the breakdown normaliser applies it per shot and the schema accepts the result', () => {
    const shot = { ...shotFields({}), source: { paragraph_id: 'p-001', quote: '门开了' } };
    const withNotes = { ...shot, camera_notes: '   ' };
    const { camera_notes: _drop, ...without } = shot as ShotFields;
    const out = normalizeBreakdownJson({ shots: [withNotes, without] }) as { shots: Record<string, unknown>[] };
    expect(out.shots[0]!.camera_notes).toBeNull();
    expect('camera_notes' in out.shots[1]!).toBe(false);
    expect(BreakdownOutput.safeParse(out).success).toBe(true);
  });
});

describe('shot-line parser vocabulary', () => {
  test('3. 全景 航拍 城市 → aerial (not crane)', () => {
    const info = parseShotLine('3. 全景 航拍 城市');
    expect(info).toMatchObject({ code: '3', shot_size: 'FS', movement: 'aerial' });
    const fields = shotFieldsFromLine(info!, { paragraph_id: 'p-001', quote: '3. 全景 航拍 城市' });
    expect(fields.movement).toBe('aerial');
    expect(ShotFields.safeParse(fields).success).toBe(true);
  });

  test.each([
    ['4. 中景 环绕 小林', 'orbit'],
    ['4. 中景 环拍 小林', 'orbit'],
    ['5. 近景 变焦推拉 小林', 'dolly_zoom'],
    ['5. 近景 滑动变焦 小林', 'dolly_zoom'],
    ['6. 中景 升降 小林', 'crane'],
    ['7. 中景 推 小林', 'push_in'],
  ])('%s → %s', (line, want) => {
    expect(parseShotLine(line)?.movement).toBe(want);
  });
});

describe('camera_notes_long warning', () => {
  const ctx = { aliases: [] as string[], technique_ids: [] as string[] };
  const base = shotFields({ narrative_purpose: '交代环境', action: '城市全貌' });
  const codes = (notes: string | null | undefined) => validateShotFieldsBasic({ ...base, camera_notes: notes }, ctx, 2).map((i) => i.code);

  test('301 characters warn, 300 do not', () => {
    const long = validateShotFieldsBasic({ ...base, camera_notes: '拍'.repeat(301) }, ctx, 2).find((i) => i.code === 'camera_notes_long');
    expect(long).toMatchObject({ level: 'warning', item: 2 });
    expect(long?.message).toContain('拍法说明超过 300 字');
    expect(codes('拍'.repeat(300))).not.toContain('camera_notes_long');
  });

  test('absent, null and empty notes never warn', () => {
    for (const v of [undefined, null, '']) expect(codes(v)).not.toContain('camera_notes_long');
  });
});

describe('shot-line: 摇臂 is a crane move, not 摇 + 臂', () => {
  test('3. 全景 摇臂 操场', async () => {
    const { parseShotLine } = await import('../src/script/shot-line.ts');
    expect(parseShotLine('3. 全景 摇臂 操场')?.movement).toBe('crane');
  });
});

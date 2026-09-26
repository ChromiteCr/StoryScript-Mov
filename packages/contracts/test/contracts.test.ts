import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { BoardSpec, BreakdownOutput, SourceRange, ShotFields } from '../src/index.ts';

describe('SourceRange (SPEC §8.3 frozen structure)', () => {
  const good = { stream_index: 0, in_pts: 90000, out_pts: 450000, time_base_num: 1, time_base_den: 90000 };

  test('accepts integer half-open range', () => {
    expect(SourceRange.parse(good)).toEqual(good);
  });

  test('accepts negative PTS (no zero-origin assumption)', () => {
    expect(SourceRange.safeParse({ ...good, in_pts: -1024, out_pts: 0 }).success).toBe(true);
  });

  test.each([
    ['float pts', { ...good, in_pts: 1.5 }],
    ['zero denominator', { ...good, time_base_den: 0 }],
    ['in >= out', { ...good, in_pts: 450000 }],
    ['negative stream', { ...good, stream_index: -1 }],
    ['unsafe integer', { ...good, out_pts: Number.MAX_SAFE_INTEGER + 2 }],
    ['float seconds instead of pts', { stream_index: 0, in_s: 1.0, out_s: 5.0, time_base_num: 1, time_base_den: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(SourceRange.safeParse(value).success).toBe(false);
  });
});

describe('LLM-facing schemas stay provider-portable', () => {
  test('BreakdownOutput converts to JSON schema with an object root', () => {
    const schema = z.toJSONSchema(BreakdownOutput) as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(JSON.stringify(schema)).not.toContain('anyOf":[{"type":"object"');
  });

  test('ShotFields has every key required (nullable instead of optional)', () => {
    const schema = z.toJSONSchema(ShotFields) as { properties: Record<string, unknown>; required: string[] };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
  });
});

describe('BoardSpec', () => {
  test('rejects SVG or HTML smuggled into labels is still just text (schema accepts string, renderer escapes)', () => {
    const spec = {
      version: 1,
      frame: { aspect: '2.39', guides: [] },
      camera: { x: 0, y: 1.6, z: 0, yaw_deg: 0, pitch_deg: 0, roll_deg: 0, focal_mm: 35, sensor_w_mm: 36 },
      scene: { env: 'interior', light: { azimuth_deg: 45, elevation_deg: 40 }, subjects: [], props: [] },
      overlay: {
        labels: [{ id: 'l0', text: '<script>alert(1)</script>', x: 0.1, y: 0.9 }],
        arrows: [],
        camera_move: null,
        offset: { x: 0, y: 0 },
        show_code: true,
      },
      seed: 7,
    };
    expect(BoardSpec.safeParse(spec).success).toBe(true);
  });

  test('rejects unknown version', () => {
    expect(BoardSpec.safeParse({ version: 2 }).success).toBe(false);
  });
});

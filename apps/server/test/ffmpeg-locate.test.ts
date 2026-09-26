import { describe, expect, test } from 'vitest';
import { listEncoders, locateTool, pickH264Encoder, runTool, toolVersion } from '../src/adapters/media/ffmpeg.ts';

const ffmpeg = locateTool('ffmpeg');

describe('ffmpeg adapter', () => {
  test('pickH264Encoder prefers libx264, then videotoolbox, then openh264', () => {
    expect(pickH264Encoder(['libopenh264', 'h264_videotoolbox'])).toBe('h264_videotoolbox');
    expect(pickH264Encoder(['libopenh264'])).toBe('libopenh264');
    expect(pickH264Encoder([])).toBeNull();
  });

  test('explicit override that is not executable resolves to null', () => {
    expect(locateTool('ffmpeg', '/nonexistent/ffmpeg')).toBeNull();
  });

  test.skipIf(!ffmpeg)('locates ffmpeg, reads version and encoders', async () => {
    expect(await toolVersion(ffmpeg)).toMatch(/\d/);
    const enc = await listEncoders(ffmpeg);
    expect(enc.length).toBeGreaterThan(5);
  });

  test.skipIf(!ffmpeg)('never goes through a shell: metacharacters are literal args', async () => {
    const r = await runTool(ffmpeg!, ['-hide_banner', '-i', '$(touch /tmp/pwned);`id`', '-f', 'null', '-'], {
      timeoutMs: 10_000,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('$(touch /tmp/pwned)');
  });
});

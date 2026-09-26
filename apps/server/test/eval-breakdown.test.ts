import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BREAKDOWN_PROMPT_VERSION, ENTITIES_PROMPT_VERSION } from '@storyscript/core';
import { FakeChat } from '../src/adapters/llm/fake-chat.ts';
import { loadReplayRecords, ReplayChat, ReplayRecord } from '../src/adapters/llm/replay-chat.ts';
import { DEMO_CLIENT } from '../src/ai/runtime.ts';
import { reportFileName, runBreakdownEval } from '../src/evaluation/breakdown.ts';
import { FIXTURES, REPLAY_DIR, TEST_KEY } from './helpers/m3-app.ts';

/**
 * scripts/eval-breakdown.ts logic without a real key: the replay recordings of
 * 01-bookshop pass the pre-registered checklist, and --record writes only the
 * model text + prompt version + input hash (no key, no base URL, no model).
 */

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'ssm-eval-'));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

describe('breakdown evaluation', () => {
  test('replay of 01-bookshop passes every checklist item and writes the report', async () => {
    const res = await runBreakdownEval({
      client: DEMO_CLIENT,
      chat: ReplayChat.fromDir(REPLAY_DIR),
      fixturesDir: FIXTURES,
      outDir: out,
      date: '2026-09-26',
      only: ['01-bookshop.txt'],
    });
    expect(res.reportPath).toBe(join(out, 'breakdown-replay-2026-09-26.md'));
    expect(res.scenes).toMatchObject({ passed: 3, total: 3 });
    expect(res.characters.passed).toBe(res.characters.total);
    expect(res.breakdown.passed).toBe(res.breakdown.total);
    expect(res.breakdown.rate).toBe(1);
    expect(res.quotes.located).toBe(res.quotes.total);
    expect(res.quotes.total).toBe(17);
    expect(res.offRoster).toBe(0);
    expect(res.calls).toBe(3); // entities + 2 scenes
    const md = readFileSync(res.reportPath, 'utf8');
    expect(md).toContain('拆镜通过率');
    expect(md).toContain('| 1d |');
    expect(md).not.toContain('未通过');
  });

  test('--record through FakeChat: recordings hold no key / base_url and replay back', async () => {
    const recordings = new ReplayChat(loadReplayRecords(REPLAY_DIR));
    const chat = new FakeChat([], (req) => recordings.complete(req).then((r) => ({ content: r.content })));
    const client = { base_url: 'https://llm.internal.example/v1', api_key: TEST_KEY, model: 'fake/model:1' };
    const recordDir = join(out, 'replay');
    const res = await runBreakdownEval({
      client,
      chat,
      fixturesDir: FIXTURES,
      outDir: out,
      date: '2026-09-26',
      only: ['01-bookshop.txt'],
      recordDir,
    });
    expect(res.reportPath).toBe(join(out, reportFileName(client.model, '2026-09-26')));
    expect(res.reportPath).toContain('breakdown-fake-model-1-2026-09-26.md');
    expect(res.breakdown.rate).toBe(1);
    expect(res.usage.total).toBe(3 * 150);
    expect(res.recorded).toHaveLength(3);
    const files = readdirSync(recordDir);
    expect(files).toHaveLength(3);
    for (const f of files) {
      const text = readFileSync(join(recordDir, f), 'utf8');
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain('llm.internal.example');
      expect(text).not.toContain('fake/model');
      const rec = ReplayRecord.parse(JSON.parse(text));
      expect(rec.origin).toBe('recorded');
      expect([BREAKDOWN_PROMPT_VERSION, ENTITIES_PROMPT_VERSION]).toContain(rec.prompt_version);
    }
    // recorded files answer the same lookups as the handwritten ones
    const replayed = await runBreakdownEval({
      client: DEMO_CLIENT,
      chat: ReplayChat.fromDir(recordDir),
      fixturesDir: FIXTURES,
      outDir: out,
      date: '2026-09-27',
      only: ['01-bookshop.txt'],
    });
    expect(replayed.breakdown.rate).toBe(1);
  });

  test('scripts without recordings fail clearly in replay mode (no fallback, no network)', async () => {
    const res = await runBreakdownEval({
      client: DEMO_CLIENT,
      chat: ReplayChat.fromDir(REPLAY_DIR),
      fixturesDir: FIXTURES,
      outDir: out,
      date: '2026-09-26',
      only: ['02-last-train.fountain'],
    });
    expect(res.scenes.passed).toBe(res.scenes.total);
    expect(res.breakdown.passed).toBe(0);
    expect(res.markdown).toContain('PROVIDER_ERROR');
    expect(res.markdown).toContain('演示模式');
  });
});

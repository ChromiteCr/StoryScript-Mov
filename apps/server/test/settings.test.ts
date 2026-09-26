import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderTestResult, ProvidersView } from '@storyscript/contracts';
import { startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { llmEnv, makeM3App, TEST_KEY, type M3App } from './helpers/m3-app.ts';

/**
 * Text provider settings (SPEC §6): the key is write-only (key_last4 + source
 * only), credentials.json is 0600, env wins over the file, and the connection
 * test is the free GET /models check — never a chat call.
 */

let fake: FakeOpenAI;
let app: M3App | null = null;

beforeEach(async () => {
  fake = await startFakeOpenAI();
});

afterEach(async () => {
  app?.close();
  app = null;
  await fake.close();
});

describe('settings: text provider', () => {
  test('save to credentials.json (0600); responses never carry the key', async () => {
    app = await makeM3App({ openProject: false });
    const saved = await app.put<ProvidersView>('/api/v1/settings/providers/text', { base_url: fake.url, model: 'fake-model', api_key: TEST_KEY });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.data).toEqual({ text: { base_url: fake.url, model: 'fake-model', key_last4: TEST_KEY.slice(-4), source: 'file' }, image: null });
    expect(saved.text).not.toContain(TEST_KEY);
    expect(saved.body.notice).toBeUndefined();

    const file = join(app.stateDir, 'credentials.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).llm).toEqual({ base_url: fake.url, model: 'fake-model', api_key: TEST_KEY });

    // omitted key keeps the stored one; "" clears it
    const kept = await app.put<ProvidersView>('/api/v1/settings/providers/text', { base_url: fake.url, model: 'other-model' });
    expect(kept.data.text).toMatchObject({ model: 'other-model', key_last4: TEST_KEY.slice(-4) });
    const cleared = await app.put<ProvidersView>('/api/v1/settings/providers/text', { base_url: fake.url, model: 'other-model', api_key: '' });
    expect(cleared.data.text?.key_last4).toBeNull();

    const bad = await app.put('/api/v1/settings/providers/text', { base_url: 'not a url', model: 'm' });
    expect(bad.status).toBe(400);
  });

  test('environment variables win: source=env and a notice on save', async () => {
    app = await makeM3App({ openProject: false, env: llmEnv(fake.url) });
    const view = await app.get<ProvidersView>('/api/v1/settings/providers');
    expect(view.data.text).toEqual({ base_url: fake.url, model: 'fake-model', key_last4: TEST_KEY.slice(-4), source: 'env' });
    const saved = await app.put<ProvidersView>('/api/v1/settings/providers/text', {
      base_url: 'https://api.example.com/v1',
      model: 'file-model',
      api_key: 'sk-file-key-000000000000',
    });
    expect(saved.status).toBe(200);
    expect(saved.data.text?.source).toBe('env');
    expect(saved.data.text?.base_url).toBe(fake.url);
    expect(saved.body.notice).toContain('环境变量');
    expect(saved.text).not.toContain('sk-file-key-000000000000');
  });

  test('connection test is a free GET /models (no chat call, key never echoed)', async () => {
    app = await makeM3App({ openProject: false, env: llmEnv(fake.url) });
    const ok = await app.post<ProviderTestResult>('/api/v1/settings/providers/text/test');
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ ok: true, models_endpoint: true, model_listed: true });
    expect(ok.text).not.toContain(TEST_KEY);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models', authorization: `Bearer ${TEST_KEY}` });

    fake.models = ['something-else'];
    const notListed = await app.post<ProviderTestResult>('/api/v1/settings/providers/text/test');
    expect(notListed.data).toMatchObject({ ok: false, models_endpoint: true, model_listed: false });

    fake.models = null;
    const no = await app.post<ProviderTestResult>('/api/v1/settings/providers/text/test');
    expect(no.data).toMatchObject({ ok: false, models_endpoint: false, model_listed: null });
    expect(fake.chatRequests()).toHaveLength(0);
  });

  test('connection test against an unreachable host reports without leaking the key', async () => {
    app = await makeM3App({ openProject: false, env: llmEnv('http://127.0.0.1:9/v1') });
    const res = await app.post<ProviderTestResult>('/api/v1/settings/providers/text/test');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: false, models_endpoint: false });
    expect(res.text).not.toContain(TEST_KEY);
  });

  test('demo mode never sends anything', async () => {
    app = await makeM3App({ openProject: false, demo: true, env: llmEnv(fake.url) });
    const res = await app.post<ProviderTestResult>('/api/v1/settings/providers/text/test');
    expect(res.data.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

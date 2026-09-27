import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { contentHash, normalizeForMatch } from '@storyscript/core';
import { ChatError, type ChatPort, type ChatRequest, type ChatResponse } from './chat.ts';

/**
 * ReplayChat — answers from recorded model outputs (fixtures/replay/*.json)
 * keyed by (prompt_version, replay key). Used by --demo and E2E: it never
 * opens a network connection. A missing recording is a clear, non-retryable
 * error instead of a silent fallback.
 *
 * Recordings hold only the model output text, the prompt version and a hash of
 * the scene heading / script text — never keys, base URLs or model ids.
 */

export const ReplayRecord = z
  .object({
    format: z.literal('storyscript-replay-v1'),
    prompt_version: z.string().min(1),
    key: z.string().min(1),
    origin: z.enum(['handwritten', 'recorded']).optional(),
    /** raw model output text (recorded) */
    output: z.string().optional(),
    /** or the output as JSON (handwritten, reviewable) */
    output_json: z.unknown().optional(),
  })
  .refine((r) => r.output !== undefined || r.output_json !== undefined, { message: 'output or output_json required' });
export type ReplayRecord = z.infer<typeof ReplayRecord>;

/** Replay key of one scene: hash of the normalised heading. */
export function sceneReplayKey(heading: string): string {
  return contentHash(['scene', normalizeForMatch(heading)]);
}

/** Replay key of a whole script (entity extraction): hash of the normalised paragraph texts. */
export function scriptReplayKey(paragraphs: readonly { text: string }[]): string {
  return contentHash(['script', paragraphs.map((p) => normalizeForMatch(p.text))]);
}

/**
 * Replay key of a shooting-order suggestion: the setups as the prompt lists
 * them, key and normalised label in prompt order. The model names setups only
 * by these positional keys (u1 …), so a recording means the same thing only
 * for the same key → setup pairing; after a reorder the lookup misses instead
 * of replaying a stale order. Date, times and durations stay out, like the
 * scene key leaves out everything but the heading, so the demo day replays
 * on whatever date it is seeded.
 */
export function orderReplayKey(setups: readonly { key: string; label: string }[]): string {
  return contentHash(['order', setups.map((s) => [s.key, normalizeForMatch(s.label)])]);
}

/** fixtures/replay in a source checkout (or under the current directory). */
export function resolveReplayDir(): string {
  const candidates = [
    fileURLToPath(new URL('../../../../../fixtures/replay', import.meta.url)),
    resolve(process.cwd(), 'fixtures', 'replay'),
  ];
  return candidates.find((d) => existsSync(d)) ?? candidates[0]!;
}

export function loadReplayRecords(dir: string): ReplayRecord[] {
  if (!existsSync(dir)) return [];
  const out: ReplayRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = ReplayRecord.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // unreadable recordings are skipped; a lookup miss reports clearly
    }
  }
  return out;
}

export function replayOutputText(r: ReplayRecord): string {
  return r.output ?? JSON.stringify(r.output_json);
}

/** Write one recording (eval --record). Returns the file path. */
export function writeReplayRecord(dir: string, rec: { prompt_version: string; key: string; output: string; label?: string }): string {
  mkdirSync(dir, { recursive: true });
  const record: ReplayRecord = { format: 'storyscript-replay-v1', prompt_version: rec.prompt_version, key: rec.key, origin: 'recorded', output: rec.output };
  const safeLabel = (rec.label ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const file = join(dir, `${safeLabel ? `${safeLabel}.` : ''}${rec.prompt_version}.${rec.key.slice(0, 12)}.json`);
  writeFileSync(file, `${JSON.stringify(ReplayRecord.parse(record), null, 2)}\n`);
  return file;
}

export class ReplayChat implements ChatPort {
  readonly kind = 'replay' as const;
  readonly requests: ChatRequest[] = [];
  private readonly index = new Map<string, ReplayRecord>();

  constructor(records: readonly ReplayRecord[]) {
    for (const r of records) this.index.set(`${r.prompt_version}|${r.key}`, r);
  }

  static fromDir(dir: string = resolveReplayDir()): ReplayChat {
    return new ReplayChat(loadReplayRecords(dir));
  }

  get size(): number {
    return this.index.size;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    if (req.signal?.aborted) throw new ChatError('abort', '请求已取消');
    const pv = req.meta?.prompt_version;
    const key = req.meta?.replay_key;
    const rec = pv && key ? this.index.get(`${pv}|${key}`) : undefined;
    if (!rec) {
      throw new ChatError(
        'replay_miss',
        `演示模式没有这段输入的录制输出（${pv ?? '未知提示词版本'}）。演示模式不会外发请求：请使用内置样例剧本 01-bookshop，或配置文本模型后再试`,
      );
    }
    return { content: replayOutputText(rec), finish_reason: 'stop', refusal: null, usage: null };
  }
}

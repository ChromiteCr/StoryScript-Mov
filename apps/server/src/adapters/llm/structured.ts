import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import type { StructuredMode } from '@storyscript/contracts';
import type { CapabilityCache } from '../../config/capability-cache.ts';
import { ChatError, type ChatPort, type ChatRequestMeta, type ChatResponse, type LlmMessage, type ResponseFormat, type TextClientConfig } from './chat.ts';
import { parseModelJson, toStrictJsonSchema, zodIssuesForRepair } from './json.ts';
import { OpenAIChat } from './openai-chat.ts';
import { redactSecrets } from './redact.ts';

/**
 * structuredCall — one "step" of structured LLM output (SPEC FR-03, AGENTS.md):
 *
 *   capability ladder  json_schema → json_object (schema in the system prompt) → prompt_only,
 *                      cached per base_url+model; the 400 that reveals a missing
 *                      capability counts as an outbound attempt
 *   every outbound request counts: network error, 429, 5xx, empty content,
 *   JSON parse failure, zod failure, business-validation failure — at most
 *   `maxAttempts` (3) in total. 429 waits for Retry-After (≤30 s). A
 *   finish_reason=length stops immediately (asking for a smaller scope).
 *   repair round: the previous raw output and its error list go back to the
 *   model as assistant + user messages.
 *   refine round (S4c, optional): a valid output the caller still has hints
 *   for goes back once more, if an attempt is left. The answer replaces the
 *   original only when it parses, validates and the caller says it is better;
 *   any failure of that round keeps the original (it is not retried).
 *
 * Keys never appear in results, errors or logs.
 */

export type StructuredErrorCode =
  | 'ATTEMPTS_EXHAUSTED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_REFUSED'
  | 'CANCELLED';

export interface StructuredError {
  code: StructuredErrorCode;
  message: string;
  retryable: boolean;
  /** HTTP status of the last provider error, when there was one */
  status?: number | null;
}

export interface StructuredUsage {
  prompt: number;
  completion: number;
  total: number;
  /** responses that carried no usage block ("未知") */
  unknown_calls: number;
}

export interface StructuredRefineOutcome {
  hints: string[];
  adopted: boolean;
  /** why the refined answer was not kept (null when adopted) */
  reason: string | null;
}

export interface StructuredCallResult<T> {
  value?: T;
  /** raw text `value` was parsed from (after a rejected refine round it is not the last raw output) */
  value_raw?: string;
  /** S4c: the refine round, when one was sent */
  refine?: StructuredRefineOutcome;
  /** last zod-valid output that still failed business validation */
  last_parsed?: T;
  /** business-validation errors of `last_parsed` */
  last_errors?: string[];
  attempts: number;
  raw_outputs: string[];
  usage: StructuredUsage;
  mode: StructuredMode;
  error?: StructuredError;
}

export interface StructuredCallOptions<T> {
  client: TextClientConfig;
  /** transport; defaults to OpenAIChat(client) */
  chat?: ChatPort;
  messages: readonly LlmMessage[];
  schema: z.ZodType<T>;
  jsonSchemaName: string;
  /** lenient pre-normalisation before zod (enum case, missing nullables …) */
  preprocess?: (raw: unknown) => unknown;
  /** business validation; errors are fed back in the repair round */
  validate?: (parsed: T) => { ok: boolean; errors: string[] };
  signal?: AbortSignal;
  maxAttempts?: number;
  capabilityCache?: CapabilityCache;
  meta?: ChatRequestMeta;
  /** called right before each outbound attempt (1-based) */
  onAttempt?: (attempt: number) => void;
  /** injectable for tests */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** base backoff for 5xx / network errors, multiplied by the attempt number */
  backoffMs?: number;
  /**
   * provider-specific body fields (S3 web search). A 400/422 while they are
   * sent drops them for the next attempt (still counted), unless the error is
   * clearly about response_format.
   */
  extraBody?: Record<string, unknown> | null;
  /**
   * S4c: hints for one more round on a valid output (empty: done). Sent only
   * while an attempt is left; at most one refine round per call.
   */
  refine?: (value: T) => string[];
  /** whether the refined output should replace the original (default: any valid one does) */
  refineBetter?: (refined: T, original: T) => boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_RETRY_AFTER_MS = 30_000;
export const DEFAULT_RETRY_AFTER_MS = 2_000;
const DEFAULT_BACKOFF_MS = 500;
const MAX_RAW_ECHO = 20_000;

/** 400/422 bodies that mean "this response_format is not supported". */
const FORMAT_UNSUPPORTED = /response_format|json_schema|json_object|structured output|schema|not supported|unsupported|unavailable|invalid.{0,20}(type|format)/i;
/** 400 bodies that clearly mean something else (do not downgrade). */
/** 400 bodies that are plainly about response_format (keep the extra body, downgrade the format). */
const FORMAT_ONLY = /response_format|json_schema|json_object|structured output/i;
const OTHER_BAD_REQUEST = /context length|context window|maximum context|too many tokens|max_tokens|model.{0,30}(not found|does not exist|not exist)|api key|authentication|quota|balance|insufficient/i;

export function isFormatUnsupported(message: string): boolean {
  return FORMAT_UNSUPPORTED.test(message) || !OTHER_BAD_REQUEST.test(message);
}

const defaultSleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });

function nextMode(mode: StructuredMode): StructuredMode {
  return mode === 'json_schema' ? 'json_object' : 'prompt_only';
}

function withSchemaInstruction(messages: readonly LlmMessage[], schemaText: string): LlmMessage[] {
  const instruction = `只输出 JSON，符合以下 JSON Schema：\n${schemaText}`;
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === 'system');
  if (sys) sys.content = `${sys.content}\n\n${instruction}`;
  else out.unshift({ role: 'system', content: instruction });
  return out;
}

function repairMessages(raw: string, errors: readonly string[]): LlmMessage[] {
  const echoed = raw.length > MAX_RAW_ECHO ? `${raw.slice(0, MAX_RAW_ECHO)}…` : raw;
  return [
    { role: 'assistant', content: echoed },
    {
      role: 'user',
      content: `上一次输出有以下问题：\n${errors.map((e) => `- ${e}`).join('\n')}\n\n请只输出修正后的完整 JSON，不要输出解释或代码块标记。`,
    },
  ];
}

function refineMessages(raw: string, hints: readonly string[]): LlmMessage[] {
  const echoed = raw.length > MAX_RAW_ECHO ? `${raw.slice(0, MAX_RAW_ECHO)}…` : raw;
  return [
    { role: 'assistant', content: echoed },
    {
      role: 'user',
      content: `上一次输出可以用，但还可以改进：\n${hints.map((h) => `- ${h}`).join('\n')}\n\n请在保留原有剧情内容、台词和出处原文的前提下调整这些地方，只输出调整后的完整 JSON，不要输出解释或代码块标记。`,
    },
  ];
}

export async function structuredCall<T>(opts: StructuredCallOptions<T>): Promise<StructuredCallResult<T>> {
  const { client, schema, signal } = opts;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep ?? defaultSleep;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const secrets = [client.api_key];
  const usage: StructuredUsage = { prompt: 0, completion: 0, total: 0, unknown_calls: 0 };
  const raw_outputs: string[] = [];
  const cache = opts.capabilityCache;
  let mode: StructuredMode = cache?.get(client.base_url, client.model) ?? 'json_schema';
  let attempts = 0;
  let repair: LlmMessage[] = [];
  let lastProblem = '';
  let last_parsed: T | undefined;
  let last_errors: string[] | undefined;
  let extraBody = opts.extraBody && Object.keys(opts.extraBody).length ? opts.extraBody : null;

  const result = (extra: Partial<StructuredCallResult<T>>): StructuredCallResult<T> => ({
    attempts,
    raw_outputs,
    usage,
    mode,
    ...(last_parsed !== undefined ? { last_parsed, last_errors } : {}),
    ...extra,
  });
  const fail = (code: StructuredErrorCode, message: string, retryable = false, status: number | null = null) =>
    result({ error: { code, message: redactSecrets(message, secrets), retryable, status } });
  const cancelled = () => fail('CANCELLED', '已取消');

  const chat = opts.chat ?? (client.base_url && client.model && client.api_key ? new OpenAIChat(client) : null);
  if (!chat || !client.base_url || !client.model) {
    return fail('PROVIDER_NOT_CONFIGURED', '尚未配置文本模型（base_url、api_key、model）');
  }

  const schemaJson = toStrictJsonSchema(schema);
  const schemaText = JSON.stringify(schemaJson);

  const wait = async (ms: number): Promise<boolean> => {
    try {
      await sleep(ms, signal);
      return true;
    } catch {
      return false;
    }
  };

  /** one outbound request in the current mode: the step's messages plus `tail` */
  const send = (tail: readonly LlmMessage[]) => {
    const base = mode === 'json_schema' ? opts.messages.map((m) => ({ ...m })) : withSchemaInstruction(opts.messages, schemaText);
    const response_format: ResponseFormat | undefined =
      mode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: opts.jsonSchemaName, strict: true, schema: schemaJson } }
        : mode === 'json_object'
          ? { type: 'json_object' }
          : undefined;
    attempts++;
    opts.onAttempt?.(attempts);
    return chat.complete({
      model: client.model,
      messages: [...base, ...tail],
      ...(response_format ? { response_format } : {}),
      ...(extraBody ? { extra_body: extraBody } : {}),
      signal,
      meta: opts.meta,
    });
  };

  const addUsage = (res: ChatResponse) => {
    if (res.usage) {
      usage.prompt += res.usage.prompt_tokens ?? 0;
      usage.completion += res.usage.completion_tokens ?? 0;
      usage.total += res.usage.total_tokens ?? (res.usage.prompt_tokens ?? 0) + (res.usage.completion_tokens ?? 0);
    } else {
      usage.unknown_calls++;
    }
  };

  /** zod + business validation of one raw output; the parsed value or what is wrong with it */
  const check = (content: string): { ok: true; value: T } | { ok: false; problem: string; errors: string[]; parsed?: T } => {
    let json: unknown;
    try {
      json = parseModelJson(content);
    } catch (err) {
      const problem = (err as Error).message;
      return { ok: false, problem, errors: [problem] };
    }
    const parsed = schema.safeParse(opts.preprocess ? opts.preprocess(json) : json);
    if (!parsed.success) {
      const errors = zodIssuesForRepair(parsed.error);
      return { ok: false, problem: `输出不符合 JSON Schema：${errors.slice(0, 3).join('；')}`, errors };
    }
    if (opts.validate) {
      const v = opts.validate(parsed.data);
      if (!v.ok) return { ok: false, problem: `输出未通过校验：${v.errors.slice(0, 3).join('；')}`, errors: v.errors, parsed: parsed.data };
    }
    return { ok: true, value: parsed.data };
  };

  /**
   * The optional refine round on a valid output: one request, never
   * repaired or retried. Anything short of a valid, better answer keeps the
   * original; only cancellation ends the step without a value.
   */
  const finish = async (value: T, raw: string): Promise<StructuredCallResult<T>> => {
    if (cache && cache.get(client.base_url, client.model) !== mode) cache.set(client.base_url, client.model, mode);
    const hints = opts.refine && attempts < maxAttempts ? opts.refine(value) : [];
    if (hints.length === 0) return result({ value, value_raw: raw });
    if (signal?.aborted) return cancelled();
    const keep = (reason: string) => result({ value, value_raw: raw, refine: { hints, adopted: false, reason: redactSecrets(reason, secrets) } });
    let res;
    try {
      res = await send(refineMessages(raw, hints));
    } catch (err) {
      const ce = err instanceof ChatError ? err : new ChatError('network', err instanceof Error ? err.message : String(err));
      if (ce.kind === 'abort' || signal?.aborted) return cancelled();
      return keep(ce.kind === 'http' && ce.status !== null ? `调整这一轮请求失败（HTTP ${ce.status}）` : `调整这一轮请求失败：${ce.message}`);
    }
    addUsage(res);
    const content = res.content ?? '';
    raw_outputs.push(content);
    if (signal?.aborted) return cancelled();
    if ((res.refusal && res.refusal.trim()) || res.finish_reason === 'content_filter') return keep('模型拒绝了调整');
    if (res.finish_reason === 'length') return keep('调整后的输出被截断');
    if (!content.trim()) return keep('调整后模型返回了空内容');
    const c = check(content);
    if (!c.ok) return keep(c.problem);
    if (opts.refineBetter && !opts.refineBetter(c.value, value)) return keep('调整后的结果没有更好');
    return result({ value: c.value, value_raw: content, refine: { hints, adopted: true, reason: null } });
  };

  while (attempts < maxAttempts) {
    if (signal?.aborted) return cancelled();
    let res;
    try {
      res = await send(repair);
    } catch (err) {
      const ce = err instanceof ChatError ? err : new ChatError('network', err instanceof Error ? err.message : String(err));
      if (ce.kind === 'abort' || signal?.aborted) return cancelled();
      if (ce.kind === 'replay_miss') return fail('PROVIDER_ERROR', ce.message);
      if (ce.kind === 'http' && ce.status !== null) {
        const s = ce.status;
        if ((s === 400 || s === 422) && extraBody && !FORMAT_ONLY.test(ce.message)) {
          lastProblem = `服务不接受联网搜索参数（HTTP ${s}），已改为不联网`;
          extraBody = null;
          continue;
        }
        if ((s === 400 || s === 422) && mode !== 'prompt_only' && isFormatUnsupported(ce.message)) {
          const next = nextMode(mode);
          lastProblem = `服务不支持 ${mode}（HTTP ${s}），已改用 ${next}`;
          mode = next;
          cache?.set(client.base_url, client.model, next);
          continue;
        }
        if (s === 429) {
          lastProblem = '服务限流（HTTP 429）';
          if (attempts < maxAttempts) {
            const ms = Math.min(Math.max(ce.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, 0), MAX_RETRY_AFTER_MS);
            if (!(await wait(ms))) return cancelled();
          }
          continue;
        }
        if (s >= 500) {
          lastProblem = `服务端错误（HTTP ${s}）`;
          if (attempts < maxAttempts && !(await wait(backoff * attempts))) return cancelled();
          continue;
        }
        if (s === 401 || s === 403) return fail('PROVIDER_ERROR', `密钥无效或没有权限（HTTP ${s}）：${ce.message}`, false, s);
        return fail('PROVIDER_ERROR', `模型服务拒绝了请求（HTTP ${s}）：${ce.message}`, false, s);
      }
      lastProblem = ce.kind === 'timeout' ? '请求超时' : ce.message;
      if (attempts < maxAttempts && !(await wait(backoff * attempts))) return cancelled();
      continue;
    }

    addUsage(res);
    const content = res.content ?? '';
    raw_outputs.push(content);
    if (res.refusal && res.refusal.trim()) return fail('PROVIDER_REFUSED', `模型拒绝回答：${res.refusal.trim()}`);
    if (res.finish_reason === 'content_filter') return fail('PROVIDER_REFUSED', '模型输出被内容过滤拦截');
    if (res.finish_reason === 'length') {
      return fail('PROVIDER_ERROR', '模型输出达到长度上限被截断：请缩小范围（减少镜头数量上限或拆分场景）后重试');
    }
    if (!content.trim()) {
      lastProblem = '模型返回了空内容';
      continue;
    }

    const c = check(content);
    if (!c.ok) {
      if (c.parsed !== undefined) {
        last_parsed = c.parsed;
        last_errors = c.errors;
      }
      lastProblem = c.problem;
      repair = repairMessages(content, c.errors);
      continue;
    }
    return finish(c.value, content);
  }

  return fail('ATTEMPTS_EXHAUSTED', `已外发 ${attempts} 次仍未得到合格输出（最后一次：${lastProblem || '未知原因'}）`, true);
}

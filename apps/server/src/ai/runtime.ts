import type { ChatPort, TextClientConfig } from '../adapters/llm/chat.ts';
import { OpenAIChat } from '../adapters/llm/openai-chat.ts';
import { ReplayChat, resolveReplayDir } from '../adapters/llm/replay-chat.ts';
import { FileCapabilityCache, MemoryCapabilityCache, type CapabilityCache } from '../config/capability-cache.ts';
import { textClientConfig } from '../config/text-provider.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { jobQueueFor, type JobQueue } from '../jobs/queue.ts';
import type { OpenedProject } from '../project/project.ts';

/**
 * Per-app AI wiring without touching AppDeps: tests and --demo swap the
 * transport through `configureAi(handle.deps, …)`.
 *
 *   demo mode → ReplayChat over fixtures/replay (no network, job.remote=false)
 *   otherwise → text provider from env / credentials.json → OpenAIChat
 *               (or the injected chat factory); missing config → 409
 *               PROVIDER_NOT_CONFIGURED before anything is sent.
 */

export interface AiOverrides {
  /** transport factory (FakeChat in tests); receives the resolved client config */
  chat?: (cfg: TextClientConfig) => ChatPort;
  capabilityCache?: CapabilityCache;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  backoffMs?: number;
  /** recordings used in demo mode */
  replayDir?: string;
}

export interface AiClient {
  cfg: TextClientConfig;
  chat: ChatPort;
  capabilityCache: CapabilityCache;
  /** true when requests leave the machine (paid, never auto-resent) */
  remote: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  backoffMs?: number;
}

const overrides = new WeakMap<AppDeps, AiOverrides>();
const fileCaches = new WeakMap<AppDeps, CapabilityCache>();
const replayChats = new WeakMap<AppDeps, ReplayChat>();

export function configureAi(deps: AppDeps, o: AiOverrides): void {
  overrides.set(deps, { ...overrides.get(deps), ...o });
  replayChats.delete(deps);
}

export const DEMO_CLIENT: TextClientConfig = { base_url: 'replay://fixtures', api_key: '', model: 'replay' };

/** Resolve the text model for an AI route, or throw PROVIDER_NOT_CONFIGURED. */
export function resolveAi(deps: AppDeps): AiClient {
  const o = overrides.get(deps) ?? {};
  if (deps.demo) {
    let chat = replayChats.get(deps);
    if (!chat) {
      chat = ReplayChat.fromDir(o.replayDir ?? resolveReplayDir());
      replayChats.set(deps, chat);
    }
    return { cfg: DEMO_CLIENT, chat, capabilityCache: new MemoryCapabilityCache(), remote: false, sleep: o.sleep, backoffMs: o.backoffMs };
  }
  const cfg = textClientConfig(deps.stateDir, deps.env);
  if (!cfg) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', '尚未配置文本模型：请在设置中填写 base_url、API key 和模型名（或设置 STORYSCRIPT_LLM_* 环境变量）', 409);
  }
  let cache = o.capabilityCache ?? fileCaches.get(deps);
  if (!cache) {
    cache = new FileCapabilityCache(deps.stateDir);
    fileCaches.set(deps, cache);
  }
  return {
    cfg,
    chat: o.chat ? o.chat(cfg) : new OpenAIChat(cfg),
    capabilityCache: cache,
    remote: true,
    sleep: o.sleep,
    backoffMs: o.backoffMs,
  };
}

/** Open project + its job queue. */
export function projectContext(deps: AppDeps): { project: OpenedProject; jobs: JobQueue } {
  const project = deps.projectSession.require();
  return { project, jobs: jobQueueFor(project, project.db) };
}

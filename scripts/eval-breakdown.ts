/**
 * Breakdown evaluation against fixtures/scripts/expected.json.
 *
 *   npx tsx scripts/eval-breakdown.ts            real model from STORYSCRIPT_LLM_*
 *   npx tsx scripts/eval-breakdown.ts --record   also save raw outputs to fixtures/replay/
 *   npx tsx scripts/eval-breakdown.ts --replay   offline: recorded outputs only (no network)
 *
 * Writes docs/eval/breakdown-<model>-<YYYY-MM-DD>.md. Without STORYSCRIPT_LLM_*
 * it explains what to set and exits 0.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenAIChat } from '../apps/server/src/adapters/llm/openai-chat.ts';
import { ReplayChat } from '../apps/server/src/adapters/llm/replay-chat.ts';
import { DEMO_CLIENT } from '../apps/server/src/ai/runtime.ts';
import { runBreakdownEval } from '../apps/server/src/evaluation/breakdown.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const MISSING_ENV_HELP = `未设置文本模型，跳过拆镜评测。
需要三个环境变量（key 只在本机使用，不会写进报告或录制文件）：
  STORYSCRIPT_LLM_BASE_URL   例如 https://api.example.com/v1（OpenAI chat completions 兼容）
  STORYSCRIPT_LLM_API_KEY
  STORYSCRIPT_LLM_MODEL
然后运行：npx tsx scripts/eval-breakdown.ts [--record]
不联网的演示：npx tsx scripts/eval-breakdown.ts --replay（只有 01-bookshop 有录制）`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      record: { type: 'boolean', default: false },
      replay: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const env = process.env;
  const base_url = env.STORYSCRIPT_LLM_BASE_URL?.trim();
  const api_key = env.STORYSCRIPT_LLM_API_KEY?.trim();
  const model = env.STORYSCRIPT_LLM_MODEL?.trim();
  let client;
  let chat;
  if (values.replay) {
    client = DEMO_CLIENT;
    chat = ReplayChat.fromDir(join(ROOT, 'fixtures', 'replay'));
  } else {
    if (!base_url || !api_key || !model) {
      console.log(MISSING_ENV_HELP);
      return 0;
    }
    client = { base_url, api_key, model };
    chat = new OpenAIChat(client);
  }
  const date = new Date().toLocaleDateString('sv-SE');
  const result = await runBreakdownEval({
    client,
    chat,
    fixturesDir: join(ROOT, 'fixtures', 'scripts'),
    outDir: values.out ?? join(ROOT, 'docs', 'eval'),
    date,
    recordDir: values.record && !values.replay ? join(ROOT, 'fixtures', 'replay') : null,
    log: (line) => console.log(line),
  });
  console.log(`\n拆镜通过率 ${result.breakdown.passed}/${result.breakdown.total}（${(result.breakdown.rate * 100).toFixed(1)}%），外发 ${result.calls} 次`);
  console.log(`报告：${result.reportPath}`);
  if (result.recorded.length) console.log(`录制：${result.recorded.length} 个文件写入 fixtures/replay/`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`评测失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);

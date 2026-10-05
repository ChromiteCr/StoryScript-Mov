import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BreakdownOutput, EntitiesOutput, ScriptFormat, type ShotFields } from '@storyscript/contracts';
import {
  analyzeVariety,
  breakdownPromptVersion,
  breakdownRepairErrors,
  breakdownSummary,
  buildBreakdownMessages,
  buildEntitiesMessages,
  ENTITIES_PROMPT_VERSION,
  normalizeBreakdownJson,
  normalizeEntitiesJson,
  parseScript,
  scoreCharacters,
  scoreScenes,
  scoreSceneBreakdown,
  summarize,
  TECHNIQUES,
  validateBreakdown,
  type CheckResult,
  type ExpectedChecklist,
  type SceneBreakdownScore,
} from '@storyscript/core';
import type { ChatPort, TextClientConfig } from '../adapters/llm/chat.ts';
import { sceneReplayKey, scriptReplayKey, writeReplayRecord } from '../adapters/llm/replay-chat.ts';
import { structuredCall, type StructuredCallResult, type StructuredUsage } from '../adapters/llm/structured.ts';
import { breakdownRefine } from '../ai/jobs.ts';
import { MemoryCapabilityCache, type CapabilityCache } from '../config/capability-cache.ts';

/**
 * Breakdown evaluation against the pre-registered checklist
 * (fixtures/scripts/expected.json). For every script: rule-based split →
 * entity extraction → per-scene breakdown (all built-in techniques allowed) →
 * automatic scoring → docs/eval/breakdown-<model>-<date>.md.
 * With `record`, successful raw outputs are saved to fixtures/replay (model
 * text + prompt version + input hash only — no key, base URL or model id).
 */

export const EVAL_MAX_SHOTS = 16;

export interface EvalOptions {
  client: TextClientConfig;
  chat: ChatPort;
  fixturesDir: string;
  outDir: string;
  /** YYYY-MM-DD, used in the report file name */
  date: string;
  recordDir?: string | null;
  capabilityCache?: CapabilityCache;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  backoffMs?: number;
  /** only these fixture files (default: all in expected.json) */
  only?: string[];
  /**
   * ask breakdown-v1 like --demo, the version the replay recordings answer
   * (default: when the transport is a ReplayChat). Otherwise the product's
   * request: breakdown-v3 with its refine round (S4c).
   */
  demo?: boolean;
  log?: (line: string) => void;
}

interface ScriptResult {
  file: string;
  sceneChecks: CheckResult[];
  characterChecks: CheckResult[];
  breakdown: SceneBreakdownScore[];
  failures: string[];
}

export interface EvalResult {
  reportPath: string;
  markdown: string;
  breakdown: ReturnType<typeof summarize>;
  scenes: ReturnType<typeof summarize>;
  characters: ReturnType<typeof summarize>;
  calls: number;
  usage: StructuredUsage;
  quotes: { located: number; total: number };
  offRoster: number;
  recorded: string[];
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function reportFileName(model: string, date: string): string {
  return `breakdown-${model.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}-${date}.md`;
}

export async function runBreakdownEval(opts: EvalOptions): Promise<EvalResult> {
  const log = opts.log ?? (() => undefined);
  const checklist = JSON.parse(readFileSync(join(opts.fixturesDir, 'expected.json'), 'utf8')) as ExpectedChecklist;
  const cache = opts.capabilityCache ?? new MemoryCapabilityCache();
  const usage: StructuredUsage = { prompt: 0, completion: 0, total: 0, unknown_calls: 0 };
  let calls = 0;
  const recorded: string[] = [];
  const techniques = TECHNIQUES.map((t) => ({ id: t.id, name: t.name, shot_grammar: t.shot_grammar }));
  const demo = opts.demo ?? opts.chat.kind === 'replay';
  const breakdownVersion = breakdownPromptVersion({ demo });
  const variety: { score: number; severe: boolean; refined: boolean }[] = [];

  const account = <T>(res: StructuredCallResult<T>) => {
    calls += res.attempts;
    usage.prompt += res.usage.prompt;
    usage.completion += res.usage.completion;
    usage.total += res.usage.total;
    usage.unknown_calls += res.usage.unknown_calls;
  };
  const record = (prompt_version: string, key: string, label: string, res: StructuredCallResult<unknown>) => {
    const raw = res.value_raw ?? res.raw_outputs.at(-1);
    if (!opts.recordDir || raw === undefined || (res.value === undefined && res.last_parsed === undefined)) return;
    recorded.push(writeReplayRecord(opts.recordDir, { prompt_version, key, output: raw, label }));
  };
  const common = {
    client: opts.client,
    chat: opts.chat,
    capabilityCache: cache,
    maxAttempts: 3,
    sleep: opts.sleep,
    backoffMs: opts.backoffMs,
  };

  const results: ScriptResult[] = [];
  for (const exp of checklist.scripts) {
    if (opts.only && !opts.only.includes(exp.file)) continue;
    const stem = basename(exp.file).replace(/\.[^.]+$/, '');
    log(`— ${exp.file}`);
    const text = readFileSync(join(opts.fixturesDir, exp.file), 'utf8');
    const parsed = parseScript(text, ScriptFormat.parse(exp.format), []);
    const failures: string[] = [];

    const entityKey = scriptReplayKey(parsed.paragraphs);
    const ent = await structuredCall({
      ...common,
      messages: buildEntitiesMessages(parsed.paragraphs),
      schema: EntitiesOutput,
      jsonSchemaName: 'entities',
      preprocess: normalizeEntitiesJson,
      meta: { prompt_version: ENTITIES_PROMPT_VERSION, replay_key: entityKey },
    });
    account(ent);
    record(ENTITIES_PROMPT_VERSION, entityKey, stem, ent);
    if (ent.error) failures.push(`实体抽取：${ent.error.code} ${ent.error.message}`);
    const entities = ent.value ?? null;
    const roster = (entities?.characters ?? []).map((c, i) => ({ alias: `c${i + 1}`, name: c.name, aliases: c.aliases }));
    const aliases = roster.map((r) => r.alias);

    const scores: SceneBreakdownScore[] = [];
    for (const [idx, scene] of parsed.scenes.entries()) {
      const ids = new Set(scene.paragraph_ids);
      const paragraphs = parsed.paragraphs.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, text: p.text }));
      const vctx = { paragraphs, aliases, technique_ids: techniques.map((t) => t.id), max_shots: EVAL_MAX_SHOTS };
      const key = sceneReplayKey(scene.heading);
      const res = await structuredCall({
        ...common,
        messages: buildBreakdownMessages({
          scene: { display_no: scene.display_no, heading: scene.heading },
          paragraphs,
          roster,
          techniques,
          preferred_technique_id: null,
          reference_note: null,
          frame_format: '2.39',
          max_shots: EVAL_MAX_SHOTS,
          target_seconds: null,
          demo,
        }),
        schema: BreakdownOutput,
        jsonSchemaName: 'breakdown',
        preprocess: normalizeBreakdownJson,
        validate: (p) => {
          const v = validateBreakdown(p, vctx);
          return { ok: v.error_count === 0, errors: breakdownRepairErrors(v) };
        },
        ...(demo ? {} : breakdownRefine),
        meta: { prompt_version: breakdownVersion, replay_key: key },
      });
      account(res);
      record(breakdownVersion, key, `${stem}.scene-${idx + 1}`, res);
      if (res.error) failures.push(`场 ${scene.display_no}：${res.error.code} ${res.error.message}`);
      const shots: ShotFields[] = res.value?.shots ?? res.last_parsed?.shots ?? [];
      if (shots.length) {
        const v = analyzeVariety(shots);
        variety.push({ score: v.score, severe: v.severe, refined: res.refine?.adopted ?? false });
      }
      const expected = exp.breakdown.find((b) => b.scene === scene.display_no);
      if (expected) scores.push(scoreSceneBreakdown(exp.file, expected, shots, { paragraphs, aliases }));
      log(`  场 ${scene.display_no}：${shots.length} 个镜头，外发 ${res.attempts} 次${res.error ? `（${res.error.code}）` : ''}`);
    }
    // scenes of the checklist the split did not produce still count as failed items
    for (const b of exp.breakdown) {
      if (!scores.some((s) => s.scene === b.scene)) {
        scores.push(scoreSceneBreakdown(exp.file, b, [], { paragraphs: [], aliases }));
      }
    }
    results.push({
      file: exp.file,
      sceneChecks: scoreScenes(exp, parsed),
      characterChecks: scoreCharacters(exp, entities),
      breakdown: scores,
      failures,
    });
  }

  const allBreakdown = results.flatMap((r) => r.breakdown);
  const breakdown = breakdownSummary(allBreakdown);
  const scenes = summarize(results.flatMap((r) => r.sceneChecks));
  const characters = summarize(results.flatMap((r) => r.characterChecks));
  const quotes = {
    located: allBreakdown.reduce((n, s) => n + s.quotes_located, 0),
    total: allBreakdown.reduce((n, s) => n + s.quotes_total, 0),
  };
  const offRoster = allBreakdown.reduce((n, s) => n + s.off_roster, 0);

  const lines: string[] = [
    `# 拆镜评测：${opts.client.model}（${opts.date}）`,
    '',
    '- 期望清单：`fixtures/scripts/expected.json`（在任何真实模型调用之前提交）',
    `- 提示词版本：${breakdownVersion}、${ENTITIES_PROMPT_VERSION}；每场镜头上限 ${EVAL_MAX_SHOTS}；手法：全部内置手法可选`,
    `- 镜头变化：${variety.length} 场平均 ${variety.length ? (variety.reduce((n, v) => n + v.score, 0) / variety.length).toFixed(2) : '—'}，单一 ${variety.filter((v) => v.severe).length} 场，调整一轮后采用 ${variety.filter((v) => v.refined).length} 场`,
    `- 外发次数：${calls}；用量：prompt ${usage.prompt} / completion ${usage.completion} / total ${usage.total}` +
      (usage.unknown_calls ? `（另有 ${usage.unknown_calls} 次响应未返回用量，记为未知）` : ''),
    '',
    `**拆镜通过率：${breakdown.passed}/${breakdown.total} = ${pct(breakdown.rate)}**（目标 ≥80%；低于 60% 触发止损 K4）`,
    '',
    `- 场景切分：${scenes.passed}/${scenes.total}`,
    `- 角色与别名：${characters.passed}/${characters.total}`,
    `- 引用可定位率：${quotes.located}/${quotes.total}${quotes.total ? `（${pct(quotes.located / quotes.total)}）` : ''}`,
    `- 名单外角色引用：${offRoster}`,
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.file}`, '', '| 编号 | 检查 | 结果 | 说明 |', '|---|---|---|---|');
    const rows = [...r.sceneChecks, ...r.characterChecks, ...r.breakdown.flatMap((s) => s.checks)];
    for (const c of rows) lines.push(`| ${esc(c.id.split('#')[1] ?? c.id)} | ${esc(c.desc)} | ${c.pass ? '通过' : '未通过'} | ${esc(c.detail)} |`);
    lines.push('');
    for (const s of r.breakdown) {
      lines.push(`- 场 ${s.scene}：${s.shot_count} 个镜头，引用可定位 ${s.quotes_located}/${s.quotes_total}，名单外角色 ${s.off_roster}`);
    }
    if (r.failures.length) {
      lines.push('', '调用失败：');
      for (const f of r.failures) lines.push(`- ${esc(f)}`);
    }
    lines.push('');
  }
  const markdown = `${lines.join('\n').trimEnd()}\n`;
  mkdirSync(opts.outDir, { recursive: true });
  const reportPath = join(opts.outDir, reportFileName(opts.client.model, opts.date));
  writeFileSync(reportPath, markdown);
  return { reportPath, markdown, breakdown, scenes, characters, calls, usage, quotes, offRoster, recorded };
}

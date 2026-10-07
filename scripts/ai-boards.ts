/**
 * AI breakdown → pencil boards, for trying a scene with a real model (S5b).
 *
 *   npx tsx scripts/ai-boards.ts --script fixtures/ai-boards/fruit-can.txt [--level steady|bold|extreme] [--out .look/ai-boards]
 *
 * Splits the script, extracts characters and props, breaks every scene down
 * with the product's prompt (breakdown-v4, at most 3 requests per step, the
 * variety refine round included), lays out every shot and draws the pencil
 * boards: <out>/boards.png (2 columns), <out>/shots.json, <out>/report.md.
 * The model comes from STORYSCRIPT_LLM_BASE_URL / _API_KEY / _MODEL, like
 * eval:breakdown; without them it says what to set and exits. The key is
 * only used for the requests: it is never printed or written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-wasm';
import { BreakdownOutput, EntitiesOutput, StyleLevel, type ShotFields } from '@storyscript/contracts';
import {
  analyzeVariety,
  breakdownPromptVersion,
  breakdownRepairErrors,
  buildBreakdownMessages,
  buildEntitiesMessages,
  cyrb53,
  layoutBoard,
  LOOK_WIDE_PENCIL,
  normalizeBreakdownJson,
  normalizeEntitiesJson,
  parseScript,
  renderBoard,
  TECHNIQUES,
  validateBreakdown,
  ZH_CAMERA_ANGLE,
  ZH_EMOTION,
  ZH_MOVEMENT,
  ZH_SHOT_SIZE,
} from '../packages/core/src/index.ts';
import { OpenAIChat } from '../apps/server/src/adapters/llm/openai-chat.ts';
import { structuredCall } from '../apps/server/src/adapters/llm/structured.ts';
import { initResvg } from '../apps/server/src/adapters/render/resvg.ts';
import { breakdownRefine } from '../apps/server/src/ai/jobs.ts';
import { MemoryCapabilityCache } from '../apps/server/src/config/capability-cache.ts';

const HELP = `未设置文本模型，没有发出任何请求。
需要三个环境变量（key 只在本机使用，不会打印或写进文件）：
  STORYSCRIPT_LLM_BASE_URL   例如 https://api.example.com/v1（OpenAI chat completions 兼容）
  STORYSCRIPT_LLM_API_KEY
  STORYSCRIPT_LLM_MODEL
然后运行：npx tsx scripts/ai-boards.ts --script fixtures/ai-boards/fruit-can.txt`;

const MAX_SHOTS = 8;

const { values } = parseArgs({
  options: {
    script: { type: 'string' },
    out: { type: 'string', default: '.look/ai-boards' },
    level: { type: 'string', default: 'steady' },
  },
});

async function main(): Promise<number> {
  if (!values.script) {
    console.log('用法：npx tsx scripts/ai-boards.ts --script <剧本.txt> [--level steady|bold|extreme] [--out 目录]');
    return 1;
  }
  const env = process.env;
  const base_url = env.STORYSCRIPT_LLM_BASE_URL?.trim();
  const api_key = env.STORYSCRIPT_LLM_API_KEY?.trim();
  const model = env.STORYSCRIPT_LLM_MODEL?.trim();
  if (!base_url || !api_key || !model) {
    console.log(HELP);
    return 0;
  }
  const level = StyleLevel.parse(values.level);
  const client = { base_url, api_key, model };
  const common = { client, chat: new OpenAIChat(client), capabilityCache: new MemoryCapabilityCache(), maxAttempts: 3 };
  const OUT = resolve(values.out ?? '.look/ai-boards');
  mkdirSync(OUT, { recursive: true });

  const text = readFileSync(values.script, 'utf8');
  const parsed = parseScript(text, values.script.endsWith('.fountain') ? 'fountain' : 'txt', []);
  let calls = 0;
  const ent = await structuredCall({ ...common, messages: buildEntitiesMessages(parsed.paragraphs), schema: EntitiesOutput, jsonSchemaName: 'entities', preprocess: normalizeEntitiesJson });
  calls += ent.attempts;
  const entities = ent.value ?? null;
  const roster = (entities?.characters ?? []).map((c, i) => ({ alias: `c${i + 1}`, name: c.name, aliases: c.aliases }));
  const propNames = (entities?.props ?? []).flatMap((p) => [p.name, ...p.aliases]);
  const techniques = TECHNIQUES.map((t) => ({ id: t.id, name: t.name, shot_grammar: t.shot_grammar }));
  const version = breakdownPromptVersion({ demo: false });

  const boards: { code: string; fields: ShotFields; svg: string }[] = [];
  const report: string[] = [`# AI 分镜测试：${model}`, '', `- 剧本：\`${values.script}\``, `- 提示词：${version}；难度：${level}；每场最多 ${MAX_SHOTS} 个镜头`, ''];
  for (const [si, scene] of parsed.scenes.entries()) {
    const ids = new Set(scene.paragraph_ids);
    const paragraphs = parsed.paragraphs.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, text: p.text }));
    const vctx = { paragraphs, aliases: roster.map((r) => r.alias), technique_ids: techniques.map((t) => t.id), max_shots: MAX_SHOTS };
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
        max_shots: MAX_SHOTS,
        target_seconds: null,
        level,
      }),
      schema: BreakdownOutput,
      jsonSchemaName: 'breakdown',
      preprocess: normalizeBreakdownJson,
      validate: (p) => {
        const v = validateBreakdown(p, vctx);
        return { ok: v.error_count === 0, errors: breakdownRepairErrors(v) };
      },
      ...breakdownRefine,
      meta: { prompt_version: version },
    });
    calls += res.attempts;
    const shots = res.value?.shots ?? res.last_parsed?.shots ?? [];
    report.push(`## 第 ${scene.display_no} 场：${scene.heading}`, '', `外发 ${res.attempts} 次${res.error ? `，${res.error.code}：${res.error.message}` : ''}；${shots.length} 个镜头；镜头变化 ${shots.length ? analyzeVariety(shots).score.toFixed(2) : '—'}`, '');
    const labelOf = new Map(roster.map((r) => [r.alias, r.name]));
    for (const [i, fields] of shots.entries()) {
      const code = `${scene.display_no}-${String(i + 1).padStart(2, '0')}`;
      const spec = layoutBoard(fields, {
        scene_sides: null,
        roster: roster.map((r, k) => ({ alias: r.alias, label: r.name, badge: String.fromCharCode(65 + k), entity_id: null })),
        look: LOOK_WIDE_PENCIL,
        technique: null,
        aspect: '2.39',
        seed: cyrb53(`${si}:${i}:${fields.action}`) % 2147483647,
        time_label: scene.time_label,
        prop_names: propNames,
      });
      boards.push({ code, fields, svg: renderBoard(spec, 'pencil', { width: 900, code }) });
      const people = fields.subjects.map((s) => `${labelOf.get(s.alias) ?? s.alias}${s.emotion ? `（${ZH_EMOTION[s.emotion]}）` : ''}`).join('、');
      report.push(
        `- **${code}** ${ZH_SHOT_SIZE[fields.shot_size]} · ${ZH_CAMERA_ANGLE[fields.angle]} · ${ZH_MOVEMENT[fields.movement]}` +
          `${fields.object_name ? ` · 物件「${fields.object_name}」` : ''}${fields.props.length ? ` · 道具 ${fields.props.join('/')}` : ''}${people ? ` · 人物 ${people}` : ''}：${fields.action}`,
      );
    }
    report.push('');
  }
  report.push(`共外发 ${calls} 次。`);

  // the sheet: 2 columns of 900 px boards with their codes
  await initResvg();
  const font = ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].find((p) => existsSync(p));
  const fontBuffers = font ? [new Uint8Array(readFileSync(font))] : [];
  const png = (svg: string, width: number) => {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#ffffff', font: { fontBuffers, defaultFontFamily: 'Hiragino Sans GB', sansSerifFamily: 'Hiragino Sans GB' } });
    const img = r.render();
    const buf = Buffer.from(img.asPng());
    img.free();
    r.free();
    return buf;
  };
  const cw = 900;
  const ch = Math.round(cw / 2.39);
  const W = 30 + 2 * cw;
  const H = 10 + Math.ceil(boards.length / 2) * (ch + 10);
  const body = boards
    .map((b, i) => `<image x="${10 + (i % 2) * (cw + 10)}" y="${10 + Math.floor(i / 2) * (ch + 10)}" width="${cw}" height="${ch}" href="data:image/png;base64,${png(b.svg, cw).toString('base64')}"/>`)
    .join('');
  if (boards.length) writeFileSync(join(OUT, 'boards.png'), png(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#eeeeee"/>${body}</svg>`, W));
  writeFileSync(join(OUT, 'shots.json'), JSON.stringify(boards.map((b) => ({ code: b.code, fields: b.fields })), null, 2));
  writeFileSync(join(OUT, 'report.md'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  console.log(`\n已写入 ${OUT}`);
  return 0;
}

process.exitCode = await main();

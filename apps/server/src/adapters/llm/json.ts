import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

/**
 * Model text → JSON value: strip Markdown code fences and leading/trailing
 * prose, then jsonrepair, then JSON.parse. Throws with a short reason that is
 * fed back to the model in the repair round.
 */
export function parseModelJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1]!.trim();
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  const first = firstObj < 0 ? firstArr : firstArr < 0 ? firstObj : Math.min(firstObj, firstArr);
  if (first > 0) t = t.slice(first);
  if (first < 0) throw new Error('输出中没有 JSON 对象');
  const close = t[0] === '[' ? ']' : '}';
  const last = t.lastIndexOf(close);
  if (last >= 0 && last < t.length - 1) t = t.slice(0, last + 1);
  let repaired: string;
  try {
    repaired = jsonrepair(t);
  } catch (err) {
    throw new Error(`输出不是合法的 JSON：${(err as Error).message}`);
  }
  return JSON.parse(repaired);
}

/**
 * JSON Schema for response_format json_schema strict mode: no $schema, every
 * object closed (additionalProperties:false) and every property required.
 * Contracts already use nullable instead of optional, so "required" keeps the
 * same meaning.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$schema') continue;
      out[k] = walk(v);
    }
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as Record<string, unknown>);
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}

/** Compact zod issue list for the repair round (bounded). */
export function zodIssuesForRepair(err: z.ZodError, max = 20): string[] {
  const lines = err.issues.slice(0, max).map((i) => `${i.path.length ? i.path.join('.') : '(根)'}：${i.message}`);
  if (err.issues.length > max) lines.push(`……另有 ${err.issues.length - max} 处问题`);
  return lines;
}

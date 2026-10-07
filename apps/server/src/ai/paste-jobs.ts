import { randomUUID } from 'node:crypto';
import { PASTE_MAX_SEGMENTS, PasteOutput, type CreatePasteInput, type DraftIssue, type Job } from '@storyscript/contracts';
import {
  buildPasteMessages,
  cleanPasteText,
  contentHash,
  finalizePaste,
  normalizePasteJson,
  PASTE_PROMPT_VERSION,
  splitPaste,
  validatePaste,
  type PastePromptInput,
} from '@storyscript/core';
import { pasteReplayKey } from '../adapters/llm/replay-chat.ts';
import { structuredCall } from '../adapters/llm/structured.ts';
import { currentRequest } from '../collab/actor.ts';
import type { DbPort } from '../db/port.ts';
import { finishSegment, getNote, insertNote, listSegments, setSegmentJob, type NoteRow } from '../db/repos/paste.ts';
import { listEntities } from '../db/repos/entity.ts';
import { listResources } from '../db/repos/resource.ts';
import { latestScriptVersion, listScenes } from '../db/repos/script.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import type { JobRunResult } from '../jobs/queue.ts';
import { assertJobQuota } from '../services/quota.ts';
import { callOptions, errorIssue, usageRecord } from './jobs.ts';
import { projectContext, resolveAi, type AiClient } from './runtime.ts';

/**
 * S5a 粘贴整理: the pasted text is stored as a note, cut into segments, and
 * each segment is one remote job (at most 3 requests, one count against the
 * daily cap). A job writes its segment's items for review; nothing reaches
 * the plan, the set or the script until a person applies it.
 */

const REPAIR_ERRORS_MAX = 12;

/** What the model is told about the project: scenes, characters, resources, the group's members. */
function promptContext(db: DbPort): Omit<PastePromptInput, 'text' | 'ref_date' | 'hint'> {
  const version = latestScriptVersion(db);
  const scenes = version ? listScenes(db, version.id).map((s) => ({ display_no: s.display_no, heading: s.heading })) : [];
  const characters = listEntities(db)
    .filter((e) => e.type === 'character')
    .map((e) => ({ name: e.name, aliases: e.aliases, actor: e.actor_name ?? null }));
  const resources = listResources(db).map((r) => ({ type: r.type, name: r.name }));
  const members = (currentRequest()?.roster() ?? []).map((m) => ({ name: m.name, roles: m.crew_roles }));
  return { scenes, characters, resources, members };
}

function segmentJob(deps: AppDeps, ai: AiClient, note: NoteRow, idx: number, text: string): Job {
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const messages = buildPasteMessages({ ...promptContext(db), text, ref_date: note.ref_date, hint: note.hint });
  return jobs.enqueue({
    kind: 'organize_paste',
    model_source: ai.source,
    idempotency_key: `paste:${note.id}:${idx}`,
    input_hash: contentHash({ prompt_version: PASTE_PROMPT_VERSION, messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx): Promise<JobRunResult> => {
      const res = await structuredCall({
        ...callOptions(ai),
        messages,
        schema: PasteOutput,
        jsonSchemaName: 'paste',
        preprocess: normalizePasteJson,
        validate: (p) => {
          const errors = validatePaste(p, text).errors;
          return { ok: errors.length === 0, errors: errors.slice(0, REPAIR_ERRORS_MAX) };
        },
        signal: ctx.signal,
        meta: { prompt_version: PASTE_PROMPT_VERSION, replay_key: pasteReplayKey(text) },
        onAttempt: ctx.markSent,
      });
      const usage = usageRecord(res.usage);
      const raw = res.value_raw ?? res.raw_outputs.at(-1) ?? null;
      const parsed = res.value ?? res.last_parsed ?? null;
      const fin = parsed ? finalizePaste(parsed, text) : null;
      const partial = res.value === undefined;
      if (!fin || (partial && fin.items.length === 0)) {
        const error = res.error ?? { code: 'ATTEMPTS_EXHAUSTED', message: '模型的回答和原文对不上，这一段没有可用的条目' };
        const err = { code: error.code, message: error.message };
        return {
          status: 'failed',
          attempts: res.attempts,
          usage,
          error: err,
          commit: () => {
            finishSegment(db, note.id, idx, { status: 'failed', model: ai.cfg.model, prompt_version: PASTE_PROMPT_VERSION, items: [], issues: [], raw_output: raw, error: err });
            return note.id;
          },
        };
      }
      const issues: DraftIssue[] = [];
      if (fin.dropped) issues.push({ level: 'warning', code: 'dropped', message: `有 ${fin.dropped} 条和原文对不上或缺少必要内容，已略去`, item: null });
      if (partial) issues.push(...errorIssue(res).map((i) => ({ ...i, level: 'warning' as const })));
      return {
        status: 'succeeded',
        attempts: res.attempts,
        usage,
        error: null,
        commit: () => {
          finishSegment(db, note.id, idx, { status: partial ? 'partial' : 'done', model: ai.cfg.model, prompt_version: PASTE_PROMPT_VERSION, items: fin.items, issues, raw_output: raw, error: null });
          return note.id;
        },
      };
    },
  });
}

export function startPasteNote(deps: AppDeps, input: CreatePasteInput, now = new Date().toISOString()): string {
  const { project } = projectContext(deps);
  const db = project.db;
  const ai = resolveAi(deps);
  const text = cleanPasteText(input.text);
  const segments = splitPaste(text);
  if (segments.length === 0) throw new AppError('VALIDATION_ERROR', '粘贴的内容是空的', 400);
  if (segments.length > PASTE_MAX_SEGMENTS) throw new AppError('VALIDATION_ERROR', `内容太长：最多 ${PASTE_MAX_SEGMENTS} 段`, 400);
  // the demo replays recordings, which carry their own dates
  if (deps.demo && segments.length > 1) throw new AppError('VALIDATION_ERROR', '演示模式只回放录好的示例，请用「填入示例」。', 409);
  if (ai.remote) assertJobQuota(deps, db, 'llm', Date.now(), segments.length);
  const id = randomUUID();
  const note: NoteRow = { id, text, ref_date: input.ref_date, timezone: project.project().timezone, hint: input.hint, actor_id: null, created_at: now, closed_at: null };
  db.tx(() => insertNote(db, note, segments));
  for (const [idx, seg] of segments.entries()) {
    const job = segmentJob(deps, ai, note, idx, seg.text);
    db.tx(() => setSegmentJob(db, id, idx, job.id));
  }
  return id;
}

/** Run one segment again (it failed, or its answer was poor). */
export function retryPasteSegment(deps: AppDeps, noteId: string, idx: number): string {
  const { project } = projectContext(deps);
  const db = project.db;
  const note = getNote(db, noteId);
  if (!note) throw new AppError('NOT_FOUND', '这次整理不存在', 404, { note_id: noteId });
  const seg = listSegments(db, noteId).find((s) => s.idx === idx);
  if (!seg) throw new AppError('NOT_FOUND', '没有这一段', 404, { note_id: noteId, idx });
  if (seg.status === 'pending' && seg.job_id) {
    const running = db.get<{ status: string }>('SELECT status FROM job WHERE id = ?', seg.job_id)?.status;
    if (running === 'queued' || running === 'running') throw new AppError('VALIDATION_ERROR', '这一段还在整理中', 409, { note_id: noteId, idx });
  }
  const ai = resolveAi(deps);
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  const job = segmentJob(deps, ai, note, idx, note.text.slice(seg.start_at, seg.end_at));
  db.tx(() => setSegmentJob(db, noteId, idx, job.id));
  return noteId;
}

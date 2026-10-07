import type {
  ApplyPasteInput,
  ApplyPasteResult,
  Constraint,
  Entity,
  PasteItem,
  PasteItemView,
  PasteNoteSummary,
  PasteNoteView,
  PasteResolution,
  PasteSegmentView,
  Resource,
  Setup,
  Shot,
  Take,
  TimeWindow,
} from '@storyscript/contracts';
import { localWindowToUtc, normalizeForMatch, pasteItemProblems, placeQuote, slotTimes, uncoveredLines, weekdayOf } from '@storyscript/core';
import { actorResolver, currentRequest } from '../collab/actor.ts';
import { listConstraints } from '../db/repos/constraint.ts';
import { listEntities } from '../db/repos/entity.ts';
import { closeNoteRow, getNote, insertApplied, listApplied, listNotes, listSegments, type NoteRow, type SegmentRow } from '../db/repos/paste.ts';
import { listResources } from '../db/repos/resource.ts';
import { latestScriptVersion, listScenes, type SceneRecord } from '../db/repos/script.ts';
import { listSetups } from '../db/repos/setup.ts';
import { listActiveShots } from '../db/repos/shot.ts';
import { listTakes, shotSetKey } from '../db/repos/take.ts';
import type { DbPort } from '../db/port.ts';
import { AppError } from '../http/errors.ts';
import { createEntity, updateEntity } from './entities.ts';
import { createTake } from './media/takes.ts';
import { createConstraint } from './plan/constraints.ts';
import { createResource, requireResource, updateResource } from './plan/resources.ts';
import { createTodo } from './todos.ts';

/**
 * S5a 粘贴整理 — review and apply. What an item would do is worked out each
 * time it is read, against the project as it is now: which resource it
 * merges into, which character a performer plays, which setups a scene has,
 * which shot a take is of, which member a todo is for. Applying goes through
 * the existing services in one transaction; an applied item is recorded and
 * never applied twice.
 */

type RosterEntry = { id: string; name: string; crew_roles: readonly string[] };

interface Ctx {
  tz: string;
  refDate: string;
  resources: Resource[];
  characters: Entity[];
  props: Entity[];
  scenes: SceneRecord[];
  shots: Shot[];
  setups: Setup[];
  constraints: Constraint[];
  takes: Take[];
  members: RosterEntry[];
}

const norm = (s: string | null | undefined) => normalizeForMatch(s ?? '').toLowerCase();
/** 「01」 and 「1」 are the same scene or shot number. */
const sameNo = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) === Number(b) : norm(a) === norm(b));

function context(db: DbPort, note: Pick<NoteRow, 'timezone' | 'ref_date'>): Ctx {
  const version = latestScriptVersion(db);
  const entities = listEntities(db);
  return {
    tz: note.timezone,
    refDate: note.ref_date,
    resources: listResources(db),
    characters: entities.filter((e) => e.type === 'character'),
    props: entities.filter((e) => e.type === 'prop'),
    scenes: version ? listScenes(db, version.id) : [],
    shots: listActiveShots(db),
    setups: listSetups(db),
    constraints: listConstraints(db),
    takes: listTakes(db),
    members: (currentRequest()?.roster() ?? []).map((m) => ({ id: m.id, name: m.name, crew_roles: m.crew_roles })),
  };
}

const NONE: PasteResolution = {
  action: 'none',
  target_id: null,
  target_name: null,
  character_id: null,
  character_name: null,
  setup_ids: [],
  other_setup_ids: [],
  shot_ids: [],
  unresolved_labels: [],
  assignee_id: null,
  assignee_roles: [],
};

interface Resolved {
  resolution: PasteResolution;
  warnings: string[];
  blocked: string | null;
  unconfirmed: boolean;
  duplicate: boolean;
  windows: TimeWindow[];
}

function windowsOf(item: PasteItem, ctx: Ctx): { windows: TimeWindow[]; problem: string | null } {
  const windows: TimeWindow[] = [];
  for (const s of item.slots) {
    try {
      const t = slotTimes(s);
      windows.push(localWindowToUtc(s.date, t.start, t.end, ctx.tz));
    } catch {
      return { windows, problem: `时间「${s.date} ${s.start ?? ''}–${s.end ?? ''}」写得不对` };
    }
  }
  return { windows, problem: null };
}

function findCharacter(ctx: Ctx, name: string | null): Entity | null {
  if (!name) return null;
  const n = norm(name);
  return ctx.characters.find((c) => norm(c.name) === n || c.aliases.some((a) => norm(a) === n)) ?? null;
}

function findMember(ctx: Ctx, who: string | null): { member: RosterEntry | null; warning: string | null } {
  const name = (who ?? '').replace(/^[@＠]/, '').trim();
  if (!name || ctx.members.length === 0) return { member: null, warning: null };
  const n = norm(name);
  const byName = ctx.members.find((m) => norm(m.name) === n);
  if (byName) return { member: byName, warning: null };
  const byRole = ctx.members.filter((m) => m.crew_roles.some((r) => norm(r) === n));
  if (byRole.length === 1) return { member: byRole[0]!, warning: null };
  if (byRole.length > 1) return { member: null, warning: `组里有 ${byRole.length} 位「${name}」，请在编辑里选一位` };
  return { member: null, warning: `「${name}」不是本组成员，按名字记下` };
}

function scenesOf(ctx: Ctx, nos: readonly string[]): { scenes: SceneRecord[]; missing: string[] } {
  const scenes: SceneRecord[] = [];
  const missing: string[] = [];
  for (const no of nos) {
    const s = ctx.scenes.find((x) => sameNo(x.display_no, no));
    if (s) scenes.push(s);
    else missing.push(no);
  }
  return { scenes, missing };
}

function setupsOf(ctx: Ctx, scenes: readonly SceneRecord[]): Setup[] {
  const ids = new Set(scenes.map((s) => s.id));
  const sceneOf = new Map(ctx.shots.map((s) => [s.id, s.scene_id] as const));
  return ctx.setups.filter((st) => st.shot_ids.some((id) => ids.has(sceneOf.get(id) ?? '')));
}

/** The window a setup is held to by its not_before / not_after / locked constraints. */
function heldWindow(ctx: Ctx, setupId: string): { from: number; to: number } {
  let from = -Infinity;
  let to = Infinity;
  for (const c of ctx.constraints) {
    if (c.type === 'before' || c.setup_id !== setupId) continue;
    if (c.type === 'not_before') from = Math.max(from, Date.parse(c.at_utc));
    if (c.type === 'not_after') to = Math.min(to, Date.parse(c.at_utc));
    if (c.type === 'locked_block') {
      from = Math.max(from, Date.parse(c.start_utc));
      to = Math.min(to, Date.parse(c.end_utc));
    }
  }
  return { from, to };
}

export function resolveItem(item: PasteItem, ctx: Ctx): Resolved {
  const warnings: string[] = [];
  let blocked: string | null = null;
  let duplicate = false;
  const r: PasteResolution = { ...NONE };
  const { windows, problem } = windowsOf(item, ctx);
  if (problem) blocked = problem;
  for (const s of item.slots) {
    const wd = weekdayOf(s.date);
    if (s.weekday && s.weekday.replace('星期', '周') !== wd) warnings.push(`${s.date} 是${wd}，原文说的是${s.weekday}`);
    if (s.date < ctx.refDate && Date.parse(ctx.refDate) - Date.parse(s.date) > 86_400_000) warnings.push(`${s.date} 早于消息日期，请核对`);
  }
  if (item.unsure) warnings.push(item.unsure);
  const fields = pasteItemProblems(item);
  if (fields.length && !blocked) blocked = fields.join('；');

  switch (item.kind) {
    case 'person':
    case 'location':
    case 'equipment': {
      const type = item.kind === 'person' ? 'performer' : item.kind;
      const target = ctx.resources.find((x) => x.type === type && norm(x.name) === norm(item.name));
      r.action = target ? 'merge' : 'create';
      r.target_id = target?.id ?? null;
      r.target_name = target?.name ?? null;
      if (item.kind === 'person') {
        const character = findCharacter(ctx, item.character) ?? (item.character ? null : (ctx.characters.find((c) => c.actor_name && norm(c.actor_name) === norm(item.name)) ?? null));
        if (item.character && !character) warnings.push(`剧本里没有叫「${item.character}」的角色`);
        if (character) {
          r.character_id = character.id;
          r.character_name = character.name;
          const other = ctx.resources.find((x) => x.type === 'performer' && x.id !== target?.id && x.cast_character_ids.includes(character.id));
          if (other) warnings.push(`「${character.name}」已经由 ${other.name} 饰演，应用后两人都会记在这个角色名下`);
        }
      }
      break;
    }
    case 'prop': {
      const n = norm(item.name);
      const existing = ctx.props.find((p) => norm(p.name) === n || p.aliases.some((a) => norm(a) === n));
      r.action = existing ? 'exists' : 'create';
      r.target_id = existing?.id ?? null;
      r.target_name = existing?.name ?? null;
      break;
    }
    case 'schedule': {
      const a = scenesOf(ctx, item.scenes);
      const b = scenesOf(ctx, item.other_scenes);
      const missing = [...a.missing, ...b.missing];
      if (missing.length) {
        blocked ??= `剧本里没有第 ${missing.join('、')} 场`;
        break;
      }
      const setups = setupsOf(ctx, a.scenes);
      const others = setupsOf(ctx, b.scenes);
      r.setup_ids = setups.map((s) => s.id);
      r.other_setup_ids = others.map((s) => s.id);
      const without = [...(setups.length ? [] : a.scenes), ...(item.rule === 'before' || item.rule === 'after' ? (others.length ? [] : b.scenes) : [])];
      if (without.length) {
        blocked ??= `第 ${without.map((s) => s.display_no).join('、')} 场还没有 setup：先到计划页生成 setup，再回来应用`;
        break;
      }
      if (item.slots.length > 1 && item.rule !== 'before' && item.rule !== 'after') warnings.push('有好几个时段，只用第一个');
      const w = windows[0];
      if (w && (item.rule === 'within' || item.rule === 'not_before' || item.rule === 'not_after')) {
        const start = item.rule === 'not_after' ? -Infinity : Date.parse(w.start_utc);
        const end = item.rule === 'not_before' ? Infinity : Date.parse(w.end_utc);
        if (setups.some((s) => {
          const held = heldWindow(ctx, s.id);
          return Math.max(held.from, start) >= Math.min(held.to, end);
        })) warnings.push('和这些 setup 已有的时间安排矛盾');
      }
      if (item.rule === 'before' || item.rule === 'after') {
        const [first, then] = item.rule === 'before' ? [setups, others] : [others, setups];
        const reversed = ctx.constraints.some((c) => c.type === 'before' && first.some((x) => x.id === c.b_setup_id) && then.some((y) => y.id === c.a_setup_id));
        if (reversed) warnings.push('和已有的先后顺序矛盾');
      }
      break;
    }
    case 'take': {
      const sceneNo = item.scenes[0] ?? null;
      const scene = sceneNo ? ctx.scenes.find((s) => sameNo(s.display_no, sceneNo)) : undefined;
      const shot = scene && item.shot ? ctx.shots.find((s) => s.scene_id === scene.id && sameNo(s.code, item.shot!)) : undefined;
      if (shot) r.shot_ids = [shot.id];
      else r.unresolved_labels = [[sceneNo, item.shot].filter(Boolean).join('-')];
      if (!shot) warnings.push(`镜头 ${r.unresolved_labels[0]} 对不上，记成「未对上的镜号」`);
      if (item.take) {
        const key = shotSetKey(r.shot_ids.length ? r.shot_ids : r.unresolved_labels);
        duplicate = ctx.takes.some((t) => t.take_no === item.take && shotSetKey(t.shot_ids.length ? t.shot_ids : t.unresolved_labels) === key);
        if (duplicate) warnings.push(`已经记过这个镜头的第 ${item.take} 条`);
      }
      break;
    }
    case 'todo': {
      const { member, warning } = findMember(ctx, item.assignee);
      if (warning) warnings.push(warning);
      r.assignee_id = member?.id ?? null;
      r.assignee_roles = member ? [...member.crew_roles] : [];
      r.target_name = member?.name ?? (item.assignee?.replace(/^[@＠]/, '').trim() || null);
      break;
    }
    case 'other':
      blocked ??= '「其他」只作记录，不写入';
      break;
  }
  const unconfirmed = item.slots.some((s) => s.vague) || item.unsure !== null;
  return { resolution: r, warnings, blocked, unconfirmed, duplicate, windows };
}

// ---------------------------------------------------------------------- views

function segmentStatus(db: DbPort, s: SegmentRow): Pick<PasteSegmentView, 'status' | 'error'> {
  if (s.status !== 'pending' || !s.job_id) return { status: s.status, error: s.error };
  const job = db.get<{ status: string; error_json: string | null }>('SELECT status, error_json FROM job WHERE id = ?', s.job_id);
  if (!job || job.status === 'queued' || job.status === 'running') return { status: 'pending', error: null };
  const error = job.error_json ? (JSON.parse(job.error_json) as { code: string; message: string }) : { code: job.status.toUpperCase(), message: job.status === 'cancelled' ? '已取消' : '这一段没有整理完' };
  return { status: 'failed', error };
}

function summaryOf(db: DbPort, note: NoteRow, segs: readonly SegmentRow[], applied: number, who: ReturnType<typeof actorResolver>): PasteNoteSummary {
  const first = note.text.split('\n').find((l) => l.trim()) ?? '';
  const statuses = segs.map((s) => segmentStatus(db, s).status);
  return {
    id: note.id,
    ref_date: note.ref_date,
    hint: note.hint,
    title: Array.from(first.trim()).length > 40 ? `${Array.from(first.trim()).slice(0, 39).join('')}…` : first.trim(),
    chars: Array.from(note.text).length,
    segments: segs.length,
    pending_segments: statuses.filter((s) => s === 'pending').length,
    item_count: segs.reduce((n, s) => n + s.items.length, 0),
    applied_count: applied,
    closed: note.closed_at !== null,
    created_at: note.created_at,
    actor: who(note.actor_id),
  };
}

export function listPasteNotes(db: DbPort): PasteNoteSummary[] {
  const who = actorResolver(db);
  return listNotes(db).map((n) => summaryOf(db, n, listSegments(db, n.id), listApplied(db, n.id).length, who));
}

export function requireNote(db: DbPort, id: string): NoteRow {
  const note = getNote(db, id);
  if (!note) throw new AppError('NOT_FOUND', '这次整理不存在', 404, { note_id: id });
  return note;
}

export function pasteNoteView(db: DbPort, id: string): PasteNoteView {
  const note = requireNote(db, id);
  const segs = listSegments(db, id);
  const applied = new Map(listApplied(db, id).map((a) => [a.item_key, a] as const));
  const who = actorResolver(db);
  const ctx = context(db, note);
  const items: PasteItemView[] = [];
  const segment_views: PasteSegmentView[] = segs.map((s) => {
    const text = note.text.slice(s.start_at, s.end_at);
    s.items.forEach((item, i) => {
      const key = `${s.idx}:${i}`;
      const res = resolveItem(item, ctx);
      const a = applied.get(key);
      items.push({
        key,
        item,
        resolution: res.resolution,
        warnings: res.warnings,
        blocked: res.blocked,
        unconfirmed: res.unconfirmed,
        suggested: !a && res.blocked === null && !res.duplicate,
        applied: a ? { at: a.applied_at, actor: who(a.actor_id) } : null,
      });
    });
    return {
      idx: s.idx,
      chars: Array.from(text).length,
      ...segmentStatus(db, s),
      job_id: s.job_id,
      issues: s.issues,
      uncovered: s.items.length || s.status !== 'pending' ? uncoveredLines(text, s.items.map((x) => x.quote)) : [],
    };
  });
  return { ...summaryOf(db, note, segs, applied.size, who), text: note.text, timezone: note.timezone, segment_views, items };
}

export function closePasteNote(db: DbPort, id: string, now = new Date().toISOString()): PasteNoteView {
  db.tx(() => {
    requireNote(db, id);
    closeNoteRow(db, id, now);
  });
  return pasteNoteView(db, id);
}

// ---------------------------------------------------------------------- apply

/** Union of availability windows: overlapping or touching ones become one. */
export function unionWindows(list: readonly TimeWindow[]): TimeWindow[] {
  const sorted = [...list].sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const out: TimeWindow[] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last && Date.parse(w.start_utc) <= Date.parse(last.end_utc)) {
      if (Date.parse(w.end_utc) > Date.parse(last.end_utc)) last.end_utc = w.end_utc;
    } else out.push({ ...w });
  }
  return out;
}

const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

export function applyPaste(db: DbPort, noteId: string, input: ApplyPasteInput, now = new Date().toISOString()): ApplyPasteResult {
  const counts = { resources_created: 0, resources_updated: 0, constraints: 0, takes: 0, entities: 0, todos: 0 };
  db.tx(() => {
    const note = requireNote(db, noteId);
    const segs = listSegments(db, noteId);
    const applied = new Set(listApplied(db, noteId).map((a) => a.item_key));
    const seen = new Set<string>();
    for (const { key, item } of input.items) {
      const [segIdx, itemIdx] = key.split(':').map(Number);
      const seg = segs.find((s) => s.idx === segIdx);
      if (!seg || !Number.isInteger(itemIdx) || !seg.items[itemIdx!]) throw new AppError('VALIDATION_ERROR', `没有这一条：${key}`, 400, { key });
      if (applied.has(key) || seen.has(key)) throw new AppError('VALIDATION_ERROR', '这一条已经应用过了', 409, { key });
      seen.add(key);
      const text = note.text.slice(seg.start_at, seg.end_at);
      if (!placeQuote(item.quote, text)) throw new AppError('VALIDATION_ERROR', '这一条的原文引用对不上', 400, { key });
      // read the project afresh for each item: an earlier one may have created what this one merges into
      const res = resolveItem(item, context(db, note));
      if (res.blocked) throw new AppError('VALIDATION_ERROR', `「${item.name ?? item.task ?? item.quote}」不能应用：${res.blocked}`, 409, { key });
      const refs: Record<string, string[]> = {};
      const add = (k: string, id: string) => (refs[k] ??= []).push(id);
      const todoFor = (text: string, who: string | null, date: string | null, time: string | null) => {
        const r = resolveItem({ ...item, kind: 'todo', assignee: who, task: text }, context(db, note)).resolution;
        const t = createTodo(db, { text, assignee_id: r.assignee_id, assignee_name: r.assignee_id ? null : r.target_name, due_date: date, due_time: time, source_note_id: noteId }, now);
        add('todos', t.id);
        counts.todos++;
      };
      switch (item.kind) {
        case 'person':
        case 'location':
        case 'equipment': {
          const type = item.kind === 'person' ? 'performer' : item.kind;
          const cast = res.resolution.character_id ? [res.resolution.character_id] : [];
          if (res.resolution.target_id) {
            const cur = requireResource(db, res.resolution.target_id);
            updateResource(db, cur.id, {
              windows: unionWindows([...cur.windows, ...res.windows]),
              cast_character_ids: uniq([...cur.cast_character_ids, ...cast]),
              confirmed: cur.confirmed && !res.unconfirmed,
            });
            add('resources', cur.id);
            counts.resources_updated++;
          } else {
            const created = createResource(db, { type, name: item.name!, windows: unionWindows(res.windows), cast_character_ids: cast, confirmed: !res.unconfirmed });
            add('resources', created.id);
            counts.resources_created++;
          }
          if (item.kind === 'equipment' && item.owner) {
            const s = item.slots[0];
            todoFor(`带 ${item.name}${item.quantity && item.quantity > 1 ? ` ×${item.quantity}` : ''}`, item.owner, s?.date ?? null, s?.start ?? null);
          }
          break;
        }
        case 'prop': {
          if (res.resolution.action === 'create') {
            const e = createEntity(db, { type: 'prop', name: item.name!, aliases: [] });
            if (res.unconfirmed) updateEntity(db, e.id, { confirmed: false });
            add('entities', e.id);
            counts.entities++;
          }
          if (item.owner) todoFor(`准备 ${item.name}`, item.owner, item.slots[0]?.date ?? null, null);
          break;
        }
        case 'schedule': {
          const confirmed = !res.unconfirmed;
          const existing = listConstraints(db);
          const has = (c: Record<string, unknown>) => existing.some((x) => Object.entries(c).every(([k, v]) => (x as Record<string, unknown>)[k] === v));
          const push = (c: Constraint) => {
            add('constraints', c.id);
            counts.constraints++;
          };
          const w = res.windows[0];
          for (const setupId of res.resolution.setup_ids) {
            if (w && (item.rule === 'within' || item.rule === 'not_before') && !has({ type: 'not_before', setup_id: setupId, at_utc: w.start_utc })) {
              push(createConstraint(db, { type: 'not_before', setup_id: setupId, at_utc: w.start_utc, confirmed }));
            }
            if (w && (item.rule === 'within' || item.rule === 'not_after') && !has({ type: 'not_after', setup_id: setupId, at_utc: w.end_utc })) {
              push(createConstraint(db, { type: 'not_after', setup_id: setupId, at_utc: w.end_utc, confirmed }));
            }
          }
          if (item.rule === 'before' || item.rule === 'after') {
            const [first, then] = item.rule === 'before' ? [res.resolution.setup_ids, res.resolution.other_setup_ids] : [res.resolution.other_setup_ids, res.resolution.setup_ids];
            for (const a of first) for (const b of then) {
              if (a !== b && !has({ type: 'before', a_setup_id: a, b_setup_id: b })) push(createConstraint(db, { type: 'before', a_setup_id: a, b_setup_id: b, confirmed }));
            }
          }
          break;
        }
        case 'take': {
          const shotId = res.resolution.shot_ids[0];
          const setup = shotId ? listSetups(db).find((s) => s.shot_ids.includes(shotId)) : undefined;
          const take = createTake(
            db,
            {
              setup_id: setup?.id ?? null,
              take_no: item.take ?? undefined,
              camera_label: null,
              rating: item.rating ?? 'unrated',
              clip_hint: item.clip,
              notes: item.detail ?? '',
              shot_ids: res.resolution.shot_ids,
              unresolved_labels: res.resolution.unresolved_labels,
            },
            now,
          );
          add('takes', take.id);
          counts.takes++;
          break;
        }
        case 'todo': {
          const s = item.slots[0];
          todoFor(item.task!, item.assignee, s?.date ?? null, s?.end ?? null);
          break;
        }
        case 'other':
          break;
      }
      insertApplied(db, noteId, { item_key: key, kind: item.kind, refs, applied_at: now });
    }
  });
  return { note: pasteNoteView(db, noteId), counts };
}

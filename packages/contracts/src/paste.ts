import { z } from 'zod';
import { ActorRef, IsoTime, Uuid } from './common.ts';
import { DraftIssue } from './shot.ts';
import { TakeRating } from './take.ts';

/**
 * S5a 粘贴整理: a long text from a group chat, notes or a roster, sorted by
 * the model into fixed kinds, each tied to a verbatim quote. Nothing is
 * applied until a person ticks it; then it goes through the existing plan,
 * set and entity services, and the todo list.
 */

export const PASTE_MAX_CHARS = 20_000;
export const PASTE_SEGMENT_CHARS = 3_000;
export const PASTE_MAX_SEGMENTS = 7;

export const PasteKind = z.enum(['person', 'location', 'equipment', 'prop', 'schedule', 'take', 'todo', 'other']);
export type PasteKind = z.infer<typeof PasteKind>;

export const PasteHint = z.enum(['auto', 'plan', 'set']);
export type PasteHint = z.infer<typeof PasteHint>;

export const ScheduleRule = z.enum(['within', 'not_before', 'not_after', 'before', 'after']);
export type ScheduleRule = z.infer<typeof ScheduleRule>;

export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** A local day, maybe a time range on it; `vague` when the text said 下午 / 周末 … */
export const PasteSlot = z.object({
  date: LocalDate,
  weekday: z.string().nullable(),
  start: LocalTime.nullable(),
  end: LocalTime.nullable(),
  vague: z.boolean(),
});
export type PasteSlot = z.infer<typeof PasteSlot>;

/** One item as the model gives it: flat, unused fields null or empty. */
export const PasteItem = z.object({
  kind: PasteKind,
  quote: z.string(),
  name: z.string().nullable(),
  detail: z.string().nullable(),
  character: z.string().nullable(),
  owner: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  slots: z.array(PasteSlot),
  scenes: z.array(z.string()),
  rule: ScheduleRule.nullable(),
  other_scenes: z.array(z.string()),
  shot: z.string().nullable(),
  take: z.number().int().positive().nullable(),
  rating: TakeRating.nullable(),
  clip: z.string().nullable(),
  assignee: z.string().nullable(),
  task: z.string().nullable(),
  unsure: z.string().nullable(),
});
export type PasteItem = z.infer<typeof PasteItem>;

export const PasteOutput = z.object({ items: z.array(PasteItem).max(200) });
export type PasteOutput = z.infer<typeof PasteOutput>;

export const PasteSegmentStatus = z.enum(['pending', 'done', 'partial', 'failed']);
export type PasteSegmentStatus = z.infer<typeof PasteSegmentStatus>;

/** What applying an item would do, worked out against the project as it is now. */
export const PasteResolution = z.object({
  /** person / location / equipment / prop: an existing record to merge into, else new */
  action: z.enum(['create', 'merge', 'exists', 'none']),
  target_id: Uuid.nullable(),
  target_name: z.string().nullable(),
  /** person: the character they play */
  character_id: Uuid.nullable(),
  character_name: z.string().nullable(),
  /** schedule: the setups of the scenes (and of the other scenes for before / after) */
  setup_ids: z.array(Uuid),
  other_setup_ids: z.array(Uuid),
  /** take: the shots found, and labels for those not found */
  shot_ids: z.array(Uuid),
  unresolved_labels: z.array(z.string()),
  /** todo: the member it goes to (hosted) and their crew roles */
  assignee_id: z.string().nullable(),
  assignee_roles: z.array(z.string()),
});
export type PasteResolution = z.infer<typeof PasteResolution>;

export const PasteItemView = z.object({
  /** "<segment>:<index>" */
  key: z.string(),
  item: PasteItem,
  resolution: PasteResolution,
  /** one sentence each: why it needs checking */
  warnings: z.array(z.string()),
  /** why it cannot be applied as it is (null = it can) */
  blocked: z.string().nullable(),
  /** written with 未确认 (vague time or unsure) */
  unconfirmed: z.boolean(),
  /** ticked by default in the review */
  suggested: z.boolean(),
  applied: z.object({ at: IsoTime, actor: ActorRef.nullable() }).nullable(),
});
export type PasteItemView = z.infer<typeof PasteItemView>;

export const PasteSegmentView = z.object({
  idx: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
  status: PasteSegmentStatus,
  job_id: Uuid.nullable(),
  issues: z.array(DraftIssue),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** non-empty lines no item quotes */
  uncovered: z.array(z.string()),
});
export type PasteSegmentView = z.infer<typeof PasteSegmentView>;

export const PasteNoteSummary = z.object({
  id: Uuid,
  ref_date: LocalDate,
  hint: PasteHint,
  /** the first line, shortened */
  title: z.string(),
  chars: z.number().int().nonnegative(),
  segments: z.number().int().positive(),
  pending_segments: z.number().int().nonnegative(),
  item_count: z.number().int().nonnegative(),
  applied_count: z.number().int().nonnegative(),
  closed: z.boolean(),
  created_at: IsoTime,
  actor: ActorRef.nullable(),
});
export type PasteNoteSummary = z.infer<typeof PasteNoteSummary>;

export const PasteNoteView = PasteNoteSummary.extend({
  text: z.string(),
  timezone: z.string(),
  segment_views: z.array(PasteSegmentView),
  items: z.array(PasteItemView),
});
export type PasteNoteView = z.infer<typeof PasteNoteView>;

export const CreatePasteInput = z.object({
  text: z.string().min(1).max(PASTE_MAX_CHARS),
  ref_date: LocalDate,
  hint: PasteHint,
});
export type CreatePasteInput = z.infer<typeof CreatePasteInput>;

export const ApplyPasteInput = z.object({
  items: z.array(z.object({ key: z.string(), item: PasteItem })).min(1).max(200),
});
export type ApplyPasteInput = z.infer<typeof ApplyPasteInput>;

export const ApplyPasteResult = z.object({
  note: PasteNoteView,
  counts: z.object({
    resources_created: z.number().int().nonnegative(),
    resources_updated: z.number().int().nonnegative(),
    constraints: z.number().int().nonnegative(),
    takes: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    todos: z.number().int().nonnegative(),
  }),
});
export type ApplyPasteResult = z.infer<typeof ApplyPasteResult>;

// ------------------------------------------------------------------- todos

export const Todo = z.object({
  id: Uuid,
  text: z.string().min(1).max(200),
  /** hosted: the member it is for */
  assignee_id: z.string().nullable(),
  /** a name typed in (local), or a member's current name and roles (hosted) */
  assignee_name: z.string().nullable(),
  assignee_roles: z.array(z.string()),
  due_date: LocalDate.nullable(),
  due_time: LocalTime.nullable(),
  done: z.object({ at: IsoTime, actor: ActorRef.nullable() }).nullable(),
  source_note_id: Uuid.nullable(),
  created_at: IsoTime,
  actor: ActorRef.nullable(),
  revision: z.number().int().nonnegative(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodoInput = z.object({
  text: z.string().trim().min(1).max(200),
  assignee_id: z.string().nullable(),
  assignee_name: z.string().trim().max(40).nullable(),
  due_date: LocalDate.nullable(),
  due_time: LocalTime.nullable(),
});
export type CreateTodoInput = z.infer<typeof CreateTodoInput>;

export const UpdateTodoInput = CreateTodoInput.partial().extend({
  done: z.boolean().optional(),
  expected_revision: z.number().int().nonnegative().optional(),
});
export type UpdateTodoInput = z.infer<typeof UpdateTodoInput>;

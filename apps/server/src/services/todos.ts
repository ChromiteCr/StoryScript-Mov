import { randomUUID } from 'node:crypto';
import type { CreateTodoInput, Todo, UpdateTodoInput } from '@storyscript/contracts';
import { actorId, actorResolver, currentRequest } from '../collab/actor.ts';
import type { DbPort } from '../db/port.ts';
import { AppError } from '../http/errors.ts';

/**
 * S5a todos: the group's list of things to do before a shoot. On the hosted
 * server a todo can go to a member (by account id; the name and crew roles
 * shown are always the current ones); locally, or for someone outside the
 * group, it carries a typed name. Any member may tick, edit or delete one.
 */

interface TodoRow {
  id: string;
  text: string;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  due_time: string | null;
  done_at: string | null;
  done_by: string | null;
  source_note_id: string | null;
  actor_id: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

const COLS = 'id, text, assignee_id, assignee_name, due_date, due_time, done_at, done_by, source_note_id, actor_id, created_at, updated_at, revision';

function view(r: TodoRow, who: ReturnType<typeof actorResolver>): Todo {
  const member = r.assignee_id ? who(r.assignee_id) : null;
  return {
    id: r.id,
    text: r.text,
    assignee_id: r.assignee_id,
    assignee_name: member?.name ?? r.assignee_name,
    assignee_roles: member?.crew_roles ?? [],
    due_date: r.due_date,
    due_time: r.due_time,
    done: r.done_at ? { at: r.done_at, actor: who(r.done_by) } : null,
    source_note_id: r.source_note_id,
    created_at: r.created_at,
    actor: who(r.actor_id),
    revision: r.revision,
  };
}

const getRow = (db: DbPort, id: string) => db.get<TodoRow>(`SELECT ${COLS} FROM todo WHERE id = ?`, id) ?? null;

/** Open todos first by due date (none last), then the done ones, newest first. */
export function listTodos(db: DbPort): Todo[] {
  const who = actorResolver(db);
  return db
    .all<TodoRow>(`SELECT ${COLS} FROM todo ORDER BY done_at IS NOT NULL, CASE WHEN done_at IS NULL THEN due_date IS NULL END, due_date, due_time, done_at DESC, created_at`)
    .map((r) => view(r, who));
}

/** A member id must be one of the group's members (hosted); locally there are none. */
function checkAssignee(id: string | null | undefined): void {
  if (!id) return;
  const roster = currentRequest()?.roster() ?? [];
  if (!roster.some((m) => m.id === id)) throw new AppError('VALIDATION_ERROR', '负责人不是本组成员', 400, { assignee_id: id });
}

export function createTodo(db: DbPort, input: CreateTodoInput & { source_note_id?: string | null }, now = new Date().toISOString()): Todo {
  return db.tx(() => {
    checkAssignee(input.assignee_id);
    const id = randomUUID();
    db.run(
      `INSERT INTO todo (${COLS}) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0)`,
      id,
      input.text.trim(),
      input.assignee_id,
      input.assignee_id ? null : input.assignee_name?.trim() || null,
      input.due_date,
      input.due_date ? input.due_time : null,
      input.source_note_id ?? null,
      actorId(),
      now,
      now,
    );
    return view(getRow(db, id)!, actorResolver(db));
  });
}

export function updateTodo(db: DbPort, id: string, input: UpdateTodoInput, now = new Date().toISOString()): Todo {
  return db.tx(() => {
    const cur = getRow(db, id);
    if (!cur) throw new AppError('NOT_FOUND', '待办不存在，可能已被删除', 404, { todo_id: id });
    if (input.expected_revision !== undefined && input.expected_revision !== cur.revision) {
      throw new AppError('REVISION_CONFLICT', '这条待办刚被别人改过，请看一下最新的内容', 409, { todo_id: id, current_revision: cur.revision });
    }
    if (input.assignee_id !== undefined) checkAssignee(input.assignee_id);
    const assigneeId = input.assignee_id !== undefined ? input.assignee_id : cur.assignee_id;
    const assigneeName = assigneeId ? null : input.assignee_name !== undefined ? input.assignee_name?.trim() || null : input.assignee_id !== undefined ? null : cur.assignee_name;
    const dueDate = input.due_date !== undefined ? input.due_date : cur.due_date;
    const dueTime = dueDate ? (input.due_time !== undefined ? input.due_time : cur.due_time) : null;
    const done = input.done === undefined ? cur.done_at !== null : input.done;
    const doneAt = done ? (cur.done_at ?? now) : null;
    const doneBy = done ? (cur.done_at ? cur.done_by : actorId()) : null;
    db.run(
      'UPDATE todo SET text = ?, assignee_id = ?, assignee_name = ?, due_date = ?, due_time = ?, done_at = ?, done_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      input.text !== undefined ? input.text.trim() : cur.text,
      assigneeId,
      assigneeName,
      dueDate,
      dueTime,
      doneAt,
      doneBy,
      now,
      id,
    );
    return view(getRow(db, id)!, actorResolver(db));
  });
}

export function deleteTodo(db: DbPort, id: string): { id: string } {
  return db.tx(() => {
    if (!getRow(db, id)) throw new AppError('NOT_FOUND', '待办不存在，可能已被删除', 404, { todo_id: id });
    db.run('DELETE FROM todo WHERE id = ?', id);
    return { id };
  });
}

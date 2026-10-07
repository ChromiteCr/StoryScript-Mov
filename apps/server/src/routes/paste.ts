import type { Hono } from 'hono';
import { z } from 'zod';
import { ApplyPasteInput, ApplyPasteResult, Api, CreatePasteInput, CreateTodoInput, PasteNoteSummary, PasteNoteView, Todo, UpdateTodoInput } from '@storyscript/contracts';
import { retryPasteSegment, startPasteNote } from '../ai/paste-jobs.ts';
import type { AppDeps } from '../deps.ts';
import { respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { applyPaste, closePasteNote, listPasteNotes, pasteNoteView } from '../services/paste.ts';
import { createTodo, deleteTodo, listTodos, updateTodo } from '../services/todos.ts';

/** S5a: paste organize (a note, one model job per segment, review, apply) and the todo list. */
export function registerPasteRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;
  const id = (c: { req: { param: (k: string) => string | undefined } }) => c.req.param('id') ?? '';

  app.get(Api.listPasteNotes.path, (c) => respond(c, z.array(PasteNoteSummary), listPasteNotes(db())));
  app.post(Api.createPasteNote.path, async (c) => {
    const input = await parseBody(c, CreatePasteInput);
    const noteId = startPasteNote(deps, input);
    return respond(c, PasteNoteView, pasteNoteView(db(), noteId), 201);
  });
  app.get(Api.getPasteNote.path, (c) => respond(c, PasteNoteView, pasteNoteView(db(), id(c))));
  app.post(Api.retryPasteSegment.path, (c) => {
    const idx = Number(c.req.param('idx'));
    return respond(c, PasteNoteView, pasteNoteView(db(), retryPasteSegment(deps, id(c), Number.isInteger(idx) ? idx : -1)));
  });
  app.post(Api.applyPasteNote.path, async (c) => {
    const input = await parseBody(c, ApplyPasteInput);
    return respond(c, ApplyPasteResult, applyPaste(db(), id(c), input));
  });
  app.post(Api.closePasteNote.path, (c) => respond(c, PasteNoteView, closePasteNote(db(), id(c))));

  app.get(Api.listTodos.path, (c) => respond(c, z.array(Todo), listTodos(db())));
  app.post(Api.createTodo.path, async (c) => {
    const input = await parseBody(c, CreateTodoInput);
    return respond(c, Todo, createTodo(db(), input), 201);
  });
  app.patch(Api.updateTodo.path, async (c) => {
    const input = await parseBody(c, UpdateTodoInput);
    return respond(c, Todo, updateTodo(db(), id(c), input));
  });
  app.delete(Api.deleteTodo.path, (c) => respond(c, z.object({ id: z.string() }), deleteTodo(db(), id(c))));
}

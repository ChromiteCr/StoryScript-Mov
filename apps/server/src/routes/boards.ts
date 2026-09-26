import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, Board, BoardRevisionInput, BoardView, SaveBoardInput } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { keepBoard, listBoards, regenerateBoard, saveBoard, shotBoardVersions } from '../services/boards/boards.ts';

/**
 * Boards (FR-04, contracts M4). Layout runs here (core layoutBoard); the
 * browser renders SVG itself (core renderBoard). Writes return only after the
 * transaction committed; save/keep check expected_revision (409).
 */
export function registerBoardRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listBoards.path, (c) => respond(c, z.array(BoardView), listBoards(db())));

  app.get(Api.shotBoardVersions.path, (c) => respond(c, z.array(Board), shotBoardVersions(db(), idParam(c))));

  app.post(Api.regenerateBoard.path, (c) => respond(c, BoardView, regenerateBoard(db(), idParam(c)), 201));

  app.patch(Api.saveBoard.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, SaveBoardInput);
    return respond(c, BoardView, saveBoard(db(), id, input));
  });

  app.post(Api.keepBoard.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, BoardRevisionInput);
    return respond(c, BoardView, keepBoard(db(), id, input));
  });
}

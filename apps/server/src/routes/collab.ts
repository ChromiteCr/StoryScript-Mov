import type { Context, Hono, MiddlewareHandler } from 'hono';
import { Api, CollabChanges, CollabChangesQuery } from '@storyscript/contracts';
import { actorId, actorResolver, currentActor, currentRequest } from '../collab/actor.ts';
import { areasOf, JOB_AREAS, verbOf } from '../collab/feed.ts';
import type { DbPort } from '../db/port.ts';
import { getBoard } from '../db/repos/board.ts';
import { getScene } from '../db/repos/script.ts';
import { getShot } from '../db/repos/shot.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { respond } from '../http/respond.ts';
import { onJobSettled } from '../jobs/queue.ts';

/**
 * S4a — the change feed. A middleware bumps the areas a successful write
 * touched (with where it happened, for the activity line); finished jobs
 * bump theirs; GET /collab/changes answers polls and records presence.
 */

/** Scene number and shot code of the shot a write was about, when the path names one. */
function whereOf(db: DbPort, path: string): { scene_no: string | null; shot_code: string | null } {
  const none = { scene_no: null, shot_code: null };
  const shotId = /^\/api\/v1\/shots\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  const boardId = /^\/api\/v1\/boards\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  const boardShot = boardId ? (getBoard(db, boardId)?.shot_id ?? null) : null;
  const shot = shotId ? getShot(db, shotId) : boardShot ? getShot(db, boardShot) : null;
  if (!shot) return none;
  const scene = getScene(db, shot.scene_id);
  return { scene_no: scene?.display_no ?? null, shot_code: shot.code };
}

export function collabMiddleware(deps: AppDeps): MiddlewareHandler {
  const watched = new WeakSet<DbPort>();
  return async (c, next) => {
    const project = deps.projectSession.get();
    if (project && !watched.has(project.db)) {
      watched.add(project.db);
      onJobSettled(project.db, (job) => deps.collab.bump(JOB_AREAS[job.kind] ?? ['jobs'], { actor_id: job.actor?.id ?? null, verb: 'finished' }));
    }
    await next();
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.res.status >= 400) return;
    const { route, areas } = areasOf(c.req.method, c.req.path);
    if (areas.length === 0) return;
    let where: { scene_no: string | null; shot_code: string | null } = { scene_no: null, shot_code: null };
    const db = deps.projectSession.get()?.db;
    if (db) {
      try {
        where = whereOf(db, c.req.path);
        // a new shot has no id in the path: read it from the answer
        if (route === 'createShot' && !where.shot_code) {
          const made = ((await c.res.clone().json()) as { data?: { id?: string } }).data;
          if (made?.id) where = whereOf(db, `/api/v1/shots/${made.id}`);
        }
      } catch {
        // an archived or deleted target: the areas still move
      }
    }
    const tab = c.req.header('x-ssm-tab')?.slice(0, 64) ?? null;
    deps.collab.bump(areas, { actor_id: actorId(), verb: verbOf(route), ...where, tab });
  };
}

export function registerCollabRoutes(app: Hono, deps: AppDeps): void {
  app.get(Api.collabChanges.path, (c: Context) => {
    const parsed = CollabChangesQuery.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '参数不对', 400);
    const q = parsed.data;
    const actor = currentActor();
    if (actor) deps.collab.touch(actor.id, q.tab, { page: q.page, focus: q.focus ?? null, hidden: q.hidden });
    const db = deps.projectSession.get()?.db;
    const resolve = db ? actorResolver(db) : () => null;
    const data = deps.collab.changes(q, { roster: currentRequest()?.roster() ?? [], me: actor?.id ?? null, actor: resolve });
    return respond(c, CollabChanges, data);
  });
}

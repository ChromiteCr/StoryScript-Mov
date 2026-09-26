import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { Api, SessionInput } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { parseBody } from '../http/validate.ts';
import { UNAUTHORIZED_MESSAGE } from '../security/guards.ts';
import { SESSION_COOKIE } from '../security/sessions.ts';

/** POST /api/v1/session — exchange the launch token for an HttpOnly session cookie. */
export function registerSessionRoutes(app: Hono, deps: AppDeps): void {
  app.post(Api.session.path, async (c) => {
    const { token } = await parseBody(c, SessionInput);
    const id = deps.sessions.exchange(token);
    if (!id) throw new AppError('UNAUTHORIZED', `令牌无效。${UNAUTHORIZED_MESSAGE}`, 401);
    setCookie(c, SESSION_COOKIE, id, { httpOnly: true, sameSite: 'Strict', path: '/' });
    return c.body(null, 204);
  });
}

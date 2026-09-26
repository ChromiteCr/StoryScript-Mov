import { randomBytes } from 'node:crypto';
import { safeEqual } from './token.ts';

export const SESSION_COOKIE = 'ssm_session';

/**
 * In-memory browser sessions: the launch token is exchanged once per browser
 * for a random session id carried in an HttpOnly cookie. Sessions live as long
 * as the process; the store is capped so repeated exchanges cannot grow it.
 */
export class SessionStore {
  private readonly ids = new Set<string>();

  constructor(
    private readonly token: string,
    private readonly max = 64,
  ) {}

  /** Exchange the launch token for a new session id; null if the token is wrong. */
  exchange(candidate: string): string | null {
    if (!safeEqual(candidate, this.token)) return null;
    const id = randomBytes(32).toString('base64url');
    if (this.ids.size >= this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(id);
    return id;
  }

  has(id: string | undefined): boolean {
    return typeof id === 'string' && id.length > 0 && this.ids.has(id);
  }

  revoke(id: string): void {
    this.ids.delete(id);
  }

  get size(): number {
    return this.ids.size;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorRef, GroupRole, ModelSource } from '@storyscript/contracts';
import type { DbPort } from '../db/port.ts';

/**
 * S4 — who is making this request. On the hosted server the gateway (the
 * only thing that reads the session cookie) hands each group instance the
 * signed-in account in the request env — never in a header a browser could
 * set. The instance keeps it in an AsyncLocalStorage for the rest of the
 * request, so services and repositories stamp history rows without every
 * function taking an extra argument. Jobs capture it when they are queued.
 * The local single-user app has no actor: everything stays null.
 */

export interface Actor {
  id: string;
  name: string;
  role: GroupRole;
  crew_roles: string[];
  /** whose text / image model this member uses in this group */
  text_source: ModelSource;
  image_source: ModelSource;
}

/** A teammate as the group sees them (never an email). */
export interface RosterEntry {
  id: string;
  name: string;
  role: GroupRole;
  crew_roles: string[];
}

/** What the gateway hands a group instance with each request (c.env.hosted). */
export interface HostedRequest {
  actor: Actor;
  /** the group's members right now */
  roster: () => RosterEntry[];
  /** this account's own settings folder (its own model), chosen by the gateway */
  personalDir: string;
}

const als = new AsyncLocalStorage<HostedRequest | null>();

export function runWithRequest<T>(req: HostedRequest | null, fn: () => T): T {
  return als.run(req, fn);
}

export function currentRequest(): HostedRequest | null {
  return als.getStore() ?? null;
}

export function currentActor(): Actor | null {
  return currentRequest()?.actor ?? null;
}

export function actorId(): string | null {
  return currentActor()?.id ?? null;
}

/** Reads c.env.hosted as the gateway set it; anything else (a browser cannot set env) is ignored. */
export function hostedRequestOf(env: unknown): HostedRequest | null {
  const h = (env as { hosted?: unknown } | undefined)?.hosted as Partial<HostedRequest> | undefined;
  if (!h || typeof h !== 'object' || !h.actor || typeof h.roster !== 'function' || typeof h.personalDir !== 'string') return null;
  return h as HostedRequest;
}

// ---------------------------------------------------------------- members --

const synced = new WeakMap<DbPort, Map<string, string>>();

/**
 * Keep the project's `member` table up to date with the actor, so history
 * rows show the current name and crew roles, and departed people keep a name.
 */
export function syncMember(db: DbPort, actor: Actor, now = new Date().toISOString()): void {
  let seen = synced.get(db);
  if (!seen) synced.set(db, (seen = new Map()));
  const key = JSON.stringify([actor.name, actor.crew_roles]);
  if (seen.get(actor.id) === key) return;
  db.run(
    `INSERT INTO member (id, name, crew_roles_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, crew_roles_json = excluded.crew_roles_json, updated_at = excluded.updated_at`,
    actor.id,
    actor.name,
    JSON.stringify(actor.crew_roles),
    now,
  );
  seen.set(actor.id, key);
}

/**
 * id → ActorRef for API rows (memoised per call site). A member no longer in
 * the group shows `left`; outside a hosted request nobody has "left".
 */
export function actorResolver(db: DbPort): (id: string | null | undefined) => ActorRef | null {
  const cache = new Map<string, ActorRef | null>();
  const roster = currentRequest()?.roster();
  const inGroup = roster ? new Map(roster.map((r) => [r.id, r] as const)) : null;
  return (id) => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id)!;
    // someone in the group now: their current name and crew roles (a teammate may have just changed them)
    const live = inGroup?.get(id);
    if (live) {
      const ref: ActorRef = { id, name: live.name, crew_roles: [...live.crew_roles], left: false };
      cache.set(id, ref);
      return ref;
    }
    const row = db.get<{ name: string; crew_roles_json: string }>('SELECT name, crew_roles_json FROM member WHERE id = ?', id);
    let roles: string[] = [];
    try {
      const v: unknown = JSON.parse(row?.crew_roles_json ?? '[]');
      roles = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      roles = [];
    }
    const ref: ActorRef = { id, name: row?.name ?? '已离开的组员', crew_roles: roles, left: inGroup ? !inGroup.has(id) : false };
    cache.set(id, ref);
    return ref;
  };
}

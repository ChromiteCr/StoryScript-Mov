import { CREW_ROLE_PRESETS, CREW_ROLES_MAX, type ActorRef } from '@storyscript/contracts';

/**
 * S4 — crew roles (导演、摄影…) and how a teammate is named next to their
 * changes. Pure: the checks mirror the contract's CrewRole (1–8 characters,
 * no spaces, @ or commas, at most 6 per person) so the form can say what is
 * wrong before the request goes out; the server checks again.
 */

export const CREW_PRESETS: readonly string[] = CREW_ROLE_PRESETS;
export const CREW_ROLE_MAX_LENGTH = 8;
export const CREW_ROLES_LIMIT = CREW_ROLES_MAX;

/** Same character class as the contract: whitespace, @ and the three comma forms are not allowed. */
const FORBIDDEN = /[\s@,，、]/;

/** What is wrong with one role typed by hand; null = fine. `taken`: the roles already on the list. */
export function crewRoleProblem(raw: string, taken: readonly string[] = []): string | null {
  const role = raw.trim();
  if (role === '') return '请填写职务';
  if (role.length > CREW_ROLE_MAX_LENGTH) return `职务最多 ${CREW_ROLE_MAX_LENGTH} 个字`;
  if (FORBIDDEN.test(role)) return '职务里不能有空格、@ 或逗号';
  if (taken.includes(role)) return `已经有「${role}」了`;
  if (taken.length >= CREW_ROLES_LIMIT) return `最多 ${CREW_ROLES_LIMIT} 个职务，先去掉一个`;
  return null;
}

/** Trim, drop empty and repeated entries, keep the first 6. What is sent to the server. */
export function normalizeCrewRoles(roles: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roles) {
    const role = r.trim();
    if (role !== '' && !out.includes(role)) out.push(role);
  }
  return out.slice(0, CREW_ROLES_LIMIT);
}

/** Add a role by hand (or a preset). A problem leaves the list as it was. */
export function addCrewRole(list: readonly string[], raw: string): { roles: string[]; problem: string | null } {
  const problem = crewRoleProblem(raw, list);
  return problem ? { roles: [...list], problem } : { roles: [...list, raw.trim()], problem: null };
}

/** Preset chip pressed: take the role off if it is there, else add it (respecting the cap). */
export function toggleCrewRole(list: readonly string[], role: string): { roles: string[]; problem: string | null } {
  if (list.includes(role)) return { roles: list.filter((r) => r !== role), problem: null };
  return addCrewRole(list, role);
}

export function sameCrewRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/** "导演、摄影" */
export function crewRolesText(roles: readonly string[]): string {
  return roles.join('、');
}

/** The roles chips to offer: the presets first, then any custom role the person already has. */
export function roleChoices(current: readonly string[]): string[] {
  return [...CREW_PRESETS, ...current.filter((r) => !CREW_PRESETS.includes(r))];
}

/** "阿杰（导演、摄影）", or just "阿杰" when no roles are set. */
export function actorText(actor: { name: string; crew_roles: readonly string[] }): string {
  return actor.crew_roles.length > 0 ? `${actor.name}（${crewRolesText(actor.crew_roles)}）` : actor.name;
}

/** Name only, for tight places such as a <select> option: "阿杰"; "阿杰（已离开）" once they left. */
export function actorShortText(actor: Pick<ActorRef, 'name' | 'left'>): string {
  return actor.left ? `${actor.name}（已离开）` : actor.name;
}

/**
 * A sentence fragment around the actor: "阿杰（导演）发起", "由 阿杰（导演） 批准".
 * Nothing (null) without an actor, which is every row made on the local app.
 */
export function actorPhrase(actor: ActorRef | null | undefined, before = '', after = ''): string | null {
  if (!actor) return null;
  return `${before}${actorText(actor)}${after}`;
}

/** Whether the row belongs to someone other than the signed-in member (`myId` null: not hosted, nobody is "other"). */
export function isOtherActor(actor: ActorRef | null | undefined, myId: string | null): boolean {
  return Boolean(actor && myId !== null && actor.id !== myId);
}

/** A group's roster as one line: "阿杰（导演）、小林（摄影）". */
export function rosterText(members: readonly { name: string; crew_roles: readonly string[] }[]): string {
  return members.map((m) => actorText(m)).join('、');
}

import type { ModelSource } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { currentActor, currentRequest } from './actor.ts';

/**
 * S4 — whose model a request uses. Locally: the one settings folder. On the
 * hosted server each member picks, per group, the group's model (set by the
 * leader, in the group's state folder) or their own (in their account
 * folder, which only the gateway names). There is no silent fallback either
 * way: a member who chose their own model and has not filled it in gets a
 * clear 409, never the leader's key.
 */

export type ModelKind = 'text' | 'image';

export interface ModelSettingsDir {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** null locally */
  source: ModelSource | null;
}

export function groupModelDir(deps: AppDeps): ModelSettingsDir {
  return { dir: deps.stateDir, env: deps.env, source: deps.hosted ? 'group' : null };
}

/** The member's own settings folder (hosted, signed in), else null. */
export function ownModelDir(): ModelSettingsDir | null {
  const req = currentRequest();
  return req ? { dir: req.personalDir, env: {}, source: 'own' } : null;
}

/** The folder this request's AI calls read, following the member's choice. */
export function modelDir(deps: AppDeps, kind: ModelKind): ModelSettingsDir {
  const actor = currentActor();
  if (!deps.hosted || !actor) return groupModelDir(deps);
  const source = kind === 'text' ? actor.text_source : actor.image_source;
  return source === 'own' ? (ownModelDir() ?? groupModelDir(deps)) : groupModelDir(deps);
}

export const OWN_NOT_CONFIGURED: Record<ModelKind, string> = {
  text: '你选了用自己的文本模型，但还没填好：到「设置 → 模型 → 我的模型」填写 base_url、key 和模型名，或改用组的模型。',
  image: '你选了用自己的图像模型，但还没填好：到「设置 → 模型 → 我的模型」填写，或改用组的模型。',
};

/** Hosted: only the group's leader changes the group's model settings. */
export function requireLeader(deps: AppDeps): void {
  if (!deps.hosted) return;
  const actor = currentActor();
  if (!actor || actor.role !== 'leader') throw new AppError('FORBIDDEN', '组的模型设置只有组长能改，请组长修改。你可以在「我的模型」里填自己的。', 403);
}

/** Hosted: the group's key digits and editing are for the leader; locally always. */
export function canEditGroupModel(deps: AppDeps): boolean {
  if (!deps.hosted) return true;
  return currentActor()?.role === 'leader';
}

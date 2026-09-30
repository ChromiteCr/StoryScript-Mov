import type { HealthInfo, ImageProviderView, ModelSource, ProvidersView, TextProviderView } from '@storyscript/contracts';

/**
 * S4 hosted server — whose model the AI features use. A group has its own
 * model (set by the leader); every member may also fill in a model of their
 * own and choose, per group and separately for text and image, which one
 * their requests use. There is no silent fallback: a member who chose
 * their own model and has not filled it in gets a warning here and a 409
 * from the server, never the leader's key.
 */

export type ModelKind = 'text' | 'image';
/** group: the settings the leader manages; me: the signed-in member's own */
export type ModelScope = 'group' | 'me';

export const MODEL_KIND_LABEL: Record<ModelKind, string> = { text: '文本模型', image: '图像模型' };
export const MODEL_SOURCE_LABEL: Record<ModelSource, string> = { group: '组的模型', own: '我的模型' };

/** Notice on the group's settings for a member (the leader edits them; a member cannot). */
export const GROUP_READ_ONLY = {
  title: '只有组长能改本组的模型。',
  body: '你可以在下面填自己的模型，并选择在本组用哪一个。',
} as const;

export const OWN_KEY_NOTE = '你的 key 只有你自己看得到（组长和组员都看不到），保存在服务器上你自己的账号设置里。你在哪个小组选了「我的模型」，那个小组里你发起的 AI 请求就用它；其他人用的是他们自己选的模型。';

export const CHOICE_HINT: Record<ModelSource, string> = {
  group: '用组长配置的模型；用量计入本组的每日上限。',
  own: '用你自己的模型和 key，费用由你自己承担；不计入本组的每日上限。',
};

/** A text model is usable once address, model name and key are all there. */
function hasKey(view: TextProviderView | ImageProviderView | null | undefined): boolean {
  return Boolean(view && view.base_url !== '' && view.model !== '' && view.key_last4 !== null);
}

/** The member's own model of this kind is filled in (their own view always shows their key digits). */
export function ownConfigured(kind: ModelKind, mine: ProvidersView | undefined): boolean {
  return hasKey(kind === 'text' ? mine?.text : mine?.image);
}

/** Warning under the 在本组使用 choice: 我的模型 chosen but not filled in; null when nothing is wrong. */
export function ownChoiceWarning(kind: ModelKind, choice: ModelSource, mine: ProvidersView | undefined): string | null {
  if (choice !== 'own' || ownConfigured(kind, mine)) return null;
  return `你选了用自己的${MODEL_KIND_LABEL[kind]}，但还没填好：先在下面「我的模型」里填写地址、模型名和 key。填好之前，本组里需要它的 AI 功能对你不可用；不会自动改用组的模型。`;
}

/**
 * The 状态 row of a settings panel. The health flags follow the member's
 * EFFECTIVE model, so a panel reads them only when it shows that model;
 * the other one is judged from its own view (a member cannot see the
 * group's key digits, so an address and a model name count as filled in).
 */
export function panelConfigured(p: {
  kind: ModelKind;
  scope: ModelScope;
  health: Pick<HealthInfo, 'hosted' | 'text_provider_configured' | 'image_provider_configured' | 'text_model_source' | 'image_model_source'> | undefined;
  view: TextProviderView | ImageProviderView | null;
  /** the panel is the group's and the viewer cannot edit it (no key digits in the view) */
  readOnly?: boolean;
}): boolean {
  const { health, view, kind, scope } = p;
  if (!health) return false;
  const flag = kind === 'text' ? health.text_provider_configured : health.image_provider_configured;
  if (!health.hosted) return flag;
  const effective: ModelSource | null | undefined = kind === 'text' ? health.text_model_source : health.image_model_source;
  const shown: ModelSource = scope === 'me' ? 'own' : 'group';
  if ((effective ?? 'group') === shown) return flag;
  if (!view || view.base_url === '' || view.model === '') return false;
  return p.readOnly ? true : view.key_last4 !== null;
}

type GateHealth = Pick<HealthInfo, 'text_provider_configured' | 'demo'> & Partial<Pick<HealthInfo, 'hosted' | 'text_model_source'>>;

/** Why the AI buttons are off when no text model is usable; the wording depends on whose model the member uses. */
export function textNotConfiguredReason(health: Pick<GateHealth, 'hosted' | 'text_model_source'>): string {
  if (health.hosted && health.text_model_source === 'own') {
    return '你选了自己的文本模型，但还没填好：在"设置 → 模型 → 我的模型"里填写，或者改用组的模型。手工流程不受影响。';
  }
  if (health.hosted) {
    return '组长还没配置本组的模型：请组长在"设置 → 模型"里填写；你也可以在"我的模型"里填自己的，并选择在本组使用。手工流程不受影响。';
  }
  return '未配置文本模型：在"设置 → 模型"中填写后可用。手工流程不受影响。';
}

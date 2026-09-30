import type { ActorRef } from '@storyscript/contracts';
import { actorPhrase } from '../lib/crew.ts';
import { Tag } from './ui.tsx';

/**
 * Who made a change (S4, hosted server): "阿杰（导演）", with a 已离开 tag
 * once they are no longer in the group. Renders nothing without an actor,
 * which is every row made on the local app. `before` / `after` wrap the name
 * in one sentence: "由 阿杰（导演） 批准", "阿杰（导演）发起".
 */
export function ActorLabel({
  actor,
  before = '',
  after = '',
  className = '',
}: {
  actor: ActorRef | null | undefined;
  before?: string;
  after?: string;
  className?: string;
}) {
  const text = actorPhrase(actor, before, after);
  if (!actor || text === null) return null;
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 ${className}`}>
      <span className="min-w-0 break-words">{text}</span>
      {actor.left ? <Tag>已离开</Tag> : null}
    </span>
  );
}

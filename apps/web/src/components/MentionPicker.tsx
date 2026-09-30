import type { MentionCandidate } from '../lib/mentions.ts';
import { crewRolesText } from '../lib/crew.ts';
import { Tag } from './ui.tsx';

export const mentionOptionId = (listId: string, index: number): string => `${listId}-opt-${index}`;

/**
 * The list under the comment box while someone types `@`: members (with their
 * crew roles) and roles (with who holds them). The text box keeps the focus;
 * the box's owner moves `active` with the arrow keys and picks with Enter,
 * so this only draws the options and takes a tap or click.
 */
export function MentionPicker({
  id,
  candidates,
  active,
  onPick,
  onHover,
}: {
  id: string;
  candidates: readonly MentionCandidate[];
  active: number;
  onPick: (c: MentionCandidate) => void;
  onHover: (index: number) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      id={id}
      role="listbox"
      aria-label="提到组员或职务"
      className="max-h-48 overflow-auto rounded-panel border border-graphite-700 bg-graphite-800 py-1"
    >
      {candidates.map((c, i) => (
        <div
          key={c.key}
          id={mentionOptionId(id, i)}
          role="option"
          aria-selected={i === active}
          // keep the focus in the text box: a tap on an option must not blur it
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
          onMouseEnter={() => onHover(i)}
          className={`flex min-h-8 cursor-pointer items-center gap-2 px-2.5 py-1 text-sm text-graphite-100 ${i === active ? 'bg-graphite-700' : ''}`}
        >
          <span className="shrink-0 font-medium">@{c.label}</span>
          {c.kind === 'role' ? <Tag>职务</Tag> : null}
          <span className="min-w-0 flex-1 truncate text-xs text-graphite-300">
            {c.kind === 'member' ? (c.member.crew_roles.length > 0 ? crewRolesText(c.member.crew_roles) : '') : c.holders.map((h) => h.name).join('、')}
          </span>
        </div>
      ))}
    </div>
  );
}

import type { DraftIssue } from '@storyscript/contracts';
import { varietyLines, VARIETY_TITLE } from '../../lib/variety.ts';
import { Notice } from '../../components/ui.tsx';

/**
 * 「镜头变化」: the draft's variety warnings in one box (S4c), with where to
 * fix them. A hint, not a blocker: the ticks and 应用所选 stay as they are.
 * Nothing is rendered when the draft has none.
 */
export function VarietyNotice({ issues, hint }: { issues: readonly DraftIssue[]; hint: string }) {
  const lines = varietyLines(issues);
  if (lines.length === 0) return null;
  return (
    <Notice tone="warn" title={VARIETY_TITLE} role="note">
      <ul className="flex flex-col gap-1">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-1.5 text-graphite-100">
            {l.where ? <span className="shrink-0 text-graphite-300 tabular-nums">{l.where}</span> : null}
            <span className="min-w-0 break-words">{l.message}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5">{hint}</p>
    </Notice>
  );
}

import { CircleAlert } from 'lucide-react';
import { describeError, type ErrorContext } from '../lib/errors.ts';

/** Plain-language error box; the raw code sits behind a disclosure for bug reports. */
export function ErrorNotice({ error, context = 'general', className = '' }: { error: unknown; context?: ErrorContext; className?: string }) {
  const human = describeError(error, context);
  return (
    <div role="alert" className={`flex gap-2.5 rounded-sheet border border-danger-rule bg-danger-bg px-3 py-2.5 ${className}`}>
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 text-[13px]">
        <p className="font-medium text-danger">{human.title}</p>
        {human.detail ? <p className="mt-0.5 text-ink-2">{human.detail}</p> : null}
        {human.technical ? (
          <details className="mt-1 text-xs text-ink-3">
            <summary className="cursor-pointer select-none hover:text-ink-2">技术信息</summary>
            <p className="mt-1 font-mono break-all">{human.technical}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

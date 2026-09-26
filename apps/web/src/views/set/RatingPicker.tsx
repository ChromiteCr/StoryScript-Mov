import type { KeyboardEvent } from 'react';
import type { TakeRating } from '@storyscript/contracts';
import { RATING_KEYS, RATING_LABEL } from '../../lib/labels-media.ts';
import { RATING_ICON } from '../media/shared.tsx';

/**
 * Four rating buttons as a radio group (←/→ move, digits 1/2/3/0 work page-wide
 * on the set page). The chosen one is filled light; the icon carries the tone.
 */
export function RatingPicker({ value, onChange, label = '评级', size = 'md' }: { value: TakeRating; onChange: (r: TakeRating) => void; label?: string; size?: 'md' | 'sm' }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = RATING_KEYS.findIndex((k) => k.rating === value);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = RATING_KEYS[(at + d + RATING_KEYS.length) % RATING_KEYS.length]!;
    onChange(next.rating);
    e.currentTarget.querySelector<HTMLButtonElement>(`button[data-rating="${next.rating}"]`)?.focus();
  };
  const h = size === 'md' ? 'h-8 px-2.5 text-sm' : 'h-6 px-2 text-xs';
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="flex flex-wrap items-center gap-1">
      {RATING_KEYS.map(({ key, rating }) => {
        const on = rating === value;
        const { icon: Icon, tint } = RATING_ICON[rating];
        return (
          <button
            key={rating}
            type="button"
            role="radio"
            aria-checked={on}
            data-rating={rating}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(rating)}
            className={
              `inline-flex items-center gap-1.5 rounded-control border ${h} ` +
              (on
                ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950'
                : 'border-graphite-700 bg-graphite-800 text-graphite-100 hover:border-graphite-500')
            }
          >
            <Icon aria-hidden className={`size-3.5 ${on ? 'text-graphite-950' : tint}`} />
            {RATING_LABEL[rating]}
            {size === 'md' ? (
              <kbd aria-hidden className={`ml-0.5 font-sans text-xs tabular-nums ${on ? 'text-graphite-800' : 'text-graphite-300'}`}>
                {key}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

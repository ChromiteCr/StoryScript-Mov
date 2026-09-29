import { useId } from 'react';
import { StyleLevel, type StyleCard } from '@storyscript/contracts';
import { LEVEL_HINT, LEVEL_LABEL } from '@storyscript/core';
import { SelectInput } from '../../components/ui.tsx';

/**
 * Shared style controls: the breakdown form and the library's "本组默认"
 * both pick a style card and a difficulty the same way.
 */

const ROW = 'grid grid-cols-[72px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5';

/** 风格: a select of 不指定, the built-in cards and the group's own. */
export function StyleSelectRow({
  cards,
  value,
  onChange,
  disabled,
  hint,
}: {
  cards: readonly StyleCard[];
  /** a card id; '' = 不指定 */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** shown under the select; defaults to the chosen card's summary */
  hint?: string;
}) {
  const id = useId();
  const builtin = cards.filter((c) => c.origin === 'builtin');
  const own = cards.filter((c) => c.origin !== 'builtin');
  const chosen = cards.find((c) => c.id === value) ?? null;
  const note = hint ?? (chosen ? [chosen.summary, chosen.unverified ? '（研究得到，未核实）' : ''].filter(Boolean).join('') : null);
  return (
    <div className={`${ROW} items-center`}>
      <label htmlFor={id} className="text-xs leading-5 text-graphite-300">
        风格
      </label>
      <SelectInput id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">不指定</option>
        {own.length > 0 ? (
          <optgroup label="本组风格">
            {own.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="内置风格">
          {builtin.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      </SelectInput>
      {note ? <p className="col-start-2 text-xs text-graphite-300">{note}</p> : null}
    </div>
  );
}

/** 难度: three toggle buttons (稳妥 / 进取 / 挑战) and the chosen one's hint. */
export function LevelRow({ value, onChange, disabled }: { value: StyleLevel; onChange: (level: StyleLevel) => void; disabled?: boolean }) {
  const labelId = useId();
  return (
    <div className={ROW}>
      <span id={labelId} className="text-xs leading-6 text-graphite-300">
        难度
      </span>
      <div role="group" aria-labelledby={labelId} className="flex gap-1">
        {StyleLevel.options.map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={value === l}
            disabled={disabled}
            onClick={() => onChange(l)}
            className={
              'h-6 min-w-0 flex-1 rounded-control border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ' +
              (value === l ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:enabled:text-graphite-100')
            }
          >
            {LEVEL_LABEL[l]}
          </button>
        ))}
      </div>
      <p className="col-start-2 text-xs text-graphite-300">{LEVEL_HINT[value]}</p>
    </div>
  );
}

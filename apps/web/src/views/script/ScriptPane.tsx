import { memo, useEffect, useMemo, useRef } from 'react';
import type { Paragraph, Scene } from '@storyscript/contracts';
import { splitAroundQuote } from '../../lib/shots.ts';
import type { Highlight } from './context.ts';

/**
 * Left column: the script text, one block per paragraph anchor (p-001…).
 * Script text is data (INV-10): rendered as React text only.
 */

export const paragraphDomId = (id: string) => `para-${id}`;
export const sceneDomId = (id: string) => `scene-${id}`;

interface ParagraphRowProps {
  p: Paragraph;
  scene: Scene | null;
  active: boolean;
  quote: string | null;
  onHeadingClick: (scene: Scene) => void;
}

const ParagraphRow = memo(function ParagraphRow({ p, scene, active, quote, onHeadingClick }: ParagraphRowProps) {
  const parts = active ? splitAroundQuote(p.text, quote) : null;
  const body = parts ? (
    <>
      {parts[0]}
      <mark className="rounded-[2px] bg-mark px-0.5 text-ink">{parts[1]}</mark>
      {parts[2]}
    </>
  ) : (
    p.text
  );

  return (
    <div
      id={paragraphDomId(p.id)}
      data-paragraph={p.id}
      className={
        'group grid scroll-mt-24 grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2 rounded-control px-1 py-1 [content-visibility:auto] ' +
        (active ? 'bg-mark/60 ring-1 ring-mark-rule' : '')
      }
    >
      <span className="pt-[3px] text-right font-mono text-[10.5px] text-ink-3 tabular-nums select-none">{p.id}</span>
      {p.is_heading && scene ? (
        <button
          type="button"
          onClick={() => onHeadingClick(scene)}
          className="text-left text-[14px] leading-relaxed font-semibold break-words whitespace-pre-wrap text-ink hover:underline"
          title="在右侧查看这一场的镜头"
        >
          <span className="mr-2 inline-block rounded-control border border-graphite px-1 font-mono text-[11px] leading-4 font-medium">{scene.display_no}</span>
          {body}
        </button>
      ) : (
        <p className={`text-[13.5px] leading-relaxed break-words whitespace-pre-wrap ${p.scene_idx === null ? 'text-ink-3' : 'text-ink'}`}>{body}</p>
      )}
    </div>
  );
});

export interface ScriptPaneProps {
  paragraphs: readonly Paragraph[];
  scenes: readonly Scene[];
  highlight: Highlight | null;
  onHeadingClick: (scene: Scene) => void;
}

export function ScriptPane({ paragraphs, scenes, highlight, onHeadingClick }: ScriptPaneProps) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlight) return;
    const el = document.getElementById(paragraphDomId(highlight.paragraphId));
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [highlight]);

  // scene membership comes from Scene.paragraph_ids (robust to ordering); scene_idx is the fallback
  const byParagraph = useMemo(() => {
    const m = new Map<string, Scene>();
    for (const s of scenes) for (const pid of s.paragraph_ids) m.set(pid, s);
    return m;
  }, [scenes]);
  const sceneOf = (p: Paragraph): Scene | null =>
    p.is_heading ? (byParagraph.get(p.id) ?? (p.scene_idx !== null ? (scenes[p.scene_idx] ?? null) : null)) : null;

  return (
    <div ref={box} className="flex flex-col gap-0.5">
      {paragraphs.map((p) => {
        const active = highlight?.paragraphId === p.id;
        return (
          <ParagraphRow
            key={p.id}
            p={p}
            scene={sceneOf(p)}
            active={active}
            quote={active ? (highlight?.quote ?? null) : null}
            onHeadingClick={onHeadingClick}
          />
        );
      })}
    </div>
  );
}

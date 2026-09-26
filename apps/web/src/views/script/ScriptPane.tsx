import { memo, useEffect, useMemo } from 'react';
import type { Paragraph, Scene } from '@storyscript/contracts';
import { splitAroundQuote } from '../../lib/shots.ts';
import { PaperCanvas, Panel } from '../../components/workspace.tsx';
import { paragraphDomId, sceneHeadingDomId, useWorkspace, type Highlight } from './context.ts';

/**
 * The script on paper (PaperCanvas sheet, 15px / 1.8), one block per
 * paragraph anchor (p-001…). Script text is data (INV-10): React text only.
 * The paragraph a shot points at is washed in non-photo blue, the colour of
 * the current selection.
 */

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
      <mark className="rounded-[2px] bg-accent/55 text-ink">{parts[1]}</mark>
      {parts[2]}
    </>
  ) : (
    p.text
  );

  const heading = p.is_heading && scene;
  return (
    <div
      id={heading ? sceneHeadingDomId(scene.id) : paragraphDomId(p.id)}
      data-paragraph={p.id}
      className={
        // Wide sheets hang the anchor number in the 48px margin: -ml-11 (44px) =
        // 8px padding + 28px number column + 8px gap, so the highlight stays on the paper.
        'group relative -mx-2 grid scroll-mt-6 grid-cols-[minmax(0,1fr)] rounded-paper px-2 [content-visibility:auto] md:-ml-11 md:grid-cols-[1.75rem_minmax(0,1fr)] md:gap-x-2 ' +
        (heading ? 'mt-5 first:mt-0 ' : 'mt-2 first:mt-0 ') +
        (active ? 'bg-accent/20 ring-1 ring-accent-strong/50' : '')
      }
    >
      {/* the anchor id: in the margin on wide sheets, hidden on narrow ones */}
      <span aria-hidden className="hidden pt-[5px] text-right text-xs text-ink/60 tabular-nums select-none md:block">
        {p.id.slice(2)}
      </span>
      {heading ? (
        <h3 className="text-base">
          <button
            type="button"
            onClick={() => onHeadingClick(scene)}
            className="text-left font-medium break-words whitespace-pre-wrap text-ink hover:underline hover:decoration-ink/40 hover:underline-offset-4"
            title="在镜头表中查看这一场"
          >
            <span className="mr-2 inline-block rounded-control border border-ink/50 px-1 align-[2px] text-xs leading-4 tabular-nums">{scene.display_no}</span>
            {body}
          </button>
        </h3>
      ) : (
        <p className={`break-words whitespace-pre-wrap ${p.scene_idx === null ? 'text-ink/75' : 'text-ink'}`}>
          <span className="sr-only">{p.id} </span>
          {body}
        </p>
      )}
    </div>
  );
});

export function ScriptPane() {
  const ws = useWorkspace();
  const { paragraphs, scenes } = { paragraphs: ws.script.version.paragraphs, scenes: ws.script.scenes };
  const highlight: Highlight | null = ws.highlight;

  useEffect(() => {
    if (!highlight || highlight.scroll === 'none') return;
    const p = ws.paragraphs.get(highlight.paragraphId);
    const scene = p?.is_heading ? scenes.find((s) => s.paragraph_ids[0] === p.id) : undefined;
    const el = document.getElementById(scene ? sceneHeadingDomId(scene.id) : paragraphDomId(highlight.paragraphId));
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: highlight.scroll, behavior: reduce ? 'auto' : 'smooth' });
    // each locate request is a new Highlight object; a script refetch does not scroll
  }, [highlight]);

  // scene membership comes from Scene.paragraph_ids (robust to ordering); scene_idx is the fallback
  const byParagraph = useMemo(() => {
    const m = new Map<string, Scene>();
    for (const s of scenes) for (const pid of s.paragraph_ids) m.set(pid, s);
    return m;
  }, [scenes]);
  const sceneOf = (p: Paragraph): Scene | null =>
    p.is_heading ? (byParagraph.get(p.id) ?? (p.scene_idx !== null ? (scenes[p.scene_idx] ?? null) : null)) : null;

  const onHeadingClick = (scene: Scene) => ws.selectScene(scene, { reveal: true });

  return (
    <Panel title={`剧本原文 · ${paragraphs.length} 段`}>
      <PaperCanvas label="剧本原文">
        {paragraphs.map((p) => {
          const active = highlight?.paragraphId === p.id;
          return (
            <ParagraphRow key={p.id} p={p} scene={sceneOf(p)} active={active} quote={active ? (highlight?.quote ?? null) : null} onHeadingClick={onHeadingClick} />
          );
        })}
      </PaperCanvas>
    </Panel>
  );
}

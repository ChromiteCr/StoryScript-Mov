import { useMemo } from 'react';
import type { Shot } from '@storyscript/contracts';
import { groupShotsByScene } from '../../lib/shots.ts';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { useWorkspace } from './context.ts';

/**
 * Scene navigator (left column): number, heading, shot count; the scene shown
 * in the inspector is the selected one. Click scrolls the script and the shot
 * table to it.
 */
export function ScenesPanel({ shots }: { shots: readonly Shot[] }) {
  const ws = useWorkspace();
  const grouped = useMemo(() => groupShotsByScene(shots), [shots]);
  const t = ws.inspector;
  const selectedScene = !t ? null : t.kind === 'shot' ? (shots.find((s) => s.id === t.shotId)?.scene_id ?? null) : t.sceneId;

  return (
    <Panel title={`场次 ${ws.script.scenes.length}`} padded={false}>
      {ws.script.scenes.length === 0 ? (
        <EmptyState quiet title="当前版本没有场次。" description="导入新版本时，在预览里把场次标题行标为「场」。" />
      ) : (
        <ol className="py-1">
          {ws.script.scenes.map((scene) => {
            const list = grouped.get(scene.id) ?? [];
            const relink = list.filter((s) => s.needs_relink).length;
            const draft = ws.pendingDraftByScene.has(scene.id);
            const selected = scene.id === selectedScene;
            return (
              <li key={scene.id}>
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => ws.selectScene(scene, { reveal: true })}
                  title={scene.heading}
                  className={
                    'relative flex w-full items-start gap-2 py-1.5 pr-3 pl-4 text-left focus-visible:outline-offset-[-2px] ' +
                    (selected ? 'bg-graphite-800' : 'hover:bg-graphite-800/60')
                  }
                >
                  {selected ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-graphite-300" /> : null}
                  <span className="w-7 shrink-0 pt-px text-xs text-graphite-300 tabular-nums">{scene.display_no}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${selected ? 'font-medium text-graphite-100' : 'text-graphite-100'}`}>{scene.heading}</span>
                    <span className="flex items-center gap-2 text-xs text-graphite-300 tabular-nums">
                      <span>{list.length} 镜</span>
                      {draft ? (
                        <span className="inline-flex items-center gap-1">
                          <span aria-hidden className="size-1.5 rounded-full bg-graphite-100" />
                          草案待审
                        </span>
                      ) : null}
                      {relink > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
                          {relink} 待关联
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

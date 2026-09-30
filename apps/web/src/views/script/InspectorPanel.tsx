import type { Scene, Shot } from '@storyscript/contracts';
import { MousePointerClick } from 'lucide-react';
import { CommentsPanel } from '../../components/CommentsPanel.tsx';
import { EmptyState } from '../../components/workspace.tsx';
import { useIsHosted } from '../../lib/queries-comments.ts';
import { SceneInspector } from './SceneInspector.tsx';
import { ShotEditor } from './ShotEditor.tsx';
import { useWorkspace, type InspectorTarget } from './context.ts';
import { useOpenShotRequests } from './openShot.tsx';

/** Title of the inspector panel / drawer for the current target. */
export function inspectorTitle(target: InspectorTarget | null, shots: readonly Shot[], scenes: readonly Scene[]): string {
  if (!target) return '检查器';
  if (target.kind === 'shot') {
    const shot = shots.find((s) => s.id === target.shotId);
    return shot ? `镜头 ${shot.code}` : '镜头';
  }
  const scene = scenes.find((s) => s.id === target.sceneId);
  const no = scene ? `第 ${scene.display_no} 场` : '场次';
  return target.kind === 'create' ? `新建镜头 · ${no}` : no;
}

/** Scene setup + AI breakdown, the shot editor (with the shot's comments on the hosted server), or the new-shot form. */
export function InspectorBody({ target, shots }: { target: InspectorTarget | null; shots: readonly Shot[] }) {
  const ws = useWorkspace();
  const hosted = useIsHosted();
  // S4b: a shot asked for by the 提到我的 bell or a row's badge (also answered by <OpenShotBridge/> where it is mounted)
  useOpenShotRequests();
  if (!target) {
    return <EmptyState icon={MousePointerClick} title="选择一个场次或镜头。" description="场次的站位、AI 拆镜，和镜头的全部参数都在这里编辑。" />;
  }
  if (target.kind === 'shot') {
    const shot = shots.find((s) => s.id === target.shotId);
    if (!shot) return <EmptyState title="这个镜头已不在镜头表中。" />;
    return (
      <>
        <ShotEditor key={shot.id} target={{ mode: 'edit', shot }} />
        {hosted ? (
          <div className="border-t border-graphite-800">
            <CommentsPanel key={shot.id} shotId={shot.id} />
          </div>
        ) : null}
      </>
    );
  }
  const scene = ws.script.scenes.find((s) => s.id === target.sceneId);
  if (!scene) return <EmptyState title="这个场次不在当前剧本版本中。" />;
  if (target.kind === 'create') return <ShotEditor key={`new-${scene.id}`} target={{ mode: 'create', scene }} />;
  return <SceneInspector key={scene.id} scene={scene} shots={shots.filter((s) => s.scene_id === scene.id)} focus={target.focus} />;
}

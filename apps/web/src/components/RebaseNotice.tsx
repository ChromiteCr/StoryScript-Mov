import { RefreshCw } from 'lucide-react';
import { useHealth } from '../lib/queries.ts';
import { Button, Notice } from './ui.tsx';

/**
 * S4a — what a form says when the ground moved under it (see
 * lib/useRebasedForm.ts):
 *  - `conflict`: a teammate saved this item while the person had unsaved
 *    edits; the edits are still there, and the person picks 用他的 or 保留我的;
 *  - `refused`: the save itself came back REVISION_CONFLICT; 刷新 loads the
 *    latest content in place of the form's.
 * The conflict wins when both hold (it already offers the way out).
 */
export function RebaseNotice({
  conflict,
  refused = false,
  onTheirs,
  onMine,
  onRefresh,
  className = '',
}: {
  conflict: { by?: string } | null;
  refused?: boolean;
  onTheirs: () => void;
  onMine: () => void;
  onRefresh: () => void;
  className?: string;
}) {
  const hosted = useHealth().data?.hosted ?? false;
  if (conflict) {
    const title = conflict.by ? `${conflict.by}刚改了这一项` : hosted ? '刚有组员改了这一项' : '这一项刚在别处被改了';
    return (
      <Notice tone="warn" role="status" title={title} className={className}>
        <p>你的修改还没保存，也还在这里。用他的：放弃你的修改，改用刚保存的内容。保留我的：继续改，保存时以你的为准。</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onTheirs}>
            用他的
          </Button>
          <Button size="sm" onClick={onMine}>
            保留我的
          </Button>
        </div>
      </Notice>
    );
  }
  if (refused) {
    return (
      <Notice tone="danger" role="alert" title="没有保存：这一项刚被改过" className={className}>
        <p>{hosted ? '有组员在你打开之后保存了它。' : '它在你打开之后又被改过。'}刷新会载入最新内容，你在这里改的文字会被替换。</p>
        <Button size="sm" className="mt-1.5" onClick={onRefresh}>
          <RefreshCw aria-hidden className="size-3" />
          刷新
        </Button>
      </Notice>
    );
  }
  return null;
}

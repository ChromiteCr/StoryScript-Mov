import { useState } from 'react';
import type { ShotMediaLink } from '@storyscript/contracts';
import { Check, Unlink, X } from 'lucide-react';
import { Button } from '../../components/ui.tsx';
import { useReviewLink } from '../../lib/queries-media.ts';
import { MediaErrorNotice } from './shared.tsx';

/**
 * Confirm / reject / unlink one shot↔clip link. Unlinking removes only this
 * link (never the file, never other links — INV-06) and asks once more.
 */
export function LinkActions({ link, compact = false }: { link: ShotMediaLink; compact?: boolean }) {
  const review = useReviewLink();
  const [askUnlink, setAskUnlink] = useState(false);
  const act = (action: 'confirm' | 'reject' | 'unlink') => {
    setAskUnlink(false);
    review.mutate({ id: link.id, input: { expected_revision: link.revision, action } });
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {link.status !== 'confirmed' ? (
          <Button size="sm" onClick={() => act('confirm')} busy={review.isPending && review.variables?.input.action === 'confirm'}>
            <Check aria-hidden className="size-3.5 text-ok" />
            确认
          </Button>
        ) : null}
        {link.status !== 'rejected' ? (
          <Button size="sm" variant="ghost" onClick={() => act('reject')} busy={review.isPending && review.variables?.input.action === 'reject'}>
            <X aria-hidden className="size-3.5" />
            拒绝
          </Button>
        ) : null}
        {!compact ? (
          askUnlink ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => act('unlink')}>
                确定解除（原片不受影响）
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAskUnlink(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setAskUnlink(true)}>
              <Unlink aria-hidden className="size-3.5" />
              解除关联
            </Button>
          )
        ) : null}
      </div>
      {review.isError ? <MediaErrorNotice error={review.error} /> : null}
    </div>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/ui.tsx';

/** Right-hand modal drawer on a native <dialog> (focus trap and Escape for free). */
export function Drawer({ title, onClose, children, tools, wide = false }: { title: string; onClose: () => void; children: ReactNode; tools?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={
        `fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none ${wide ? 'w-[min(640px,100vw)]' : 'w-[min(440px,100vw)]'} max-w-none p-0 ` +
        '[border-width:0_0_0_1px] border-graphite-700 bg-graphite-900 text-graphite-100'
      }
    >
      <div className="flex h-full flex-col">
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-graphite-800 bg-graphite-800 pr-2 pl-4">
          <h2 id={titleId} className="text-sm font-medium">
            {title}
          </h2>
          <div className="flex items-center gap-1">
            {tools}
            <IconButton icon={X} label="关闭" onClick={onClose} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </dialog>
  );
}

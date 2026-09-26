import { MonitorPlay } from 'lucide-react';

/** Always visible while the server runs with --demo (health.demo). */
export function DemoBanner() {
  return (
    <div role="status" className="sticky top-0 z-20 bg-graphite text-sheet">
      <p className="mx-auto flex max-w-[1200px] items-center gap-2 px-4 py-1.5 text-[13px] sm:px-6">
        <MonitorPlay aria-hidden className="size-4 shrink-0 text-warn-rule" />
        <span>演示回放，非真实模型输出</span>
      </p>
    </div>
  );
}

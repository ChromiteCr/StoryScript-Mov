import { MonitorPlay } from 'lucide-react';

/** Always visible while the server runs with --demo (health.demo): a thin strip above the page bar. */
export function DemoBanner() {
  return (
    <div
      role="status"
      className="flex h-6 items-center justify-center gap-1.5 border-t border-graphite-800 bg-graphite-900 px-4 text-xs text-graphite-100 print:hidden"
    >
      <MonitorPlay aria-hidden className="size-3.5 shrink-0 text-warn" />
      <span className="truncate">演示回放，非真实模型输出</span>
    </div>
  );
}

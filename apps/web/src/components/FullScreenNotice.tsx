import type { ReactNode } from 'react';
import { KeyRound, Unplug } from 'lucide-react';
import { Button, CopyCommand, Spinner } from './ui.tsx';
import { describeError } from '../lib/errors.ts';

/** Centred card on the graphite background; `wide` for two-column content. */
export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-graphite-950 px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-[640px]' : 'max-w-[440px]'} rounded-panel border border-graphite-800 bg-graphite-900 px-6 py-6`}>{children}</div>
    </main>
  );
}

export function SessionExpiredScreen() {
  return (
    <Shell>
      <KeyRound aria-hidden className="size-5 text-graphite-300" />
      <h1 className="mt-3 text-lg font-medium">会话已失效</h1>
      <p className="mt-1.5 leading-8 text-graphite-300">
        请使用终端打印的链接，或运行 <CopyCommand command="storyscript-mov open" />
      </p>
      <p className="mt-4 text-xs text-graphite-300">本地服务每次启动都会生成新的访问链接。重启之后，旧标签页需要用新链接重新打开。</p>
    </Shell>
  );
}

export function UnreachableScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const human = describeError(error);
  return (
    <Shell>
      <Unplug aria-hidden className="size-5 text-graphite-300" />
      <h1 className="mt-3 text-lg font-medium">{human.title}</h1>
      {human.detail ? <p className="mt-1.5 text-graphite-300">{human.detail}</p> : null}
      {human.technical ? <p className="mt-3 font-mono text-xs break-all text-graphite-300">{human.technical}</p> : null}
      <Button variant="primary" className="mt-5" onClick={onRetry}>
        重试
      </Button>
    </Shell>
  );
}

export function ConnectingScreen() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-graphite-950">
      <div className="animate-appear motion-reduce:animate-none">
        <Spinner label="正在连接…" />
      </div>
    </main>
  );
}

import type { ReactNode } from 'react';
import { KeyRound, Unplug } from 'lucide-react';
import { Button, CopyCommand, Spinner } from './ui.tsx';
import { describeError } from '../lib/errors.ts';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-desk px-4 py-10">
      <div className="w-full max-w-[440px] rounded-sheet border border-rule bg-sheet px-6 py-7">{children}</div>
    </main>
  );
}

export function SessionExpiredScreen() {
  return (
    <Shell>
      <KeyRound aria-hidden className="size-5 text-ink-2" />
      <h1 className="mt-3 text-lg font-semibold">会话已失效</h1>
      <p className="mt-1.5 leading-8 text-ink-2">
        请使用终端打印的链接，或运行 <CopyCommand command="storyscript-mov open" />
      </p>
      <p className="mt-4 text-xs text-ink-3">本地服务每次启动都会生成新的访问链接。重启之后，旧标签页需要用新链接重新打开。</p>
    </Shell>
  );
}

export function UnreachableScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const human = describeError(error);
  return (
    <Shell>
      <Unplug aria-hidden className="size-5 text-ink-2" />
      <h1 className="mt-3 text-lg font-semibold">{human.title}</h1>
      {human.detail ? <p className="mt-1.5 text-ink-2">{human.detail}</p> : null}
      {human.technical ? <p className="mt-3 font-mono text-xs break-all text-ink-3">{human.technical}</p> : null}
      <Button variant="primary" className="mt-5" onClick={onRetry}>
        重试
      </Button>
    </Shell>
  );
}

export function ConnectingScreen() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-desk">
      <div className="animate-appear motion-reduce:animate-none">
        <Spinner label="正在连接本地服务…" />
      </div>
    </main>
  );
}

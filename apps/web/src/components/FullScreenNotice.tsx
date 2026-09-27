import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Unplug } from 'lucide-react';
import { Button, CopyCommand, Spinner, TextInput } from './ui.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';
import { api } from '../lib/api.ts';
import { describeError } from '../lib/errors.ts';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-graphite-950 px-4 py-10">
      <div className="w-full max-w-[440px] rounded-panel border border-graphite-800 bg-graphite-900 px-6 py-6">{children}</div>
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

/** Hosted server: sign in with the team code the admin handed out (an invite link does the same). */
export function SignInScreen({ siteName, onSignedIn }: { siteName: string; onSignedIn: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.call('session', { token: code.trim() });
      onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <KeyRound aria-hidden className="size-5 text-graphite-300" />
      <h1 className="mt-3 text-lg font-medium">{siteName}</h1>
      <p className="mt-1.5 text-graphite-300">输入队伍口令登录。口令由管理员发放；打开管理员发的邀请链接也能直接登录。</p>
      <form onSubmit={(e) => void submit(e)} className="mt-5 flex flex-col gap-2" noValidate>
        <label htmlFor={id} className="text-xs text-graphite-300">
          队伍口令
        </label>
        <TextInput
          id={id}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="font-mono tracking-wider"
        />
        {error ? <ErrorNotice error={error} context="sign-in" /> : null}
        <Button type="submit" variant="primary" className="mt-2 self-start" busy={busy} disabled={code.trim() === ''}>
          登录
        </Button>
      </form>
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
        <Spinner label="正在连接本地服务…" />
      </div>
    </main>
  );
}

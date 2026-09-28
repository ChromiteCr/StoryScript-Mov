import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogOut, UserPlus, Users } from 'lucide-react';
import { api } from '../lib/api.ts';
import { pendingJoin, setPendingJoin } from '../lib/join.ts';
import { markSessionExpired } from '../lib/session.ts';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Shell } from './FullScreenNotice.tsx';
import { AppGlyph } from './TitleBar.tsx';
import { Button, Field, Spinner, TextInput } from './ui.tsx';

/**
 * Hosted server, signed out: sign in (password or emailed code) or register
 * (invite code → emailed code → name and password). Signed in without a
 * group: create one or join one. Server messages are shown as they are
 * (error context 'account'); obvious slips are caught here first.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailError(email: string): string | null {
  return EMAIL.test(email.trim()) ? null : '请输入完整的邮箱地址，例如 name@school.cn';
}

/** Seconds left before a code may be sent again. */
function useCooldown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const t = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(t);
  }, [until, now]);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return [
    left,
    (seconds) => {
      const t = Date.now();
      setNow(t);
      setUntil(t + seconds * 1000);
    },
  ];
}

/** Busy state + the last error for one form. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}

function Sent({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-control border border-graphite-700 bg-graphite-950 px-3 py-2 text-xs leading-5 text-graphite-300">
      {children}
    </p>
  );
}

function PendingJoinNote() {
  const code = pendingJoin();
  if (!code) return null;
  return (
    <p className="mt-4 rounded-control border border-accent/40 px-3 py-2 text-xs leading-5 text-graphite-100">
      你打开的是小组加入链接（组码 <span className="font-mono">{code}</span>）。登录或注册之后就能加入。
    </p>
  );
}

// ---- signed out ------------------------------------------------------------

type Tab = 'login' | 'register';

export function AuthScreen({ siteName, onSignedIn }: { siteName: string; onSignedIn: () => void }) {
  const [tab, setTab] = useState<Tab>(() => (pendingJoin() ? 'register' : 'login'));
  const [email, setEmail] = useState('');
  const tabClass = (t: Tab) =>
    `h-8 flex-1 rounded-control text-sm ${tab === t ? 'bg-graphite-700 font-medium text-graphite-100' : 'text-graphite-300 hover:text-graphite-100'}`;
  return (
    <Shell>
      <AppGlyph className="text-graphite-300" />
      <h1 className="mt-3 text-lg font-medium">{siteName}</h1>
      <p className="mt-1 text-sm text-graphite-300">StoryScript-Mov 实拍分镜工作台</p>
      <PendingJoinNote />
      <div role="tablist" aria-label="登录或注册" className="mt-5 flex gap-1 rounded-panel border border-graphite-800 bg-graphite-950 p-1">
        <button type="button" role="tab" aria-selected={tab === 'login'} className={tabClass('login')} onClick={() => setTab('login')}>
          登录
        </button>
        <button type="button" role="tab" aria-selected={tab === 'register'} className={tabClass('register')} onClick={() => setTab('register')}>
          注册
        </button>
      </div>
      <div role="tabpanel" aria-label={tab === 'login' ? '登录' : '注册'} className="mt-5">
        {tab === 'login' ? (
          <LoginForm email={email} setEmail={setEmail} onSignedIn={onSignedIn} />
        ) : (
          <RegisterForm email={email} setEmail={setEmail} onSignedIn={onSignedIn} />
        )}
      </div>
    </Shell>
  );
}

interface FormProps {
  email: string;
  setEmail: (v: string) => void;
  onSignedIn: () => void;
}

function EmailField({ email, setEmail, error, disabled }: { email: string; setEmail: (v: string) => void; error: string | null; disabled?: boolean }) {
  return (
    <Field label="邮箱" error={error}>
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          value={email}
          disabled={disabled}
          onChange={(e) => setEmail(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </Field>
  );
}

function CodeField({ code, setCode, error }: { code: string; setCode: (v: string) => void; error: string | null }) {
  return (
    <Field label="邮件里的 6 位验证码" error={error}>
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoComplete="one-time-code"
          inputMode="numeric"
          placeholder="000000"
          className="font-mono tracking-[0.3em]"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </Field>
  );
}

function PasswordField({
  label,
  value,
  setValue,
  error,
  autoComplete,
  hint,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  error: string | null;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      )}
    </Field>
  );
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-xs text-graphite-300 underline underline-offset-2 hover:text-graphite-100">
      {children}
    </button>
  );
}

function LoginForm({ email, setEmail, onSignedIn }: FormProps) {
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [forgot, setForgot] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cool, startCool] = useCooldown();
  const [checks, setChecks] = useState<Record<string, string | null>>({});
  const { busy, error, setError, run } = useAction();

  const toCode = (isForgot: boolean) => {
    setMode('code');
    setForgot(isForgot);
    setError(null);
    setChecks({});
  };

  const sendCode = () => {
    const e = emailError(email);
    setChecks({ email: e });
    if (e) return;
    void run('send', async () => {
      await api.call('loginCode', { email: email.trim() });
      setSentTo(email.trim());
      startCool(60);
    });
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const c: Record<string, string | null> = { email: emailError(email) };
    if (mode === 'password') c.password = password ? null : '请输入密码';
    else {
      c.code = /^\d{6}$/.test(code) ? null : '验证码是 6 位数字';
      if (forgot) c.newPassword = newPassword.length >= 8 ? null : '新密码至少 8 位';
    }
    setChecks(c);
    if (Object.values(c).some(Boolean)) return;
    void run('submit', async () => {
      if (mode === 'password') await api.call('passwordLogin', { email: email.trim(), password });
      else await api.call('codeLogin', { email: email.trim(), code, ...(forgot ? { new_password: newPassword } : {}) });
      onSignedIn();
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <EmailField email={email} setEmail={setEmail} error={checks.email ?? null} />
      {mode === 'password' ? (
        <>
          <PasswordField label="密码" value={password} setValue={setPassword} error={checks.password ?? null} autoComplete="current-password" />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <LinkButton onClick={() => toCode(false)}>用邮箱验证码登录</LinkButton>
            <LinkButton onClick={() => toCode(true)}>忘记密码？</LinkButton>
          </div>
        </>
      ) : (
        <>
          {forgot ? <p className="text-xs leading-5 text-graphite-300">用邮箱验证码登录，同时设一个新密码。</p> : null}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <CodeField code={code} setCode={setCode} error={checks.code ?? null} />
            </div>
            <Button onClick={sendCode} busy={busy === 'send'} disabled={cool > 0} className="mb-px">
              {cool > 0 ? `${cool} 秒后可重发` : sentTo ? '重新发送' : '发送验证码'}
            </Button>
          </div>
          {sentTo ? <Sent>验证码已发到 {sentTo}，10 分钟内有效。没收到的话，看看垃圾邮件。</Sent> : null}
          {forgot ? (
            <PasswordField label="新密码" value={newPassword} setValue={setNewPassword} error={checks.newPassword ?? null} autoComplete="new-password" hint="至少 8 位" />
          ) : null}
          <div>
            <LinkButton onClick={() => setMode('password')}>用密码登录</LinkButton>
          </div>
        </>
      )}
      {error ? <ErrorNotice error={error} context="account" /> : null}
      <Button type="submit" variant="primary" className="mt-1 self-start" busy={busy === 'submit'}>
        {forgot && mode === 'code' ? '设置新密码并登录' : '登录'}
      </Button>
    </form>
  );
}

function RegisterForm({ email, setEmail, onSignedIn }: FormProps) {
  const [invite, setInvite] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [cool, startCool] = useCooldown();
  const [checks, setChecks] = useState<Record<string, string | null>>({});
  const { busy, error, setError, run } = useAction();

  const send = (ev?: FormEvent) => {
    ev?.preventDefault();
    const c = { email: emailError(email), invite: invite.trim() ? null : '请输入活动负责人给的邀请码' };
    setChecks(c);
    if (c.email || c.invite) return;
    void run('send', async () => {
      await api.call('registerCode', { email: email.trim(), invite: invite.trim() });
      setSentTo(email.trim());
      startCool(60);
    });
  };

  const finish = (ev: FormEvent) => {
    ev.preventDefault();
    const c = {
      code: /^\d{6}$/.test(code) ? null : '验证码是 6 位数字',
      name: name.trim() ? (name.trim().length > 20 ? '昵称最多 20 个字' : null) : '请填写昵称，组员会看到它',
      password: password.length >= 8 ? null : '密码至少 8 位',
    };
    setChecks(c);
    if (c.code || c.name || c.password) return;
    void run('submit', async () => {
      await api.call('register', { email: sentTo ?? email.trim(), code, name: name.trim(), password });
      onSignedIn();
    });
  };

  if (!sentTo) {
    return (
      <form onSubmit={send} className="flex flex-col gap-3" noValidate>
        <EmailField email={email} setEmail={setEmail} error={checks.email ?? null} />
        <Field label="邀请码" error={checks.invite ?? null} hint="活动负责人发给大家的注册邀请码">
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        {error ? <ErrorNotice error={error} context="account" /> : null}
        <Button type="submit" variant="primary" className="mt-1 self-start" busy={busy === 'send'}>
          发送验证码
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={finish} className="flex flex-col gap-3" noValidate>
      <Sent>
        验证码已发到 {sentTo}，10 分钟内有效。没收到的话，看看垃圾邮件。
        <span className="mt-1 flex flex-wrap gap-x-4">
          <LinkButton
            onClick={() => {
              setSentTo(null);
              setError(null);
            }}
          >
            换一个邮箱
          </LinkButton>
          {cool > 0 ? <span className="text-xs text-graphite-500">{cool} 秒后可重发</span> : <LinkButton onClick={() => send()}>重新发送</LinkButton>}
        </span>
      </Sent>
      <CodeField code={code} setCode={setCode} error={checks.code ?? null} />
      <Field label="昵称" error={checks.name ?? null} hint="组员会看到它，例如真实姓名">
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
            maxLength={20}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        )}
      </Field>
      <PasswordField label="密码" value={password} setValue={setPassword} error={checks.password ?? null} autoComplete="new-password" hint="至少 8 位" />
      {error ? <ErrorNotice error={error} context="account" /> : null}
      <Button type="submit" variant="primary" className="mt-1 self-start" busy={busy === 'submit'}>
        注册并登录
      </Button>
    </form>
  );
}

// ---- signed in, no group -----------------------------------------------------

export function GroupScreen({ onJoined }: { onJoined: () => void }) {
  const me = useQuery({ queryKey: ['me'], queryFn: ({ signal }) => api.call('me', undefined, { signal }) });
  const [code, setCode] = useState(() => pendingJoin() ?? '');
  const [name, setName] = useState('');
  const [checks, setChecks] = useState<Record<string, string | null>>({});
  const join = useAction();
  const create = useAction();

  const doJoin = (ev: FormEvent) => {
    ev.preventDefault();
    const e = code.trim() ? null : '粘贴组长发的链接，或输入组码';
    setChecks({ code: e });
    if (e) return;
    void join.run('join', async () => {
      await api.call('joinGroup', { code: code.trim() });
      setPendingJoin(null);
      onJoined();
    });
  };
  const doCreate = (ev: FormEvent) => {
    ev.preventDefault();
    const e = name.trim() ? (name.trim().length > 20 ? '组名最多 20 个字' : null) : '给小组起个名字';
    setChecks({ name: e });
    if (e) return;
    void create.run('create', async () => {
      await api.call('createGroup', { name: name.trim() });
      setPendingJoin(null);
      onJoined();
    });
  };

  if (me.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-graphite-950">
        <Spinner label="正在读取账号…" />
      </main>
    );
  }

  return (
    <Shell wide>
      <AppGlyph className="text-graphite-300" />
      <h1 className="mt-3 text-lg font-medium">{me.data ? `${me.data.name}，你好` : '加入小组'}</h1>
      <p className="mt-1.5 text-sm leading-6 text-graphite-300">
        一个小组共用一个项目：剧本、分镜、拍摄计划和素材记录。加入组长发来的小组，或者自己建一个，把链接发给组员。
      </p>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <form onSubmit={doJoin} className="flex flex-col gap-3 rounded-panel border border-graphite-800 bg-graphite-950 p-4" noValidate>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Users aria-hidden className="size-4 text-graphite-300" />
            加入小组
          </h2>
          <Field label="组码或加入链接" error={checks.code ?? null}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-2345"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
          {join.error ? <ErrorNotice error={join.error} context="account" /> : null}
          <Button type="submit" variant="primary" className="mt-auto self-start" busy={join.busy !== null}>
            加入
          </Button>
        </form>
        <form onSubmit={doCreate} className="flex flex-col gap-3 rounded-panel border border-graphite-800 bg-graphite-950 p-4" noValidate>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <UserPlus aria-hidden className="size-4 text-graphite-300" />
            创建小组
          </h2>
          <Field label="组名" error={checks.name ?? null} hint="你会成为组长">
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={20}
                placeholder="例如 雨夜短片组"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
          {create.error ? <ErrorNotice error={create.error} context="account" /> : null}
          <Button type="submit" className="mt-auto self-start" busy={create.busy !== null}>
            创建小组
          </Button>
        </form>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-graphite-300">
        <span className="min-w-0 truncate">已登录：{me.data?.email}</span>
        <Button variant="ghost" size="sm" onClick={() => void api.call('logout').finally(() => markSessionExpired())}>
          <LogOut aria-hidden className="size-3.5" />
          退出登录
        </Button>
      </div>
    </Shell>
  );
}

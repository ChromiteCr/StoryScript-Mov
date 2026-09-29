import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountMe, GroupPreview, GroupView } from '@storyscript/contracts';
import { ArrowLeftRight, Check, Copy, KeyRound, LogOut, Trash2, Users } from 'lucide-react';
import { api } from '../lib/api.ts';
import { pendingJoin, setPendingJoin } from '../lib/join.ts';
import { navigate } from '../lib/route.ts';
import { markSessionExpired } from '../lib/session.ts';
import { Dialog } from './Dialog.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Menu } from './Menu.tsx';
import { Button, Field, Tag, TextInput } from './ui.tsx';

/**
 * Hosted server: who is signed in and which group this browser works in, in
 * the title bar, with 切换项目 (the 项目 page lists all of one's groups).
 * The menu opens the group panel (invite link, members, leave/disband), the
 * password form and sign-out. A join link opened while signed in asks
 * before joining. `onGroupChanged` reloads the workbench, since the project
 * changes with the group.
 */

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: ({ signal }) => api.call('me', undefined, { signal }) });
}

function signOut() {
  void api.call('logout').finally(() => markSessionExpired());
}

export function AccountMenu({ onGroupChanged }: { onGroupChanged: () => void }) {
  const me = useMe();
  const [open, setOpen] = useState<'group' | 'password' | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(() => pendingJoin());

  useEffect(() => {
    const onJoinLink = () => setSwitchTo(pendingJoin());
    window.addEventListener('ssm-join-link', onJoinLink);
    return () => window.removeEventListener('ssm-join-link', onJoinLink);
  }, []);

  const group = me.data?.group ?? null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Button variant="ghost" size="sm" onClick={() => navigate('projects')} title="查看你所在的小组，在它们的项目之间切换">
        <ArrowLeftRight aria-hidden className="size-3.5" />
        <span className="max-md:sr-only">切换项目</span>
      </Button>
      <button
        type="button"
        onClick={() => setOpen('group')}
        className="min-w-0 truncate rounded-control px-1.5 py-0.5 text-xs text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100 max-md:sr-only"
        title="小组和组员"
      >
        {group ? `${group.name}：` : ''}
        {me.data?.name ?? ''}
      </button>
      <Menu
        label="账号"
        items={[
          { key: 'projects', label: '项目（我的小组）', icon: <ArrowLeftRight className="size-3.5" />, onSelect: () => navigate('projects') },
          { key: 'group', label: '小组和组员…', icon: <Users className="size-3.5" />, onSelect: () => setOpen('group') },
          { key: 'password', label: '修改密码…', icon: <KeyRound className="size-3.5" />, onSelect: () => setOpen('password') },
          'separator',
          { key: 'out', label: '退出登录', icon: <LogOut className="size-3.5" />, onSelect: signOut },
        ]}
      />
      {open === 'group' && group ? <GroupDialog group={group} current onClose={() => setOpen(null)} onGroupChanged={onGroupChanged} /> : null}
      {open === 'password' ? <PasswordDialog onClose={() => setOpen(null)} /> : null}
      {switchTo && me.data && group ? (
        <JoinLinkDialog
          code={switchTo}
          me={me.data}
          onClose={() => {
            setPendingJoin(null);
            setSwitchTo(null);
          }}
          onGroupChanged={onGroupChanged}
        />
      ) : null}
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex items-center gap-1 rounded-control border border-graphite-700 bg-graphite-950 py-px pr-px pl-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-graphite-100" title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100"
        aria-label={copied ? '已复制' : `复制${label}`}
        title={copied ? '已复制' : '复制'}
      >
        {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </div>
  );
}

/** One group's panel. `current`: this browser works in it (leaving or disbanding it reloads the workbench). */
export function GroupDialog({
  group,
  current,
  onClose,
  onGroupChanged,
}: {
  group: GroupView;
  current: boolean;
  onClose: () => void;
  onGroupChanged: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<'code' | 'leave' | 'disband' | { remove: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const leader = group.role === 'leader';
  const alone = group.members.length === 1;
  const link = `${window.location.origin}/#join=${group.join_code}`;

  const act = async (fn: () => Promise<unknown>, changesGroup: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirm(null);
      if (changesGroup && current) onGroupChanged();
      else {
        await qc.invalidateQueries({ queryKey: meKey });
        if (changesGroup) onClose();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  let confirmBox = null;
  const params = { slug: group.slug };
  if (confirm === 'code') {
    confirmBox = {
      text: '换一个组码？旧的链接和组码马上失效；已经在组里的人不受影响。',
      action: '换组码',
      run: () => act(() => api.call('resetGroupCode', undefined, { params }), false),
    };
  } else if (confirm === 'leave') {
    confirmBox = {
      text: leader ? '退出小组？组长会交给最早加入的组员。项目留在小组里。' : '退出小组？项目留在小组里，你之后可以用组码重新加入。',
      action: '退出小组',
      run: () => act(() => api.call('leaveGroup', undefined, { params }), true),
    };
  } else if (confirm === 'disband') {
    confirmBox = {
      text: `解散「${group.name}」？小组的项目（剧本、分镜、计划、场记和素材记录）会从服务器上删除，不能恢复。你电脑上的视频素材不受影响。`,
      action: '解散并删除项目',
      run: () => act(() => api.call('disbandGroup', { confirm: true }, { params }), true),
    };
  } else if (confirm) {
    const { remove, name } = confirm;
    confirmBox = {
      text: `把 ${name} 移出小组？他之后需要新的组码才能回来；换一个组码可以防止他用旧组码重新加入。`,
      action: '移出小组',
      run: () => act(() => api.call('removeGroupMember', undefined, { params: { ...params, id: remove } }), false),
    };
  }

  return (
    <Dialog variant="drawer" title={group.name} description={leader ? '你是组长' : '你是组员'} onClose={onClose} busy={busy}>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-graphite-100">邀请组员</h3>
        <p className="text-xs leading-5 text-graphite-300">把链接发给组员：注册或登录后就会加入这个小组。也可以把组码告诉他们。</p>
        <CopyLine label="加入链接" value={link} />
        <div className="flex items-center gap-2">
          <span className="text-xs text-graphite-300">组码</span>
          <span className="font-mono text-sm tracking-wider text-graphite-100">{group.join_code}</span>
          {leader ? (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirm('code')}>
              换组码
            </Button>
          ) : null}
        </div>
      </section>

      <section className="mt-6 flex flex-col gap-2">
        <h3 className="text-xs font-medium text-graphite-100">
          组员 {group.members.length}/{group.max_members}
        </h3>
        <ul className="flex flex-col divide-y divide-graphite-800 rounded-panel border border-graphite-800">
          {group.members.map((m) => (
            <li key={m.id} className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {m.you ? <span className="text-graphite-300">（你）</span> : null}
              </span>
              {m.role === 'leader' ? <Tag>组长</Tag> : null}
              {leader && !m.you ? (
                <Button variant="ghost" size="sm" onClick={() => setConfirm({ remove: m.id, name: m.name })}>
                  移出
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 flex flex-col items-start gap-2">
        {alone ? (
          leader ? (
            <>
              <p className="text-xs leading-5 text-graphite-300">你是小组里唯一的人。不再需要这个小组时，可以解散它。</p>
              <Button onClick={() => setConfirm('disband')}>
                <Trash2 aria-hidden className="size-3.5 text-danger" />
                解散小组…
              </Button>
            </>
          ) : null
        ) : (
          <Button onClick={() => setConfirm('leave')}>退出小组…</Button>
        )}
      </section>

      {confirmBox ? (
        <div role="alertdialog" aria-label={confirmBox.action} className="mt-6 flex flex-col gap-3 rounded-panel border border-graphite-700 bg-graphite-950 p-3">
          <p className="text-sm leading-6">{confirmBox.text}</p>
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => void confirmBox.run()}>
              {confirmBox.action}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} context="account" className="mt-4" /> : null}
    </Dialog>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = next.length >= 8 ? null : '新密码至少 8 位';
    setCheck(c);
    if (c || !current) return;
    setBusy(true);
    setError(null);
    try {
      await api.call('changePassword', { current, next });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="修改密码" onClose={onClose} busy={busy}>
      {done ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm leading-6">密码已修改。其他电脑上的登录已经退出，这台电脑保持登录。</p>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
          <Field label="当前密码">
            {({ id }) => <TextInput id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
          <Field label="新密码" hint="至少 8 位" error={check}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
          <p className="text-xs text-graphite-300">忘记当前密码的话，退出登录后用邮箱验证码登录并设新密码。</p>
          {error ? <ErrorNotice error={error} context="account" /> : null}
          <Button type="submit" variant="primary" className="self-start" busy={busy} disabled={!current || !next}>
            修改密码
          </Button>
        </form>
      )}
    </Dialog>
  );
}

/**
 * A join link opened while signed in: already in that group → switch to it;
 * room for another group → join it too; at the cap → say which to leave first.
 */
function JoinLinkDialog({ code, me, onClose, onGroupChanged }: { code: string; me: AccountMe; onClose: () => void; onGroupChanged: () => void }) {
  const preview = useQuery({
    queryKey: ['group-preview', code],
    queryFn: () => api.call('previewGroup', { code }),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const target: GroupPreview | undefined = preview.data;
  const atCap = me.groups.length >= me.max_groups;
  const names = me.groups.map((g) => `「${g.name}」`).join('和');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPendingJoin(null);
      onGroupChanged();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Dialog title="加入小组" onClose={onClose} busy={busy}>
      {preview.isPending ? <p className="text-sm text-graphite-300">正在查找小组…</p> : null}
      {preview.isError ? <ErrorNotice error={preview.error} context="account" /> : null}
      {target ? (
        <div className="flex flex-col items-start gap-3">
          {target.joined ? (
            <p className="text-sm leading-6">你已经在「{target.name}」里了。</p>
          ) : atCap ? (
            <p className="text-sm leading-6">
              你已经在 {names} 里。每人最多同时在 {me.max_groups} 个小组，要加入「{target.name}」，先在「切换项目」页退出一个小组。
            </p>
          ) : (
            <p className="text-sm leading-6">
              加入「{target.name}」（{target.members} 人）？{me.groups.length > 0 ? `你还会留在${names}，在「切换项目」页可以随时切换。` : ''}
            </p>
          )}
          {target.full && !target.joined ? <p className="text-xs text-graphite-300">这个小组已经满员了。</p> : null}
          {error ? <ErrorNotice error={error} context="account" /> : null}
          <div className="flex gap-2">
            {target.joined ? (
              <Button variant="primary" busy={busy} onClick={() => void run(() => api.call('switchGroup', undefined, { params: { slug: target.slug } }))}>
                打开「{target.name}」的项目
              </Button>
            ) : atCap ? (
              <Button
                variant="primary"
                onClick={() => {
                  onClose();
                  navigate('projects');
                }}
              >
                去切换项目页
              </Button>
            ) : (
              <Button variant="primary" busy={busy} disabled={target.full} onClick={() => void run(() => api.call('joinGroup', { code }))}>
                加入「{target.name}」
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

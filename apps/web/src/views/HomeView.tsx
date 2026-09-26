import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FrameFormat, type RecentProject } from '@storyscript/contracts';
import { FolderOpen, FolderPlus, Plus, X } from 'lucide-react';
import { useCreateProject, useOpenProject, useRecentProjects } from '../lib/queries.ts';
import {
  basename,
  formatDuration,
  formatOpenedAt,
  isValidTimeZone,
  normalizePastedPath,
  parseDurationInput,
  systemTimeZone,
} from '../lib/format.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { FolderField } from '../components/FolderField.tsx';
import { Button, Field, IconButton, SelectInput, Spinner, TextInput } from '../components/ui.tsx';

/**
 * Home = project manager: recent projects as 2.39 frames on graphite, the
 * first tile creates a new one. Forms open in a right-hand drawer.
 */

type Aspect = FrameFormat;
const ASPECTS: readonly Aspect[] = FrameFormat.options;

const ASPECT_NOTE: Partial<Record<Aspect, string>> = { '2.39': '宽银幕', '1.78': '16:9' };

/** Static class names so Tailwind can see them. */
const ASPECT_BOX: Record<Aspect, string> = {
  '2.39': 'aspect-[2.39/1]',
  '2.20': 'aspect-[2.2/1]',
  '1.90': 'aspect-[1.9/1]',
  '1.78': 'aspect-[1.78/1]',
  '1.43': 'aspect-[1.43/1]',
};

// -------------------------------------------------------------------- tiles

/** A 2.39 frame with the dashed 1.43 centre-safe guides the boards also use. */
function FrameThumb({ kind }: { kind: 'project' | 'new' }) {
  if (kind === 'new') {
    return (
      <span className="flex aspect-[2.39/1] w-full items-center justify-center rounded-control border border-dashed border-graphite-500 text-graphite-300 group-hover:border-graphite-300 group-hover:text-graphite-100">
        <Plus aria-hidden className="size-5" strokeWidth={1.5} />
      </span>
    );
  }
  return (
    <span className="relative block aspect-[2.39/1] w-full rounded-control border border-graphite-700 bg-graphite-900 group-hover:border-graphite-500">
      <span aria-hidden className="absolute inset-y-0 left-[20.08%] w-[59.84%] border-x border-dashed border-graphite-700" />
    </span>
  );
}

const TILE =
  'group flex w-full min-w-0 flex-col gap-2 rounded-panel p-1.5 text-left hover:bg-graphite-900 ' +
  'focus-visible:outline-offset-0 disabled:cursor-wait';

function NewProjectTile({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-haspopup="dialog" className={TILE}>
      <FrameThumb kind="new" />
      <span className="min-w-0 px-0.5">
        <span className="block truncate text-sm font-medium text-graphite-100">新建项目</span>
        <span className="block truncate text-xs text-graphite-300">选一个文件夹作为项目目录</span>
      </span>
    </button>
  );
}

function ProjectTile({ project, busy, disabled, onOpen }: { project: RecentProject; busy: boolean; disabled: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} disabled={disabled} aria-busy={busy || undefined} title={project.dir} className={TILE}>
      <FrameThumb kind="project" />
      <span className="min-w-0 px-0.5">
        <span className="block truncate text-sm font-medium text-graphite-100">{project.name}</span>
        <span className="block truncate text-xs text-graphite-300 tabular-nums">
          {busy ? '正在打开…' : <time dateTime={project.opened_at}>{formatOpenedAt(project.opened_at)}</time>}
        </span>
      </span>
    </button>
  );
}

// ------------------------------------------------------------------- drawer

/** Right-hand modal drawer (native <dialog>: focus trap and Escape for free). */
function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLInputElement>('input')?.focus();
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
        if (e.target === e.currentTarget) onClose(); // backdrop
      }}
      className={
        'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(440px,100vw)] max-w-none p-0 ' +
        '[border-width:0_0_0_1px] border-graphite-700 bg-graphite-900 text-graphite-100'
      }
    >
      <div className="flex h-full flex-col">
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-graphite-800 bg-graphite-800 pr-2 pl-4">
          <h2 id={titleId} className="text-sm font-medium">
            {title}
          </h2>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">{children}</div>
      </div>
    </dialog>
  );
}

// -------------------------------------------------------------------- forms

interface CreateErrors {
  dir?: string;
  name?: string;
  timezone?: string;
  duration?: string;
}

function CreateProjectForm({ onCancel }: { onCancel: () => void }) {
  const create = useCreateProject();
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(systemTimeZone);
  const [aspect, setAspect] = useState<Aspect>('2.39');
  const [duration, setDuration] = useState('');
  const [errors, setErrors] = useState<CreateErrors>({});

  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }, []);

  const parsedDuration = parseDurationInput(duration);

  const fillNameFrom = (path: string) => {
    if (name.trim() === '') setName(basename(path));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const d = normalizePastedPath(dir);
    const next: CreateErrors = {};
    if (d === '') next.dir = '请选择或粘贴项目目录';
    if (name.trim() === '') next.name = '请填写项目名';
    if (!isValidTimeZone(timezone.trim())) next.timezone = '无法识别这个时区，请用 IANA 名称，例如 Asia/Shanghai';
    if (parsedDuration === 'invalid') next.duration = '目标时长需要是正整数（秒），或者留空';
    setErrors(next);
    if (Object.keys(next).length > 0 || parsedDuration === 'invalid') return;
    create.mutate({
      dir: d,
      name: name.trim(),
      timezone: timezone.trim(),
      default_aspect: aspect,
      target_duration_s: parsedDuration,
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Field
        label="项目目录"
        hint="project.json、数据库和分镜图会写进这个目录，建议用空文件夹。原片不会被复制进来。"
        error={errors.dir}
      >
        {(ids) => (
          <FolderField
            {...ids}
            value={dir}
            onChange={(v) => {
              setDir(v);
              if (errors.dir) setErrors({ ...errors, dir: undefined });
            }}
            onPicked={fillNameFrom}
          />
        )}
      </Field>

      <Field label="项目名" error={errors.name}>
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => {
              if (name.trim() === '' && dir.trim() !== '') setName(basename(normalizePastedPath(dir)));
            }}
            placeholder="例如：周末短片"
            maxLength={120}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="时区" hint="默认取本机时区。排期时间按它输入和显示。" error={errors.timezone}>
          {({ id, describedBy, invalid }) => (
            <>
              <TextInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                list="tz-options"
                spellCheck={false}
                autoComplete="off"
              />
              <datalist id="tz-options">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>

        <Field
          label="目标时长（秒）"
          hint={typeof parsedDuration === 'number' ? `约 ${formatDuration(parsedDuration)}` : '可以不填'}
          error={errors.duration}
        >
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              inputMode="numeric"
              placeholder="例如 600"
              className="tabular-nums"
            />
          )}
        </Field>
      </div>

      <Field label="默认画幅" hint="新镜头默认使用这个画幅，单个镜头可以另设。">
        {({ id, describedBy }) => (
          <div className="flex items-center gap-4">
            <SelectInput
              id={id}
              aria-describedby={describedBy}
              value={aspect}
              onChange={(e) => setAspect(e.target.value as Aspect)}
              className="w-44 tabular-nums"
            >
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a} : 1{ASPECT_NOTE[a] ? `（${ASPECT_NOTE[a]}）` : ''}
                </option>
              ))}
            </SelectInput>
            {/* live frame preview: a filled shape, so it does not read as another input */}
            <div aria-hidden className="flex h-8 w-14 items-center justify-center">
              <div className={`w-full rounded-[1px] bg-graphite-500 ${ASPECT_BOX[aspect]}`} />
            </div>
          </div>
        )}
      </Field>

      {create.isError ? <ErrorNotice error={create.error} context="create" /> : null}

      <div className="flex justify-end gap-2 border-t border-graphite-800 pt-4">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" busy={create.isPending}>
          {create.isPending ? null : <FolderPlus aria-hidden className="size-3.5" />}
          创建项目
        </Button>
      </div>
    </form>
  );
}

function OpenProjectForm({ onCancel }: { onCancel: () => void }) {
  const open = useOpenProject();
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const d = normalizePastedPath(dir);
    if (d === '') {
      setError('请选择或粘贴项目目录');
      return;
    }
    setError(null);
    open.mutate(d);
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-graphite-300">列表里没有的项目，从这里打开。</p>
      <Field label="项目目录" hint="包含 project.json 的那个目录。" error={error}>
        {(ids) => (
          <FolderField
            {...ids}
            value={dir}
            onChange={(v) => {
              setDir(v);
              if (error) setError(null);
            }}
          />
        )}
      </Field>
      {open.isError ? <ErrorNotice error={open.error} context="open" /> : null}
      <div className="flex justify-end gap-2 border-t border-graphite-800 pt-4">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" busy={open.isPending}>
          {open.isPending ? null : <FolderOpen aria-hidden className="size-3.5" />}
          打开项目
        </Button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------------- page

export function HomeView() {
  const recent = useRecentProjects();
  const open = useOpenProject();
  const [target, setTarget] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<'create' | 'open' | null>(null);
  const close = () => setDrawer(null);

  const empty = recent.data !== undefined && recent.data.length === 0;

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 py-6 md:px-8 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-medium">项目</h1>
          <p className="mt-0.5 text-sm text-graphite-300">
            {empty ? '还没有打开过项目。新建一个，或打开已有的项目目录。' : '最近打开的项目，新的在前。'}
          </p>
        </div>
        <Button onClick={() => setDrawer('open')} aria-haspopup="dialog">
          <FolderOpen aria-hidden className="size-3.5" />
          打开已有项目
        </Button>
      </div>

      <ul className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-3 gap-y-4 md:grid-cols-[repeat(auto-fill,minmax(184px,1fr))]">
        <li>
          <NewProjectTile onClick={() => setDrawer('create')} />
        </li>
        {(recent.data ?? []).map((p) => (
          <li key={p.dir}>
            <ProjectTile
              project={p}
              busy={open.isPending && target === p.dir}
              disabled={open.isPending}
              onOpen={() => {
                setTarget(p.dir);
                open.mutate(p.dir);
              }}
            />
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-col gap-3">
        {recent.isPending ? <Spinner label="正在读取最近项目…" /> : null}
        {recent.isError ? <ErrorNotice error={recent.error} /> : null}
        {open.isError && target ? <ErrorNotice error={open.error} context="open" /> : null}
      </div>

      <p className="mt-10 max-w-[64ch] border-t border-graphite-800 pt-4 text-xs text-graphite-300">
        项目就是这台电脑上的一个文件夹，原片只读取、不改动。只有在你配置了模型并使用 AI 功能时，才会把相关内容发给你指定的模型服务。
      </p>

      {drawer === 'create' ? (
        <Drawer title="新建项目" onClose={close}>
          <CreateProjectForm onCancel={close} />
        </Drawer>
      ) : null}
      {drawer === 'open' ? (
        <Drawer title="打开已有项目" onClose={close}>
          <OpenProjectForm onCancel={close} />
        </Drawer>
      ) : null}
    </div>
  );
}

import { useMemo, useState, type FormEvent } from 'react';
import { FrameFormat } from '@storyscript/contracts';
import { FolderOpen, FolderPlus } from 'lucide-react';
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
import { Button, Field, SectionHeading, Spinner, TextInput } from '../components/ui.tsx';

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

/** Title card: a 2.39 frame with the 1.43 centre-safe guides the boards also use. */
function TitleCard() {
  return (
    <figure className="relative">
      <div className="relative aspect-[2.39/1] w-full border border-graphite bg-sheet">
        <div aria-hidden className="absolute inset-y-0 left-[20.08%] w-[59.84%] border-x border-dashed border-rule-strong" />
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-[26px] leading-tight font-semibold tracking-tight">StoryScript-Mov</p>
          <p className="mt-1.5 text-[13px] text-ink-2">实拍分镜工作台</p>
        </div>
      </div>
      <figcaption className="mt-1.5 flex justify-between text-[11px] text-ink-3 tabular-nums">
        <span>2.39 : 1</span>
        <span>虚线内为 1.43 : 1 保护区</span>
      </figcaption>
    </figure>
  );
}

function RecentProjects() {
  const recent = useRecentProjects();
  const open = useOpenProject();
  const [target, setTarget] = useState<string | null>(null);

  return (
    <section aria-labelledby="recent-title">
      <h2 id="recent-title" className="text-[15px] font-semibold">
        最近项目
      </h2>
      <div className="mt-3">
        {recent.isPending ? <Spinner label="正在读取…" /> : null}
        {recent.isError ? <ErrorNotice error={recent.error} /> : null}
        {recent.data && recent.data.length === 0 ? (
          <p className="border-y border-rule py-4 text-[13px] text-ink-3">还没有打开过项目。新建一个，或打开已有的项目目录。</p>
        ) : null}
        {recent.data && recent.data.length > 0 ? (
          <ul className="divide-y divide-rule border-y border-rule">
            {recent.data.map((p) => {
              const busy = open.isPending && target === p.dir;
              return (
                <li key={p.dir}>
                  <button
                    type="button"
                    disabled={open.isPending}
                    aria-busy={busy || undefined}
                    onClick={() => {
                      setTarget(p.dir);
                      open.mutate(p.dir);
                    }}
                    className="group flex w-full items-baseline gap-3 px-2 py-2.5 text-left hover:bg-sheet-sunk disabled:cursor-wait"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink group-hover:underline">{p.name}</span>
                      <span className="block truncate font-mono text-[12px] text-ink-3" title={p.dir}>
                        {p.dir}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">
                      {busy ? '正在打开…' : <time dateTime={p.opened_at}>{formatOpenedAt(p.opened_at)}</time>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {open.isError && target ? (
          <ErrorNotice className="mt-3" error={open.error} context="open" />
        ) : null}
      </div>
    </section>
  );
}

interface CreateErrors {
  dir?: string;
  name?: string;
  timezone?: string;
  duration?: string;
}

function CreateProjectForm() {
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

      <div className="grid gap-4 sm:grid-cols-2">
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
            <select
              id={id}
              aria-describedby={describedBy}
              value={aspect}
              onChange={(e) => setAspect(e.target.value as Aspect)}
              className="h-8 w-44 rounded-control border border-rule-strong bg-sheet px-2 text-sm text-ink tabular-nums focus-visible:border-focus"
            >
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a} : 1{ASPECT_NOTE[a] ? `（${ASPECT_NOTE[a]}）` : ''}
                </option>
              ))}
            </select>
            <div aria-hidden className="flex h-[52px] w-[72px] items-center justify-center">
              <div className={`w-full border border-graphite bg-board-paper ${ASPECT_BOX[aspect]}`} />
            </div>
          </div>
        )}
      </Field>

      {create.isError ? <ErrorNotice error={create.error} context="create" /> : null}

      <div>
        <Button type="submit" variant="primary" busy={create.isPending}>
          {create.isPending ? null : <FolderPlus aria-hidden className="size-3.5" />}
          创建项目
        </Button>
      </div>
    </form>
  );
}

function OpenProjectForm() {
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
      <div>
        <Button type="submit" busy={open.isPending}>
          {open.isPending ? null : <FolderOpen aria-hidden className="size-3.5" />}
          打开项目
        </Button>
      </div>
    </form>
  );
}

export function HomeView() {
  return (
    <div className="grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="flex flex-col gap-8">
        <TitleCard />
        <p className="max-w-[46ch] text-[13px] leading-relaxed text-ink-2">
          项目就是这台电脑上的一个文件夹，原片只读取、不改动。只有在你配置了模型并使用 AI 功能时，才会把相关内容发给你指定的模型服务。
        </p>
        <RecentProjects />
      </div>

      <div className="flex flex-col gap-6">
        <section aria-labelledby="create-title" className="rounded-sheet border border-rule bg-sheet px-5 py-5 sm:px-6">
          <SectionHeading id="create-title" title="新建项目" description="选一个文件夹作为项目目录。" />
          <div className="mt-4">
            <CreateProjectForm />
          </div>
        </section>

        <section aria-labelledby="open-title" className="rounded-sheet border border-rule bg-sheet px-5 py-5 sm:px-6">
          <SectionHeading id="open-title" title="打开已有项目" description="列表里没有的项目，从这里打开。" />
          <div className="mt-4">
            <OpenProjectForm />
          </div>
        </section>
      </div>
    </div>
  );
}

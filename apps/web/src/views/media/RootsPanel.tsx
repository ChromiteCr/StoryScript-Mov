import { useCallback, useId, useState, type FormEvent } from 'react';
import type { Job, MediaAssetView, SourceRoot } from '@storyscript/contracts';
import { FolderPlus, HardDriveDownload, ScanSearch, Search } from 'lucide-react';
import { FolderField } from '../../components/FolderField.tsx';
import { Button, CopyCommand, Field, Notice, TextInput } from '../../components/ui.tsx';
import { EmptyState } from '../../components/workspace.tsx';
import { formatProgress, JOB_STATUS_LABEL } from '../../lib/jobs.ts';
import { FFMPEG_INSTALL_COMMAND } from '../../lib/labels-media.ts';
import { useAddRoot, useCheckRoot, useJobProgress, useScanRoot, type AssetFilter } from '../../lib/queries-media.ts';
import { displayPath, normalizePastedPath } from '../../lib/format.ts';
import { useHealth } from '../../lib/queries.ts';
import { MediaErrorNotice } from './shared.tsx';

/**
 * Left column of the media page: source folders (add, read-only scan with
 * progress, availability check) and the library filters. Scanning needs
 * ffmpeg; without it everything else keeps working.
 */

export function FfmpegMissing() {
  return (
    <Notice tone="warn" title="没有找到 ffmpeg，素材扫描暂不可用">
      <p>场记、关联、覆盖和导出照常可用。用下面的命令安装后，重启 storyscript-mov：</p>
      <p className="mt-1.5">
        <CopyCommand command={FFMPEG_INSTALL_COMMAND} />
      </p>
    </Notice>
  );
}

interface ScanSummary {
  files?: number;
  added?: number;
  changed?: number;
  offline?: number;
  hashed?: number;
  source_changed?: number;
}

function summaryLine(job: Job): string {
  if (job.status !== 'succeeded') return job.error?.message ?? JOB_STATUS_LABEL[job.status];
  try {
    const s = JSON.parse(job.result_ref ?? '{}') as ScanSummary;
    const parts = [`${s.files ?? 0} 个文件`];
    if (s.added) parts.push(`新增 ${s.added}`);
    if (s.changed) parts.push(`重新索引 ${s.changed}`);
    if (s.offline) parts.push(`离线 ${s.offline}`);
    if (s.source_changed) parts.push(`读取时有变化 ${s.source_changed}`);
    return `扫描完成：${parts.join('，')}`;
  } catch {
    return '扫描完成';
  }
}

function RootRow({ root, assets, scanDisabled }: { root: SourceRoot; assets: readonly MediaAssetView[]; scanDisabled: boolean }) {
  const scan = useScanRoot();
  const check = useCheckRoot();
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const onDone = useCallback((job: Job) => setMessage(summaryLine(job)), []);
  const job = useJobProgress(jobId, onDone);
  const running = job.data !== undefined && (job.data.status === 'queued' || job.data.status === 'running');
  const mine = assets.filter((a) => a.source_root_id === root.id);
  const offline = mine.filter((a) => a.availability === 'offline').length;
  const changed = mine.filter((a) => a.hash_status === 'source_changed').length;
  const progress = running ? formatProgress(job.data?.progress ?? null) : null;
  const home = useHealth().data?.home_dir;

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-graphite-100">{root.label}</span>
        <span className="shrink-0 text-xs text-graphite-300 tabular-nums">{mine.length} 个</span>
      </div>
      <p className="truncate font-mono text-xs text-graphite-300" title={root.abs_path}>
        {displayPath(root.abs_path, home)}
      </p>
      {offline > 0 || changed > 0 ? (
        <p className="text-xs text-graphite-100">
          {offline > 0 ? `${offline} 个离线` : ''}
          {offline > 0 && changed > 0 ? '，' : ''}
          {changed > 0 ? `${changed} 个原片已变化` : ''}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={scanDisabled}
          busy={scan.isPending || running}
          title={scanDisabled ? '需要先安装 ffmpeg' : '只读扫描：登记文件、读取元数据、生成海报帧、计算校验值'}
          onClick={() => {
            setMessage(null);
            scan.mutate(root.id, { onSuccess: (r) => setJobId(r.job_id) });
          }}
        >
          {scan.isPending || running ? null : <ScanSearch aria-hidden className="size-3.5" />}
          {running ? `扫描中 ${progress ?? ''}` : '扫描'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          busy={check.isPending}
          title="逐个检查文件是否还在、大小和修改时间是否变化（不读取内容）"
          onClick={() => {
            setMessage(null);
            check.mutate(root.id, {
              onSuccess: (r) => setMessage(`检查完成：在线 ${r.online}，离线 ${r.offline}，有变化 ${r.changed}`),
            });
          }}
        >
          {check.isPending ? null : <HardDriveDownload aria-hidden className="size-3.5" />}
          检查
        </Button>
      </div>
      {scanDisabled ? <p className="text-xs text-graphite-300">扫描需要 ffmpeg，安装说明见素材库。</p> : null}
      {running ? (
        <div className="h-1 overflow-hidden rounded-full bg-graphite-800" role="progressbar" aria-label={`${root.label} 扫描进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((job.data?.progress ?? 0) * 100)}>
          <div className={`h-full bg-graphite-300 ${progressWidth(job.data?.progress ?? 0)}`} />
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="text-xs text-graphite-300">
        {message}
      </p>
      {scan.isError ? <MediaErrorNotice error={scan.error} /> : null}
      {check.isError ? <MediaErrorNotice error={check.error} /> : null}
    </li>
  );
}

/** CSP forbids inline style: width in 10% steps from static classes. */
const WIDTHS = ['w-0', 'w-1/10', 'w-2/10', 'w-3/10', 'w-4/10', 'w-5/10', 'w-6/10', 'w-7/10', 'w-8/10', 'w-9/10', 'w-full'] as const;
function progressWidth(p: number): string {
  return WIDTHS[Math.max(0, Math.min(10, Math.round(p * 10)))]!;
}

function AddRootForm({ onAdded, initiallyOpen }: { onAdded: () => void; initiallyOpen: boolean }) {
  const add = useAddRoot();
  const [open, setOpen] = useState(initiallyOpen);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = normalizePastedPath(path);
    if (!p) return setError('请选择或粘贴素材文件夹的路径');
    setError(null);
    add.mutate(
      { abs_path: p, ...(label.trim() ? { label: label.trim() } : {}) },
      {
        onSuccess: () => {
          setPath('');
          setLabel('');
          setOpen(false);
          onAdded();
        },
      },
    );
  };

  if (!open) {
    return (
      <div className="px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <FolderPlus aria-hidden className="size-3.5" />
          添加素材目录
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2.5 border-t border-graphite-800 px-3 py-3" aria-label="添加素材目录">
      <Field label="素材文件夹" hint="只读登记：不会复制、移动或改动原片。" error={error}>
        {(ids) => <FolderField {...ids} value={path} onChange={setPath} placeholder="/Volumes/CARD_A" />}
      </Field>
      <Field label="名称（可选）">
        {(ids) => <TextInput id={ids.id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="默认用文件夹名，如 A 机 第一天" />}
      </Field>
      {add.isError ? <MediaErrorNotice error={add.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" busy={add.isPending}>
          添加
        </Button>
        {initiallyOpen ? null : (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
        )}
      </div>
    </form>
  );
}

export function RootsList({ roots, assets, ffmpegOk }: { roots: readonly SourceRoot[]; assets: readonly MediaAssetView[]; ffmpegOk: boolean }) {
  return (
    <div className="flex flex-col">
      {roots.length === 0 ? (
        <EmptyState quiet title="还没有登记素材目录。" description="添加存放素材的文件夹（存储卡或硬盘上的目录），再点扫描。" />
      ) : (
        <ul className="divide-y divide-graphite-800">
          {roots.map((r) => (
            <RootRow key={r.id} root={r} assets={assets} scanDisabled={!ffmpegOk} />
          ))}
        </ul>
      )}
      <AddRootForm initiallyOpen={roots.length === 0} onAdded={() => undefined} />
    </div>
  );
}

export const FILTERS: readonly { id: AssetFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'unlinked', label: '未关联' },
  { id: 'candidate', label: '候选中' },
  { id: 'offline', label: '离线' },
];

export function LibraryFilters({ filter, onFilter, q, onQ }: { filter: AssetFilter; onFilter: (f: AssetFilter) => void; q: string; onQ: (q: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5 p-3">
      <div role="radiogroup" aria-label="筛选素材" className="grid grid-cols-4 gap-0.5 rounded-control border border-graphite-700 bg-graphite-950 p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            onClick={() => onFilter(f.id)}
            className={`h-6 rounded-control text-xs ${filter === f.id ? 'bg-graphite-700 font-medium text-graphite-100' : 'text-graphite-300 hover:text-graphite-100'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <label htmlFor={`${id}-q`} className="sr-only">
          搜索素材
        </label>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-graphite-500" />
        <TextInput id={`${id}-q`} type="search" value={q} onChange={(e) => onQ(e.target.value)} placeholder="文件名或路径，如 A001、雨" className="pl-7" autoComplete="off" spellCheck={false} />
      </div>
    </div>
  );
}

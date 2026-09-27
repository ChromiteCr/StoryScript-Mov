import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaAssetView, SourceRoot } from '@storyscript/contracts';
import { FolderOpen, FolderTree, History, RefreshCw, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { folderFromFiles, folderFromHandle, type FsDirHandle, type LocalFolder } from '../../lib/local-media/folder.ts';
import type { IngestPhase, IngestSummary } from '../../lib/local-media/ingest.ts';
import { listRecentFolders, regainAccess, forgetFolder, type RecentFolder } from '../../lib/local-media/recent.ts';
import type { LinkSituation } from '../../lib/local-media/records.ts';
import {
  closeLocalFolder,
  openLocalFolder,
  setLocalFolderChanged,
  syncLocalFolder,
  useLocalFolder,
  type OpenContext,
} from '../../lib/local-media/store.ts';
import { mediaKeys } from '../../lib/queries-media.ts';
import { useCurrentProject } from '../../lib/queries.ts';

/**
 * Hosted server: the team's footage stays on each member's computer. A member
 * opens their project folder here (like opening a folder in VS Code); the
 * browser reads the footage locally and sends only facts and small posters.
 * The folder keeps its own records in .storyscript-mov/.
 */

const PHASE_LABEL: Record<IngestPhase, string> = {
  listing: '正在列出文件',
  probing: '正在读取素材信息',
  posters: '正在截取海报帧',
  hashing: '正在计算校验值（可以先用素材库）',
  done: '完成',
};

type Asking = { situation: Exclude<LinkSituation, { kind: 'linked' }>; folder: LocalFolder; resolve: (ok: boolean) => void };

const canPickDirectory = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function summaryText(s: IngestSummary): string {
  const parts = [`共 ${s.files} 个素材`];
  const delta = [s.added ? `新增 ${s.added}` : '', s.changed ? `改动 ${s.changed}` : '', s.offline ? `不在了 ${s.offline}` : ''].filter(Boolean);
  if (delta.length) parts.push(delta.join('，'));
  if (s.unreadable) parts.push(`${s.unreadable} 个在浏览器里读不出信息（MXF 等格式请用单机版处理）`);
  return parts.join('；');
}

export function ProjectFolderPanel({ roots, assets, onShowFolder }: { roots: readonly SourceRoot[]; assets: readonly MediaAssetView[]; onShowFolder: (prefix: string) => void }) {
  const project = useCurrentProject().data;
  const qc = useQueryClient();
  const s = useLocalFolder();
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const picker = canPickDirectory();

  useEffect(() => {
    setLocalFolderChanged(() => void qc.invalidateQueries({ queryKey: mediaKeys.all }));
    return () => setLocalFolderChanged(() => undefined);
  }, [qc]);

  useEffect(() => {
    if (project) void listRecentFolders(project.id).then(setRecent);
  }, [project, s.folder]);

  const teamFolders = roots.filter((r) => r.kind === 'browser');
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) m.set(a.source_root_id, (m.get(a.source_root_id) ?? 0) + 1);
    return m;
  }, [assets]);
  const subfolders = useMemo(() => {
    if (!s.link) return [];
    const m = new Map<string, number>();
    for (const a of assets) {
      if (a.source_root_id !== s.link.root_id) continue;
      const top = a.rel_path.includes('/') ? a.rel_path.split('/')[0]! : '';
      m.set(top, (m.get(top) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [assets, s.link]);

  if (!project) return null;

  const ctx = (): OpenContext => ({
    site: window.location.origin,
    projectId: project.id,
    roots,
    createRoot: (label) => api.call('createBrowserRoot', { label: label.slice(0, 80) || '本机文件夹' }),
    confirm: (situation, folder) => new Promise((resolve) => setAsking({ situation, folder, resolve })),
  });

  const open = async (folder: LocalFolder) => {
    setError(null);
    setOpening(true);
    try {
      await openLocalFolder(folder, ctx());
    } catch (err) {
      setError(err);
    } finally {
      setOpening(false);
    }
  };

  const pick = async () => {
    if (!picker) {
      input.current?.click();
      return;
    }
    try {
      const pickDir = (window as unknown as { showDirectoryPicker(o: object): Promise<FsDirHandle> }).showDirectoryPicker;
      const handle = await pickDir({ mode: 'readwrite', id: 'storyscript-project' });
      await open(folderFromHandle(handle, true));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err);
    }
  };

  const reopen = async (r: RecentFolder) => {
    setError(null);
    try {
      if (!(await regainAccess(r.handle))) {
        setError(new Error(`没有获得「${r.name}」的访问权限。`));
        return;
      }
      await open(folderFromHandle(r.handle, true));
    } catch {
      await forgetFolder(r.key);
      setRecent((list) => list.filter((x) => x.key !== r.key));
      setError(new Error(`找不到「${r.name}」了：文件夹可能已移动或删除，请重新打开。`));
    }
  };

  const answer = (ok: boolean) => {
    asking?.resolve(ok);
    setAsking(null);
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {s.folder && s.link ? (
        <>
          <div className="flex items-start gap-2">
            <FolderOpen aria-hidden className="mt-0.5 size-4 shrink-0 text-graphite-300" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-graphite-100" title={s.folder.name}>
                {s.folder.name}
              </p>
              <p className="text-xs text-graphite-300">{s.folder.writable ? '记录保存在文件夹里的 .storyscript-mov' : '只读打开：不写记录，下次需要重新选择'}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={closeLocalFolder} title="关闭这个项目文件夹（素材和记录都保留）">
              <X aria-hidden className="size-3.5" />
              <span className="sr-only">关闭文件夹</span>
            </Button>
          </div>
          {s.syncing && s.progress ? (
            <div className="flex flex-col gap-1" role="status" aria-live="polite">
              <p className="text-xs text-graphite-100">
                {PHASE_LABEL[s.progress.phase]}
                {s.progress.total ? <span className="tabular-nums">（{Math.min(s.progress.done + 1, s.progress.total)}/{s.progress.total}）</span> : null}
              </p>
              <progress className="h-1 w-full accent-accent" max={s.progress.total || 1} value={s.progress.total ? s.progress.done : 0} />
              {s.progress.current ? <p className="truncate font-mono text-xs text-graphite-300">{s.progress.current}</p> : null}
            </div>
          ) : s.summary ? (
            <p className="text-xs text-graphite-300" role="status">
              {summaryText(s.summary)}
            </p>
          ) : null}
          {s.error ? <ErrorNotice error={s.error} context="media" /> : null}
          <Button size="sm" className="self-start" busy={s.syncing} disabled={s.syncing} onClick={() => void syncLocalFolder()}>
            {s.syncing ? null : <RefreshCw aria-hidden className="size-3.5" />}
            重新扫描
          </Button>
          {subfolders.length > 0 ? (
            <section aria-label="文件夹">
              <p className="mb-1 flex items-center gap-1 text-xs text-graphite-300">
                <FolderTree aria-hidden className="size-3.5" />
                文件夹
              </p>
              <ul className="flex flex-col">
                {subfolders.map(([name, n]) => (
                  <li key={name || '(root)'}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-control px-1.5 py-1 text-left text-sm text-graphite-100 hover:bg-graphite-800"
                      onClick={() => onShowFolder(name ? `${name}/` : '')}
                    >
                      <span className="truncate">{name || '（文件夹根目录）'}</span>
                      <span className="text-xs text-graphite-300 tabular-nums">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-xs leading-5 text-graphite-300">
            把素材放在一个项目文件夹里（例如 A-roll、B-roll 两个子文件夹），在这里打开。视频不会上传：浏览器在本机读取素材信息，只把信息和海报小图发到服务器。
          </p>
          <Button variant="primary" className="self-start" busy={opening} onClick={() => void pick()}>
            {opening ? null : <FolderOpen aria-hidden className="size-3.5" />}
            打开项目文件夹…
          </Button>
          {!picker ? (
            <Notice tone="info" title="这个浏览器只能只读打开">
              记录不会写进文件夹，每次都要重新选择。用 Chrome 或 Edge 可以记住文件夹，并在文件夹里保存记录。
            </Notice>
          ) : null}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: '' }}
            onChange={(e) => {
              const files = e.target.files ? [...e.target.files] : [];
              e.target.value = '';
              if (files.length) void open(folderFromFiles(files));
            }}
            data-testid="project-folder-input"
          />
          {recent.length > 0 ? (
            <section aria-label="最近打开">
              <p className="mb-1 flex items-center gap-1 text-xs text-graphite-300">
                <History aria-hidden className="size-3.5" />
                最近打开
              </p>
              <ul className="flex flex-col">
                {recent.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      className="w-full truncate rounded-control px-1.5 py-1 text-left text-sm text-graphite-100 hover:bg-graphite-800"
                      onClick={() => void reopen(r)}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {teamFolders.length > 0 ? (
            <section aria-label="本队的项目文件夹">
              <p className="mb-1 text-xs text-graphite-300">本队登记过的项目文件夹（在队员的电脑上）</p>
              <ul className="flex flex-col gap-0.5">
                {teamFolders.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-1.5 text-sm text-graphite-100">
                    <span className="truncate">{r.label}</span>
                    <span className="text-xs text-graphite-300 tabular-nums">{counts.get(r.id) ?? 0} 个</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      {error ? <ErrorNotice error={error} context="media" /> : null}

      {asking ? (
        <Dialog
          title={asking.situation.kind === 'new' ? '把这个文件夹用作本队的项目文件夹？' : asking.situation.kind === 'other' ? '这个文件夹属于另一个项目' : '重新登记这个文件夹？'}
          onClose={() => answer(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => answer(false)}>取消</Button>
              <Button variant="primary" onClick={() => answer(true)}>
                {asking.situation.kind === 'other' ? '改连到本队项目' : '使用这个文件夹'}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-2 text-sm leading-6 text-graphite-100">
            {asking.situation.kind === 'other' ? (
              <p>
                「{asking.folder.name}」之前连到了 {asking.situation.link.site} 上的另一个项目。改连到本队项目后，原来的记录会被覆盖；视频本身不受影响。
              </p>
            ) : asking.situation.kind === 'stale' ? (
              <p>「{asking.folder.name}」的记录指向的素材目录在服务器上已经不存在。重新登记后，素材信息会重新上报。</p>
            ) : (
              <p>「{asking.folder.name}」里的视频不会上传。浏览器会在本机读取素材信息，只把信息和海报小图发到服务器。</p>
            )}
            <p className="text-graphite-300">
              {asking.folder.writable
                ? '记录会保存在文件夹里新建的 .storyscript-mov 中，不会改动任何视频文件。'
                : '这个浏览器不能在文件夹里写记录，下次打开需要重新选择并重新计算。'}
            </p>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Film, ListChecks, Printer, Wand2 } from 'lucide-react';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Spinner } from '../../components/ui.tsx';
import { EmptyState, PageHeader, Panel, Workspace } from '../../components/workspace.tsx';
import { useCurrentProject, useHealth } from '../../lib/queries.ts';
import {
  useAssets,
  useAssetSearch,
  useCoverage,
  useLinks,
  useMediaScript,
  useMediaShots,
  useRoots,
  useTakes,
  type AssetFilter,
} from '../../lib/queries-media.ts';
import { stageDef } from '../../lib/stages.ts';
import { buildShotRefs } from '../set/model.ts';
import { AssetGrid } from './AssetGrid.tsx';
import { AssetInspector } from './AssetInspector.tsx';
import { CandidateReview } from './CandidateReview.tsx';
import { CoveragePanel } from './CoveragePanel.tsx';
import { MissingReportPrint } from './MissingReportPrint.tsx';
import { coverageCsv, exportName, missingReport, takeMediaCsv } from './model.ts';
import { FfmpegMissing, LibraryFilters, RootsList } from './RootsPanel.tsx';
import { ProjectFolderPanel } from './ProjectFolderPanel.tsx';
import { downloadText } from './shared.tsx';

/**
 * 素材 (#/media, FR-08/09/10): source folders and filters on the left, the
 * poster grid in the middle, the selected clip on the right, coverage and the
 * missing list along the bottom. Candidate review opens as a drawer.
 */

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function MediaView() {
  const { label, lead } = stageDef('media');
  const project = useCurrentProject();
  const health = useHealth();
  const roots = useRoots();
  const allAssets = useAssets();
  const shots = useMediaShots();
  const script = useMediaScript();
  const takes = useTakes();
  const links = useLinks();
  const coverage = useCoverage();

  const [filter, setFilter] = useState<AssetFilter>('all');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 250);
  const shown = useAssetSearch(debouncedQ, filter);
  const [selected, setSelected] = useState<string | null>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  // stacked layout (< 1024px): the inspector sits below the grid, so bring it into view
  const select = (id: string) => {
    setSelected(id);
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' }));
  };
  const [reviewOpen, setReviewOpen] = useState(false);

  const refs = useMemo(() => buildShotRefs(shots.data ?? [], script.data?.scenes ?? []), [shots.data, script.data]);
  const assetMap = useMemo(() => new Map((allAssets.data ?? []).map((a) => [a.id, a] as const)), [allAssets.data]);
  const candidates = (links.data ?? []).filter((l) => l.status === 'candidate').length;
  const report = useMemo(() => missingReport(coverage.data ?? [], refs), [coverage.data, refs]);

  const h = health.data;
  // a hosted server never reads footage, so its ffmpeg does not matter
  const ffmpegOk = !h || h.hosted || Boolean(h.ffmpeg.path && h.ffprobe.path);
  const projectName = project.data?.name ?? '项目';
  const selectedAsset = selected ? assetMap.get(selected) ?? null : null;

  const exportTakeMedia = () =>
    downloadText(
      `${exportName(projectName, '场记与素材')}.csv`,
      takeMediaCsv({ refs, takes: takes.data ?? [], links: links.data ?? [], assets: assetMap }),
    );
  const exportCoverage = () => downloadText(`${exportName(projectName, '覆盖状态')}.csv`, coverageCsv(coverage.data ?? [], refs));

  const header = (
    <PageHeader
      title={label}
      icon={Film}
      lead={lead}
      actions={
        <>
          <Button size="sm" onClick={() => setReviewOpen(true)}>
            <Wand2 aria-hidden className="size-3.5" />
            候选审核{candidates > 0 ? <span className="tabular-nums">（{candidates}）</span> : null}
          </Button>
          <Button size="sm" variant="ghost" onClick={exportTakeMedia} title="每条场记与关联片段一行，含 source_range 五列整数">
            <Download aria-hidden className="size-3.5" />
            场记与素材 CSV
          </Button>
        </>
      }
    />
  );

  const listError = roots.error ?? allAssets.error ?? null;

  let grid;
  if (shown.isPending && !shown.data) grid = <Spinner label="正在读取素材…" />;
  else if (shown.isError) grid = <ErrorNotice error={shown.error} />;
  else if ((allAssets.data ?? []).length === 0)
    grid = (
      <EmptyState
        icon={Film}
        title="素材库是空的。"
        description={
          h?.hosted
            ? '打开项目文件夹后，素材会出现在这里。视频不会上传到服务器。'
            : !ffmpegOk
            ? (roots.data ?? []).length === 0
              ? '先添加存放素材的文件夹；装好 ffmpeg 并重启后就能扫描。原片只读，不会被复制或改动。'
              : '装好 ffmpeg 并重启后，在素材目录上点"扫描"。'
            : (roots.data ?? []).some((r) => r.kind === 'project')
              ? '把素材放进项目文件夹（例如 A-roll、B-roll 子文件夹），重新打开项目或在左侧点"扫描"即可登记。原片只读，不会被改动。'
              : (roots.data ?? []).length === 0
                ? '先添加存放素材的文件夹，再点扫描。原片只读，不会被复制或改动。'
                : '在素材目录上点"扫描"，登记其中的视频、声音和图片。'
        }
      />
    );
  else if ((shown.data ?? []).length === 0) grid = <EmptyState title="没有符合条件的素材。" description="换一个筛选，或清空搜索词。" />;
  else grid = <AssetGrid assets={shown.data ?? []} selectedId={selected} onSelect={select} />;

  return (
    <>
      <Workspace
        header={header}
        left={
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <Panel title={h?.hosted ? '项目文件夹' : '素材目录'} padded={false}>
              {roots.isPending ? (
                <div className="p-3">
                  <Spinner label="正在读取…" />
                </div>
              ) : listError ? (
                <div className="p-3">
                  <ErrorNotice error={listError} />
                </div>
              ) : h?.hosted ? (
                <ProjectFolderPanel roots={roots.data ?? []} assets={allAssets.data ?? []} onShowFolder={setQ} />
              ) : (
                <RootsList roots={roots.data ?? []} assets={allAssets.data ?? []} ffmpegOk={ffmpegOk} />
              )}
            </Panel>
            <Panel title="筛选" padded={false} className="flex-none">
              <LibraryFilters filter={filter} onFilter={setFilter} q={q} onQ={setQ} />
            </Panel>
          </div>
        }
        right={
          <div ref={inspectorRef} className="flex min-h-0 flex-1 scroll-mt-2 flex-col">
            <Panel title="检查器" padded={false}>
              <AssetInspector asset={selectedAsset} refs={refs} takes={takes.data ?? []} links={links.data ?? []} />
            </Panel>
          </div>
        }
        bottom={
          <Panel
            title={`覆盖与漏拍 · 漏拍 ${report.total}`}
            padded={false}
            tools={
              <>
                <Button size="sm" variant="ghost" onClick={exportCoverage} disabled={!coverage.data}>
                  <ListChecks aria-hidden className="size-3.5" />
                  覆盖 CSV
                </Button>
                <Button size="sm" variant="ghost" onClick={() => window.print()} disabled={!coverage.data}>
                  <Printer aria-hidden className="size-3.5" />
                  打印漏拍报告
                </Button>
              </>
            }
          >
            {coverage.isPending || shots.isPending ? (
              <div className="p-3">
                <Spinner label="正在计算覆盖…" />
              </div>
            ) : coverage.isError ? (
              <div className="p-3">
                <ErrorNotice error={coverage.error} />
              </div>
            ) : (
              <CoveragePanel coverage={coverage.data ?? []} refs={refs} links={links.data ?? []} assets={assetMap} takes={takes.data ?? []} />
            )}
          </Panel>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col print:hidden">
          <Panel
            bodyClassName="flex flex-col"
            title={`素材库${allAssets.data ? ` · ${(shown.data ?? []).length} / ${allAssets.data.length}` : ''}`}
            tools={
              <Button size="sm" variant="ghost" onClick={() => setReviewOpen(true)}>
                <Wand2 aria-hidden className="size-3.5" />
                生成候选
              </Button>
            }
          >
            {!ffmpegOk ? (
              <div className="mb-3 max-w-[560px]">
                <FfmpegMissing />
              </div>
            ) : null}
            <div className="flex flex-1 flex-col">{grid}</div>
          </Panel>
        </div>
        <MissingReportPrint project={projectName} coverage={coverage.data ?? []} refs={refs} />
      </Workspace>
      {reviewOpen ? (
        <CandidateReview onClose={() => setReviewOpen(false)} refs={refs} takes={takes.data ?? []} links={links.data ?? []} assets={assetMap} />
      ) : null}
    </>
  );
}

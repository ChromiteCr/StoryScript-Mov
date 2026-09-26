import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Download, ScrollText } from 'lucide-react';
import { DEFAULT_SLATE_FORMAT } from '@storyscript/core';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Spinner, Tag } from '../../components/ui.tsx';
import { EmptyState, PageHeader, Panel, Workspace } from '../../components/workspace.tsx';
import { useCurrentProject } from '../../lib/queries.ts';
import { useAssets, useLinks, useMediaScript, useMediaShots, usePlansForSet, useSetupsForSet, useTakes } from '../../lib/queries-media.ts';
import { pageHref, stageDef } from '../../lib/stages.ts';
import { downloadText } from '../media/shared.tsx';
import { exportName, takeMediaCsv } from '../media/model.ts';
import { buildShotRefs, nextTakeNo, setupOfShot, shootingOrder, takesForShot } from './model.ts';
import { OrderList } from './OrderList.tsx';
import { CurrentShotCard, TakeForm } from './TakeForm.tsx';
import { TakeList } from './TakeList.tsx';

/**
 * 现场 (#/set, FR-07): log takes on set. Left: shots in shooting order;
 * main: the current shot in large type and the quick take form; right: the
 * shot's takes, correctable with a reason.
 */

function todayIn(timeZone: string | undefined): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return null;
  }
}

export function SetView() {
  const { label, lead } = stageDef('set');
  const project = useCurrentProject();
  const shots = useMediaShots();
  const script = useMediaScript();
  const takes = useTakes();
  const plans = usePlansForSet();
  const setups = useSetupsForSet();
  const links = useLinks();
  const assets = useAssets();

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [extras, setExtras] = useState<string[]>([]);

  const refs = useMemo(() => buildShotRefs(shots.data ?? [], script.data?.scenes ?? []), [shots.data, script.data]);
  const order = useMemo(
    () => shootingOrder(refs, plans.data ?? [], setups.data ?? [], todayIn(project.data?.timezone)),
    [refs, plans.data, setups.data, project.data?.timezone],
  );
  const refsById = useMemo(() => new Map(refs.map((r) => [r.shot.id, r] as const)), [refs]);

  // keep a valid current shot: the first of the day until the operator picks one
  useEffect(() => {
    if (order.refs.length === 0) return;
    if (currentId === null || !refsById.has(currentId)) setCurrentId(order.refs[0]!.shot.id);
  }, [order.refs, currentId, refsById]);

  const select = (id: string) => {
    setCurrentId(id);
    setExtras([]);
  };
  const toggleExtra = (id: string) => setExtras((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const takeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of takes.data ?? []) for (const id of t.shot_ids) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [takes.data]);

  const loading = shots.isPending || script.isPending || takes.isPending;
  const loadError = shots.error ?? script.error ?? takes.error ?? null;
  const current = currentId ? refsById.get(currentId) ?? null : null;
  const extraRefs = extras.map((id) => refsById.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined && r.shot.id !== currentId);
  const codeFormat = project.data?.code_format ?? DEFAULT_SLATE_FORMAT;

  const exportCsv = () => {
    const csv = takeMediaCsv({
      refs,
      takes: takes.data ?? [],
      links: links.data ?? [],
      assets: new Map((assets.data ?? []).map((a) => [a.id, a] as const)),
    });
    downloadText(`${exportName(project.data?.name ?? '项目', '场记与素材')}.csv`, csv);
  };

  const header = (
    <PageHeader
      title={label}
      icon={Clapperboard}
      lead={lead}
      status={order.source === 'plan' ? <Tag>按已批准计划 {order.plan?.date}</Tag> : refs.length > 0 ? <Tag>按叙事顺序</Tag> : undefined}
      actions={
        <Button size="sm" onClick={exportCsv} disabled={(takes.data ?? []).length === 0}>
          <Download aria-hidden className="size-3.5" />
          导出场记 CSV
        </Button>
      }
    />
  );

  if (loading || loadError) {
    return (
      <Workspace header={header}>
        <Panel title="场记录入">{loadError ? <ErrorNotice error={loadError} /> : <Spinner label="正在读取镜头和场记…" />}</Panel>
      </Workspace>
    );
  }

  if (refs.length === 0) {
    return (
      <Workspace header={header}>
        <Panel title="场记录入">
          <EmptyState
            icon={ScrollText}
            title="还没有镜头。"
            description="场记按镜头记录：先在剧本页导入剧本并拆出镜头。"
            action={
              <a href={pageHref('script')} className="inline-flex h-7 items-center rounded-control bg-graphite-100 px-3 text-sm font-medium text-graphite-950 hover:bg-graphite-100/85">
                去剧本页拆镜
              </a>
            }
          />
        </Panel>
      </Workspace>
    );
  }

  const shotTakes = current ? takesForShot(takes.data ?? [], current.shot.id) : [];
  const allTakes = takes.data ?? [];

  return (
    <Workspace
      header={header}
      left={
        <Panel title={order.source === 'plan' ? '拍摄顺序（已批准计划）' : '拍摄顺序（叙事顺序）'} padded={false} className="max-h-[45dvh] lg:max-h-none">
          <OrderList order={order} currentId={currentId} included={new Set(extras)} takeCounts={takeCounts} onSelect={select} onToggleInclude={toggleExtra} />
        </Panel>
      }
      right={
        <Panel title={current ? `本镜条次 · ${current.label}` : '本镜条次'} padded={false}>
          {current ? <TakeList takes={shotTakes} refsById={refsById} currentId={current.shot.id} /> : null}
        </Panel>
      }
    >
      <Panel title="场记录入" bodyClassName="flex flex-col gap-4">
        {current ? (
          <>
            <CurrentShotCard current={current} codeFormat={codeFormat} nextTake={nextTakeNo(allTakes, [current.shot.id, ...extraRefs.map((x) => x.shot.id)])} />
            <TakeForm
              current={current}
              extras={extraRefs}
              onRemoveExtra={toggleExtra}
              takes={allTakes}
              codeFormat={codeFormat}
              setupId={order.source === 'plan' ? setupOfShot(setups.data ?? [], current.shot.id) : null}
              onSaved={() => undefined}
            />
          </>
        ) : null}
      </Panel>
    </Workspace>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarPlus } from 'lucide-react';
import type { Project } from '@storyscript/contracts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, SelectInput, Spinner } from '../../components/ui.tsx';
import { PageHeader, Panel, Workspace } from '../../components/workspace.tsx';
import { OUTCOME, approvalState } from '../../lib/labels-plan.ts';
import { buildLookup, localTime } from '../../lib/print-plan.ts';
import { useCurrentProject, useHealth } from '../../lib/queries.ts';
import { planKeys, usePlanDetail, usePlans } from '../../lib/queries-plan.ts';
import { stageDef } from '../../lib/stages.ts';
import { todayIn, usePlanData } from './data.ts';
import { NewPlanDialog } from './NewPlanDialog.tsx';
import { PlanDayPanel } from './PlanDayPanel.tsx';
import { PlanInspector } from './PlanInspector.tsx';
import { PrintPreview, type PrintMode } from './PrintViews.tsx';
import { ResourcesPanel } from './ResourcesPanel.tsx';
import { SetupsPanel } from './SetupsPanel.tsx';

/**
 * #/plan — shooting-day plan (U-03, FR-06). Left: resources and setups in
 * shooting order; main: the day (status, reasons, call sheet on paper);
 * right: the selected setup and its constraints. Exports are built in the
 * browser (print views and CSV).
 */

const SELECTED_KEY = 'storyscript.plan.selected';

function readSelected(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function writeSelected(id: string): void {
  try {
    window.localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // per-viewer convenience only
  }
}

/** Default export for React.lazy (PlanView.tsx): the page loads as its own chunk. */
export default function PlanRoute() {
  const project = useCurrentProject();
  if (!project.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="正在读取项目…" />
      </div>
    );
  }
  return <PlanPage project={project.data} />;
}

function PlanPage({ project }: { project: Project }) {
  const health = useHealth();
  const loaded = usePlanData(project);
  const plans = usePlans();
  const [chosen, setChosen] = useState<string | null>(readSelected);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [print, setPrint] = useState<PrintMode | null>(null);
  const [creating, setCreating] = useState(false);

  const qc = useQueryClient();
  const list = plans.data ?? [];
  // a just-created plan is already in the detail cache before the list refetch lands
  const known = chosen !== null && (list.some((p) => p.id === chosen) || qc.getQueryData(planKeys.plan(chosen)) !== undefined);
  const planId = known ? chosen : (list[0]?.id ?? null);
  const detailQuery = usePlanDetail(planId);
  const detail = detailQuery.data && detailQuery.data.plan.id === planId ? detailQuery.data : null;

  useEffect(() => {
    if (planId) writeSelected(planId);
  }, [planId]);

  const tz = project.timezone;
  const refDate = detail?.plan.date ?? todayIn(tz);
  const data = loaded.data;
  const lookup = useMemo(
    () =>
      data && detail
        ? buildLookup({
            timezone: tz,
            date: detail.plan.date,
            setups: data.setups,
            shots: data.shots,
            resources: data.resources,
            scenes: data.scenes,
            // performers read "周远（饰 林川）" on the call sheet and in its CSV
            characters: data.entities.filter((e) => e.type === 'character').map((e) => ({ id: e.id, name: e.name })),
          })
        : null,
    [data, detail, tz],
  );
  const crew = detail ? crewLabel(detail.plan.day_start_utc, detail.plan.result.blocks, tz, detail.plan.date) : '';

  if (loaded.error || plans.isError) {
    return (
      <div className="mx-auto flex max-w-[520px] flex-col items-start gap-3 px-4 py-10">
        <ErrorNotice error={loaded.error ?? plans.error} />
        <Button
          onClick={() => {
            loaded.refetch();
            void plans.refetch();
          }}
        >
          重试
        </Button>
      </div>
    );
  }
  if (!data || plans.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="正在读取计划…" />
      </div>
    );
  }

  if (print && detail && lookup) {
    return <PrintPreview mode={print} data={data} detail={detail} lookup={lookup} crew={crew} onBack={() => setPrint(null)} />;
  }

  const nextDate = list[0] ? addDays(list[0].date, 1) : todayIn(tz);

  return (
    <>
      <Workspace
        header={
          <PageHeader
            title={stageDef('plan').label}
            icon={CalendarClock}
            lead="排出单日拍摄顺序，批准前逐条校验；只改拍摄顺序，不改叙事顺序。"
            actions={
              <>
                {list.length > 0 ? (
                  <SelectInput aria-label="选择计划" className="w-[min(220px,52vw)]" value={planId ?? ''} onChange={(e) => setChosen(e.target.value)}>
                    {list.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.date} · {OUTCOME[p.result.outcome].label} · {approvalState(p.status, false).label}
                      </option>
                    ))}
                  </SelectInput>
                ) : null}
                <Button onClick={() => setCreating(true)}>
                  <CalendarPlus aria-hidden className="size-3.5" />
                  新建计划
                </Button>
              </>
            }
          />
        }
        left={
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <ResourcesPanel data={data} refDate={refDate} />
            <SetupsPanel data={data} detail={detail} selected={setupId} onSelect={setSetupId} />
          </div>
        }
        right={
          <Panel title="检查器" padded={false}>
            <PlanInspector data={data} detail={detail} setupId={setupId} onSelect={setSetupId} planDate={refDate} />
          </Panel>
        }
      >
        {planId && !detail ? (
          <Panel title="拍摄日">
            {detailQuery.isError ? (
              <ErrorNotice error={detailQuery.error} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Spinner label="正在读取计划…" />
              </div>
            )}
          </Panel>
        ) : (
          <PlanDayPanel
            data={data}
            detail={detail}
            lookup={lookup}
            crew={crew}
            health={health.data}
            onPrint={setPrint}
            onNewPlan={() => setCreating(true)}
          />
        )}
      </Workspace>
      {creating ? (
        <NewPlanDialog
          timezone={tz}
          defaultDate={nextDate}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setChosen(p.id);
            setCreating(false);
          }}
        />
      ) : null}
    </>
  );
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "08:00" plus the last block end, e.g. "08:00 · 末块 17:30". */
function crewLabel(dayStart: string, blocks: { end_utc: string }[], tz: string, date: string): string {
  const call = localTime(dayStart, tz, date);
  if (blocks.length === 0) return call;
  const last = blocks.reduce((m, b) => (b.end_utc > m ? b.end_utc : m), blocks[0]!.end_utc);
  return `${call} · 末块结束 ${localTime(last, tz, date)}`;
}

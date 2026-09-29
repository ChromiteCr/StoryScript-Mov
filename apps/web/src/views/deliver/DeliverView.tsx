import { useMemo, useState, type ReactNode } from 'react';
import { Braces, Download, FileSpreadsheet, PackageCheck, Printer } from 'lucide-react';
import type { Plan, PlanDetail, Project } from '@storyscript/contracts';
import { exportPlanChoice, takeLogCsv, type ExportCsvKind } from '@storyscript/core';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, SelectInput, Spinner, Tag, type TagTone } from '../../components/ui.tsx';
import { Inspector, InspectorGroup, PageHeader, Panel, Workspace } from '../../components/workspace.tsx';
import {
  AI_BADGE_COPY,
  BOM_HINT,
  DELIVER_GROUPS,
  DELIVER_ITEM,
  NOT_PROVIDED,
  PROJECT_JSON_EXCLUDES,
  STATE_LABEL,
  type DeliverItemId,
  type DeliverState,
} from '../../lib/labels-deliver.ts';
import { buildLookup, exportFileName, localTime } from '../../lib/print-plan.ts';
import { useCurrentProject, useCurrentScript } from '../../lib/queries.ts';
import { useBoardScriptVersions } from '../../lib/queries-boards.ts';
import {
  downloadExport,
  exportCsvUrl,
  PROJECT_JSON_URL,
  readBomPref,
  saveText,
  useAiBadgePref,
  useDeliverBoards,
  useDeliverCoverage,
  useDeliverLinks,
  useDeliverPlan,
  useDeliverPlans,
  useDeliverShots,
  useDeliverTakes,
  writeBomPref,
} from '../../lib/queries-deliver.ts';
import { stageDef } from '../../lib/stages.ts';
import { BoardPrint } from '../boards/BoardPrint.tsx';
import { MissingReportPrint } from '../media/MissingReportPrint.tsx';
import { CheckRow } from '../plan/controls.tsx';
import { usePlanData } from '../plan/data.ts';
import { PrintPreview } from '../plan/PrintViews.tsx';
import { buildShotRefs } from '../set/model.ts';
import { adoptedAiCount, deliverItems, deliverSummary, dispositionFilename, type DeliverItem } from './model.ts';

/**
 * 交付 (#/deliver, FR-10): one checklist of everything the project can hand
 * over — what each file contains, whether it is a draft and why, and the
 * button that makes it. PDFs are the browser's print views (the same views
 * the boards and plan pages open); CSV and the project JSON come from the
 * server's export routes, built by the same core functions as the pages.
 */

type PrintMode = 'boards' | 'topview' | 'callsheet' | 'slates';

const STATE_TONE: Record<DeliverState, TagTone> = { ready: 'ok', draft: 'warn', empty: 'neutral', unavailable: 'neutral' };

const CSV_KIND: Partial<Record<DeliverItemId, ExportCsvKind>> = {
  callsheet: 'callsheet',
  'shots-csv': 'shots',
  'takes-media': 'takes-media',
  'coverage-csv': 'coverage',
};

function crewLabel(detail: PlanDetail): string {
  const { plan } = detail;
  const call = localTime(plan.day_start_utc, plan.timezone, plan.date);
  const blocks = plan.result.blocks;
  if (blocks.length === 0) return call;
  const last = blocks.reduce((m, b) => (b.end_utc > m ? b.end_utc : m), blocks[0]!.end_utc);
  return `${call} · 末块结束 ${localTime(last, plan.timezone, plan.date)}`;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-4">{children}</div>;
}

/** Default export for React.lazy: the page loads as its own chunk. */
export default function DeliverRoute() {
  const project = useCurrentProject();
  if (!project.data) {
    return (
      <Centered>
        <Spinner label="正在读取项目…" />
      </Centered>
    );
  }
  return <DeliverPage project={project.data} />;
}

interface Feedback {
  id: DeliverItemId;
  kind: 'saved' | 'error';
  text?: string;
  error?: unknown;
}

function DeliverPage({ project }: { project: Project }) {
  const { label, lead } = stageDef('deliver');
  const shots = useDeliverShots();
  const boards = useDeliverBoards();
  const plans = useDeliverPlans();
  const takes = useDeliverTakes();
  const links = useDeliverLinks();
  const coverage = useDeliverCoverage();
  const script = useCurrentScript();
  const scriptVersions = useBoardScriptVersions();
  const planData = usePlanData(project);

  const [chosenPlan, setChosenPlan] = useState<string | null>(null);
  const planList: Plan[] = plans.data ?? [];
  const defaultPlan = exportPlanChoice(planList);
  const planId = chosenPlan && planList.some((p) => p.id === chosenPlan) ? chosenPlan : (defaultPlan?.id ?? null);
  const planDetail = useDeliverPlan(planId);
  const detail = planDetail.data && planDetail.data.plan.id === planId ? planDetail.data : null;

  const [print, setPrint] = useState<PrintMode | null>(null);
  const [bom, setBomState] = useState(readBomPref);
  const setBom = (v: boolean) => {
    setBomState(v);
    writeBomPref(v);
  };
  const [aiBadge, setAiBadge] = useAiBadgePref();
  const [busy, setBusy] = useState<DeliverItemId | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const scenes = useMemo(() => script.data?.scenes ?? [], [script.data]);
  const refs = useMemo(() => buildShotRefs(shots.data ?? [], scenes), [shots.data, scenes]);
  const lookup = useMemo(
    () =>
      planData.data && detail
        ? buildLookup({
            timezone: detail.plan.timezone,
            date: detail.plan.date,
            setups: planData.data.setups,
            shots: planData.data.shots,
            resources: planData.data.resources,
            scenes: planData.data.scenes,
            characters: planData.data.entities.filter((e) => e.type === 'character').map((e) => ({ id: e.id, name: e.name })),
          })
        : null,
    [planData.data, detail],
  );
  const scriptVersion = useMemo(() => {
    const cur = script.data?.version.id;
    const sorted = [...(scriptVersions.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const i = sorted.findIndex((x) => x.id === cur);
    return i >= 0 ? `剧本第 ${i + 1} 版` : null;
  }, [scriptVersions.data, script.data]);

  const loaded = shots.data && boards.data && plans.data && takes.data && links.data && coverage.data && script.data !== undefined;
  const items = useMemo(
    () =>
      loaded
        ? deliverItems({
            shots: shots.data!,
            boards: boards.data!,
            plan: detail,
            takes: takes.data!,
            links: links.data!,
            coverage: coverage.data!,
          })
        : null,
    [loaded, shots.data, boards.data, detail, takes.data, links.data, coverage.data],
  );
  const summary = items ? deliverSummary(items) : null;
  const aiCount = adoptedAiCount(boards.data ?? []);

  const header = (
    <PageHeader
      title={label}
      icon={PackageCheck}
      lead={lead}
      status={
        summary ? (
          <span className="flex items-center gap-1.5">
            <Tag tone="ok">{summary.ready} 项可导出</Tag>
            {summary.draft ? <Tag tone="warn">{summary.draft} 项为草案</Tag> : null}
          </span>
        ) : undefined
      }
    />
  );

  const error = shots.error ?? boards.error ?? plans.error ?? takes.error ?? links.error ?? coverage.error ?? script.error ?? null;
  if (error) {
    return (
      <Workspace header={header}>
        <Panel title="交付清单">
          <div className="flex max-w-[520px] flex-col items-start gap-3">
            <ErrorNotice error={error} />
            <Button
              onClick={() => {
                for (const q of [shots, boards, plans, takes, links, coverage, script]) void q.refetch();
              }}
            >
              重试
            </Button>
          </div>
        </Panel>
      </Workspace>
    );
  }
  if (!items || !summary) {
    return (
      <Centered>
        <Spinner label="正在检查可导出的内容…" />
      </Centered>
    );
  }

  // ---- print views (same components as the boards and plan pages)
  if ((print === 'boards' || print === 'topview') && boards.data && shots.data) {
    return (
      <BoardPrint
        kind={print}
        project={project}
        boards={boards.data}
        shots={shots.data}
        scenes={scenes}
        scriptVersion={scriptVersion}
        sceneId={null}
        onScene={() => undefined}
        onBack={() => setPrint(null)}
        backLabel="返回交付"
      />
    );
  }
  if ((print === 'callsheet' || print === 'slates') && detail && lookup && planData.data) {
    return <PrintPreview mode={print} data={planData.data} detail={detail} lookup={lookup} crew={crewLabel(detail)} onBack={() => setPrint(null)} backLabel="返回交付" />;
  }

  const run = async (id: DeliverItemId, fn: () => Promise<string>) => {
    setBusy(id);
    setFeedback(null);
    try {
      const name = await fn();
      setFeedback({ id, kind: 'saved', text: name });
    } catch (e) {
      setFeedback({ id, kind: 'error', error: e });
    } finally {
      setBusy(null);
    }
  };

  const serverCsv = (id: DeliverItemId) => {
    const kind = CSV_KIND[id]!;
    void run(id, () => downloadExport(exportCsvUrl(kind, { bom, planId }), `${kind}.csv`, dispositionFilename));
  };

  const takeLog = () =>
    void run('take-log', async () => {
      if (!detail || !lookup) throw new Error('还没有拍摄计划');
      const name = exportFileName('场记模板', detail.plan.date);
      saveText(name, takeLogCsv(detail.plan, lookup, bom), 'text/csv;charset=utf-8');
      return name;
    });

  const actionsFor = (item: DeliverItem): ReactNode => {
    const title = DELIVER_ITEM[item.id].title;
    const off = item.state === 'empty' || item.state === 'unavailable';
    const isBusy = busy === item.id;
    const printBtn = (mode: PrintMode) => (
      <Button size="sm" aria-label={`${title}：打印预览`} disabled={off} onClick={() => setPrint(mode)}>
        <Printer aria-hidden className="size-3.5" />
        打印预览
      </Button>
    );
    const csvBtn = (onClick: () => void) => (
      <Button size="sm" aria-label={`下载${title} CSV`} disabled={item.state === 'unavailable'} busy={isBusy} onClick={onClick}>
        <FileSpreadsheet aria-hidden className="size-3.5" />
        下载 CSV
      </Button>
    );
    switch (item.id) {
      case 'boards':
      case 'topview':
        return printBtn(item.id);
      case 'callsheet':
        return (
          <>
            {printBtn('callsheet')}
            {csvBtn(() => serverCsv('callsheet'))}
          </>
        );
      case 'slates':
        return printBtn('slates');
      case 'take-log':
        return csvBtn(takeLog);
      case 'shots-csv':
      case 'takes-media':
      case 'coverage-csv':
        return csvBtn(() => serverCsv(item.id));
      case 'missing':
        return (
          <Button size="sm" aria-label="打印漏拍报告" disabled={off} onClick={() => window.print()}>
            <Printer aria-hidden className="size-3.5" />
            打印
          </Button>
        );
      case 'project-json':
        return (
          <Button
            size="sm"
            variant="primary"
            aria-label="下载项目 JSON"
            busy={isBusy}
            onClick={() => void run('project-json', () => downloadExport(PROJECT_JSON_URL, 'project.json', dispositionFilename))}
          >
            <Braces aria-hidden className="size-3.5" />
            下载 JSON
          </Button>
        );
    }
  };

  return (
    <Workspace
      header={header}
      right={
        <Panel title="导出设置" padded={false}>
          <Inspector>
            <InspectorGroup
              title="拍摄日"
              note={
                planList.length === 0 ? (
                  <p className="text-graphite-300">还没有拍摄计划。</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-graphite-300" htmlFor="deliver-plan">
                      拍摄单、打板卡和场记模板按这个计划导出
                    </label>
                    <SelectInput id="deliver-plan" value={planId ?? ''} onChange={(e) => setChosenPlan(e.target.value || null)}>
                      {planList.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.date} · {p.status === 'approved' ? '已批准' : '草案'}
                        </option>
                      ))}
                    </SelectInput>
                  </div>
                )
              }
            />
            <InspectorGroup
              title="CSV"
              note={
                <CheckRow checked={bom} onChange={setBom} hint={BOM_HINT}>
                  带 BOM（UTF-8）
                </CheckRow>
              }
            />
            <InspectorGroup
              title="AI 生成内容"
              note={
                <div className="flex flex-col gap-2">
                  <CheckRow checked={aiBadge} onChange={setAiBadge} hint={AI_BADGE_COPY.hint}>
                    {AI_BADGE_COPY.label}
                  </CheckRow>
                  <p className="text-xs text-graphite-300">{aiCount > 0 ? AI_BADGE_COPY.some(aiCount) : AI_BADGE_COPY.none}</p>
                  {!aiBadge && aiCount > 0 ? <p className="text-xs text-graphite-100">{AI_BADGE_COPY.off}</p> : null}
                </div>
              }
            />
            <InspectorGroup
              title="不会导出"
              note={
                <div className="flex flex-col gap-2 text-xs text-graphite-300">
                  <p>{PROJECT_JSON_EXCLUDES}</p>
                  <p>{NOT_PROVIDED}</p>
                </div>
              }
            />
          </Inspector>
        </Panel>
      }
    >
      <Panel title="交付清单" padded={false}>
        <div className="print:hidden">
          {DELIVER_GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`deliver-group-${g.id}`} className="border-b border-graphite-800 last:border-b-0">
              <h3 id={`deliver-group-${g.id}`} className="px-3 pt-3 pb-1 text-xs font-medium tracking-wide text-graphite-300">
                {g.title}
              </h3>
              <ul className="divide-y divide-graphite-800">
                {g.items.map((id) => (
                  <ExportRow key={id} item={items[id]} actions={actionsFor(items[id])} feedback={feedback?.id === id ? feedback : null} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <MissingReportPrint project={project.name} coverage={coverage.data ?? []} refs={refs} />
      </Panel>
    </Workspace>
  );
}

function ExportRow({ item, actions, feedback }: { item: DeliverItem; actions: ReactNode; feedback: Feedback | null }) {
  const copy = DELIVER_ITEM[item.id];
  const titleId = `deliver-item-${item.id}`;
  return (
    <li aria-labelledby={titleId} data-deliver-item={item.id} data-state={item.state} className="flex flex-col gap-2 px-3 py-3 md:flex-row md:items-start md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h4 id={titleId} className="mr-0.5 text-sm font-medium text-graphite-100">
            {copy.title}
          </h4>
          {copy.formats.map((f) => (
            <span key={f} className="inline-flex h-5 items-center rounded-control bg-graphite-800 px-1.5 font-mono text-[11px] text-graphite-300">
              {f}
            </span>
          ))}
          <Tag tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Tag>
        </div>
        <p className="mt-1 max-w-[72ch] text-xs leading-relaxed text-graphite-300">{copy.contains}</p>
        <p className="mt-1 max-w-[72ch] text-xs leading-relaxed text-graphite-100">{item.note}</p>
        {item.id === 'project-json' ? <p className="mt-1 max-w-[72ch] text-xs leading-relaxed text-graphite-300">{PROJECT_JSON_EXCLUDES}</p> : null}
        {feedback?.kind === 'saved' ? (
          <p role="status" className="mt-1.5 flex items-center gap-1 text-xs text-graphite-100">
            <Download aria-hidden className="size-3.5 text-ok" />
            已下载：<span className="break-all">{feedback.text}</span>
          </p>
        ) : null}
        {feedback?.kind === 'error' ? <ErrorNotice className="mt-2 max-w-[560px]" error={feedback.error} /> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
    </li>
  );
}

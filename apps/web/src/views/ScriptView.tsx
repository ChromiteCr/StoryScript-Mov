import { useState } from 'react';
import type { Project, ScriptImportResult } from '@storyscript/contracts';
import { ScrollText } from 'lucide-react';
import { useCurrentScript } from '../lib/queries.ts';
import { stageDef } from '../lib/stages.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, Spinner } from '../components/ui.tsx';
import { PageHeader, Panel, Workspace } from '../components/workspace.tsx';
import { ImportView } from './script/ImportView.tsx';
import { ScriptWorkspace } from './script/ScriptWorkspace.tsx';

function importNotice(r: ScriptImportResult): string {
  const base = `已导入「${r.version.source_name}」：${r.scenes.length} 个场景、${r.version.paragraphs.length} 个段落。`;
  const n = r.needs_relink_shot_ids.length;
  return n > 0 ? `${base}${n} 个镜头的引用在新版本里找不到逐字相同的原文，已标为"待重新关联"，不会自动连接。` : base;
}

/** #/script — import when there is no script yet, otherwise the script + shot table workspace. */
export function ScriptView({ project }: { project: Project }) {
  const script = useCurrentScript();
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { label, lead } = stageDef('script');

  if (script.isPending || script.isError) {
    return (
      <Workspace header={<PageHeader title={label} icon={ScrollText} lead={lead} />}>
        <Panel title="剧本">
          {script.isPending ? (
            <Spinner label="正在读取剧本…" />
          ) : (
            <div className="flex max-w-[520px] flex-col items-start gap-3">
              <ErrorNotice error={script.error} />
              <Button onClick={() => void script.refetch()}>重试</Button>
            </div>
          )}
        </Panel>
      </Workspace>
    );
  }

  const current = script.data;
  if (!current || importing) {
    return (
      <ImportView
        base={current}
        onCancel={current ? () => setImporting(false) : undefined}
        onDone={(r) => {
          setNotice(importNotice(r));
          setImporting(false);
        }}
      />
    );
  }

  return (
    <ScriptWorkspace
      key={current.version.id}
      project={project}
      script={current}
      onImportNew={() => setImporting(true)}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

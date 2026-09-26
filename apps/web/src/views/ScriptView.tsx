import { useState } from 'react';
import type { Project, ScriptImportResult } from '@storyscript/contracts';
import { FileText } from 'lucide-react';
import { useCurrentScript } from '../lib/queries.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, Spinner } from '../components/ui.tsx';
import { ImportPanel } from './script/ImportPanel.tsx';
import { Workspace } from './script/Workspace.tsx';

function importNotice(r: ScriptImportResult): string {
  const base = `已导入新版本「${r.version.source_name}」：${r.scenes.length} 个场景、${r.version.paragraphs.length} 个段落。`;
  const n = r.needs_relink_shot_ids.length;
  return n > 0 ? `${base}${n} 个镜头的引用在新版本里找不到逐字相同的原文，已标为"待重新关联"，不会自动连接。` : base;
}

/** #/script — import when there is no script yet, otherwise the script + shot table workspace. */
export function ScriptView({ project }: { project: Project }) {
  const script = useCurrentScript();
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (script.isPending) return <Spinner label="正在读取剧本…" />;
  if (script.isError) {
    return (
      <div className="flex max-w-[520px] flex-col items-start gap-3">
        <ErrorNotice error={script.error} />
        <Button onClick={() => void script.refetch()}>重试</Button>
      </div>
    );
  }

  const current = script.data;
  const done = (r: ScriptImportResult) => {
    setNotice(importNotice(r));
    setImporting(false);
  };

  if (!current || importing) {
    return (
      <div className="flex flex-col gap-4">
        {!current ? (
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <FileText aria-hidden className="size-5 text-ink-2" />
              剧本与镜头
            </h1>
            <p className="mt-1 max-w-[60ch] text-[13px] text-ink-2">
              先导入剧本。按场景标题切场后，每个段落都有锚点，镜头引用原文、可以回到出处。改了剧本就导入新版本，旧版本仍然保留。
            </p>
          </div>
        ) : null}
        <ImportPanel base={current} onCancel={current ? () => setImporting(false) : undefined} onDone={done} />
      </div>
    );
  }

  return <Workspace key={current.version.id} project={project} script={current} onImportNew={() => setImporting(true)} initialNotice={notice} />;
}

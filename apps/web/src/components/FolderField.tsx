import { FolderSearch } from 'lucide-react';
import { useChooseFolder } from '../lib/queries.ts';
import { normalizePastedPath } from '../lib/format.ts';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Button, TextInput } from './ui.tsx';

export interface FolderFieldProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  value: string;
  onChange: (value: string) => void;
  /** called after the native dialog returns a folder */
  onPicked?: (path: string) => void;
  placeholder?: string;
}

/** Path input plus the server-side native folder dialog (POST /platform/choose-folder). */
export function FolderField({ id, describedBy, invalid, value, onChange, onPicked, placeholder }: FolderFieldProps) {
  const choose = useChooseFolder();

  const pick = () => {
    choose.mutate(undefined, {
      onSuccess: (path) => {
        if (path === null) return; // cancelled
        onChange(path);
        onPicked?.(path);
      },
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <TextInput
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const cleaned = normalizePastedPath(e.target.value);
            if (cleaned !== e.target.value) onChange(cleaned);
          }}
          placeholder={placeholder ?? '/Users/you/Films/project'}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="font-mono text-xs"
        />
        <Button onClick={pick} busy={choose.isPending} title="在本机弹出文件夹选择框">
          {choose.isPending ? null : <FolderSearch aria-hidden className="size-3.5" />}
          {choose.isPending ? '等待选择…' : '选择文件夹'}
        </Button>
      </div>
      {choose.isError ? <ErrorNotice error={choose.error} context="choose-folder" /> : null}
    </div>
  );
}

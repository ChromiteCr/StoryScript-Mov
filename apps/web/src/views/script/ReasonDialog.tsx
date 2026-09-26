import { useId, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, TextArea } from '../../components/ui.tsx';
import type { ReasonRequest } from './context.ts';

/** Asks for a required reason (waive / archive / requirement changes), then runs the write. */
export function ReasonDialog({ request, onClose }: { request: ReasonRequest; onClose: () => void }) {
  const [reason, setReason] = useState(request.initial ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const id = useId();
  const empty = reason.trim() === '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (empty) return;
    setBusy(true);
    setError(null);
    try {
      await request.run(reason.trim());
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={request.title} description={request.description} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-[13px] font-medium text-ink">
            {request.label}
          </label>
          <TextArea
            id={id}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder={request.placeholder}
            aria-invalid={(touched && empty) || undefined}
            maxLength={500}
          />
          {touched && empty ? <p className="text-xs text-danger">请填写原因，它会记入修订历史。</p> : <p className="text-xs text-ink-3">原因会记入修订历史。</p>}
        </div>
        {error ? <ErrorNotice error={error} context={request.errorContext ?? 'shot-save'} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={busy} className={request.danger ? 'bg-danger hover:enabled:bg-danger' : ''}>
            {request.confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

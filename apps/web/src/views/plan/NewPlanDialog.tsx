import { useState } from 'react';
import type { Plan } from '@storyscript/contracts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Tag } from '../../components/ui.tsx';
import { useCreatePlan } from '../../lib/queries-plan.ts';
import { Modal, TimeField } from './controls.tsx';

/** New shooting-day plan: local date, crew call and wrap (wrap ≤ call = past midnight). */
export function NewPlanDialog({
  timezone,
  defaultDate,
  onClose,
  onCreated,
}: {
  timezone: string;
  defaultDate: string;
  onClose: () => void;
  onCreated: (plan: Plan) => void;
}) {
  const create = useCreatePlan();
  const [date, setDate] = useState(defaultDate);
  const [call, setCall] = useState('08:00');
  const [wrap, setWrap] = useState('20:00');
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(call) && /^\d{2}:\d{2}$/.test(wrap);
  const submit = () =>
    valid && create.mutate({ date, crew_call: call, crew_wrap: wrap }, { onSuccess: (d) => onCreated(d.plan) });

  return (
    <Modal
      title="新建拍摄日计划"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid} busy={create.isPending} onClick={submit}>
            计算计划
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="拍摄日期" hint={`项目时区 ${timezone}`}>
          {({ id, describedBy }) => (
            <input
              id={id}
              type="date"
              aria-describedby={describedBy}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-7 w-full rounded-control border border-graphite-700 bg-graphite-800 px-2 text-sm text-graphite-100 tabular-nums hover:border-graphite-500"
            />
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-graphite-100">剧组工作时间</span>
          <div className="flex items-center gap-1.5">
            <TimeField label="开工" value={call} onChange={setCall} />
            <span aria-hidden className="text-graphite-300">
              –
            </span>
            <TimeField label="收工" value={wrap} onChange={setWrap} />
            {wrap && call && wrap <= call ? <Tag>次日收工</Tag> : null}
          </div>
          <p className="text-xs text-graphite-300">所有块都必须落在这段时间内。计划只改拍摄顺序，不改叙事顺序。</p>
        </div>
        {create.isError ? <ErrorNotice error={create.error} /> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

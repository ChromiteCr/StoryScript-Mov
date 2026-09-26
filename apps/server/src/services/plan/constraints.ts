import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { IsoTime, type Constraint, type ConstraintInput } from '@storyscript/contracts';
import type { DbPort } from '../../db/port.ts';
import { deleteConstraintRow, getConstraint, insertConstraint } from '../../db/repos/constraint.ts';
import { getSetup } from '../../db/repos/setup.ts';
import { AppError } from '../../http/errors.ts';

/** Schedule constraints (FR-06): before / not_before / not_after / locked_block. */

type Input<S extends z.ZodType> = z.infer<S>;

function checkSetup(db: DbPort, id: string): void {
  if (!getSetup(db, id)) throw new AppError('VALIDATION_ERROR', '约束引用的 setup 不存在', 400, { setup_id: id });
}

function instant(value: string, field: string): string {
  if (!IsoTime.safeParse(value).success) {
    throw new AppError('VALIDATION_ERROR', `${field} 不是 UTC 时间（例如 2026-10-05T01:00:00.000Z）`, 400, { field, value });
  }
  return value;
}

export function createConstraint(db: DbPort, input: Input<typeof ConstraintInput>): Constraint {
  return db.tx(() => {
    const id = randomUUID();
    let c: Constraint;
    switch (input.type) {
      case 'before':
        checkSetup(db, input.a_setup_id);
        checkSetup(db, input.b_setup_id);
        if (input.a_setup_id === input.b_setup_id) throw new AppError('VALIDATION_ERROR', '"先于"约束的两端不能是同一个 setup', 400);
        c = { id, ...input };
        break;
      case 'not_before':
      case 'not_after':
        checkSetup(db, input.setup_id);
        c = { id, type: input.type, setup_id: input.setup_id, at_utc: instant(input.at_utc, 'at_utc'), confirmed: input.confirmed };
        break;
      case 'locked_block': {
        checkSetup(db, input.setup_id);
        const start = instant(input.start_utc, 'start_utc');
        const end = instant(input.end_utc, 'end_utc');
        if (!(Date.parse(start) < Date.parse(end))) throw new AppError('VALIDATION_ERROR', '锁定时段的结束必须晚于开始', 400);
        c = { id, type: 'locked_block', setup_id: input.setup_id, start_utc: start, end_utc: end, confirmed: input.confirmed };
        break;
      }
    }
    insertConstraint(db, c);
    return c;
  });
}

export function deleteConstraint(db: DbPort, id: string): { id: string } {
  return db.tx(() => {
    if (!getConstraint(db, id)) throw new AppError('NOT_FOUND', '约束不存在', 404);
    deleteConstraintRow(db, id);
    return { id };
  });
}

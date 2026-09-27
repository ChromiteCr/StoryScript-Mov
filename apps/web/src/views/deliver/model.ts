import type { BoardView, CoverageResult, PlanDetail, Shot, ShotMediaLink, Take } from '@storyscript/contracts';
import { DELIVER_GROUPS, DRAFT_NOTE, type DeliverItemId, type DeliverState } from '../../lib/labels-deliver.ts';

/**
 * The deliver page's checklist (FR-10), pure: for each export, whether it
 * has content and whether it is a draft, with one sentence of why. The rules
 * mirror what the exports themselves print — a board page is 草案 unless its
 * shots are locked and current; plan exports are 草案 unless the plan is
 * approved and not stale.
 */

export interface DeliverInput {
  /** active (non-archived) shots */
  shots: readonly Pick<Shot, 'id' | 'locked'>[];
  boards: readonly Pick<BoardView, 'shot_id' | 'stale' | 'adopted_raster_id'>[];
  /** the plan being exported, null when there is none */
  plan: Pick<PlanDetail, 'stale'> & { plan: { status: 'draft' | 'approved'; date: string } } | null;
  takes: readonly Pick<Take, 'id'>[];
  links: readonly Pick<ShotMediaLink, 'status'>[];
  coverage: readonly Pick<CoverageResult, 'status' | 'required_status' | 'missing_reason'>[];
}

export interface DeliverItem {
  id: DeliverItemId;
  state: DeliverState;
  note: string;
}

function planState(plan: DeliverInput['plan']): { state: DeliverState; note: string } {
  if (!plan) return { state: 'unavailable', note: DRAFT_NOTE.noPlan };
  if (plan.plan.status !== 'approved') return { state: 'draft', note: DRAFT_NOTE.planDraft };
  if (plan.stale) return { state: 'draft', note: DRAFT_NOTE.planStale };
  return { state: 'ready', note: DRAFT_NOTE.planApproved(plan.plan.date) };
}

export function missingCount(coverage: DeliverInput['coverage']): number {
  return coverage.filter((c) => c.required_status === 'required' && c.missing_reason !== null).length;
}

export function deliverItems(input: DeliverInput): Record<DeliverItemId, DeliverItem> {
  const { shots, boards, takes, links, coverage } = input;
  const boardShots = new Set(boards.map((b) => b.shot_id));
  const unlocked = shots.filter((s) => boardShots.has(s.id) && !s.locked).length;
  const stale = boards.filter((b) => b.stale).length;
  const boardItem = (id: 'boards' | 'topview'): DeliverItem =>
    boards.length === 0
      ? { id, state: 'empty', note: DRAFT_NOTE.noBoards }
      : unlocked || stale
        ? { id, state: 'draft', note: DRAFT_NOTE.boardsDraft(unlocked, stale) }
        : { id, state: 'ready', note: DRAFT_NOTE.boardsFinal };

  const p = planState(input.plan);
  const open = links.filter((l) => l.status !== 'rejected');
  const candidates = open.filter((l) => l.status === 'candidate').length;
  const noShots: Omit<DeliverItem, 'id'> = { state: 'empty', note: DRAFT_NOTE.noShots };
  const cov: Omit<DeliverItem, 'id'> =
    shots.length === 0 ? noShots : { state: 'ready', note: DRAFT_NOTE.coverage(missingCount(coverage), coverage.filter((c) => c.status === 'usable').length) };

  return {
    boards: boardItem('boards'),
    topview: boardItem('topview'),
    callsheet: { id: 'callsheet', ...p },
    slates: { id: 'slates', ...p },
    'take-log': { id: 'take-log', ...p },
    'shots-csv': shots.length === 0 ? { id: 'shots-csv', ...noShots } : { id: 'shots-csv', state: 'ready', note: DRAFT_NOTE.shots(shots.length, shots.filter((s) => !s.locked).length) },
    'takes-media':
      takes.length === 0 && open.length === 0
        ? { id: 'takes-media', state: 'empty', note: DRAFT_NOTE.noTakes }
        : { id: 'takes-media', state: 'ready', note: DRAFT_NOTE.takes(takes.length, open.length, candidates) },
    'coverage-csv': { id: 'coverage-csv', ...cov },
    missing: { id: 'missing', ...cov },
    'project-json': { id: 'project-json', state: 'ready', note: DRAFT_NOTE.projectJson },
  };
}

/** "10 项 · 6 项可导出 · 3 项为草案" style counts for the page header. */
export function deliverSummary(items: Record<DeliverItemId, DeliverItem>): Record<DeliverState, number> {
  const out: Record<DeliverState, number> = { ready: 0, draft: 0, empty: 0, unavailable: 0 };
  for (const g of DELIVER_GROUPS) for (const id of g.items) out[items[id].state]++;
  return out;
}

export function adoptedAiCount(boards: DeliverInput['boards']): number {
  return boards.filter((b) => b.adopted_raster_id !== null).length;
}

/** Name from a Content-Disposition header: filename* (RFC 5987) first, then filename. */
export function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // fall through to the plain name
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1]!.trim() : null;
}

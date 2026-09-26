import type {
  CoverageDecision,
  CoverageFlag,
  CoverageResult,
  MissingReason,
  ProbeNormalized,
  RequiredStatus,
  ShotMediaLink,
  Take,
  Uuid,
} from '@storyscript/contracts';
import { checkSourceRangeShape, validateSourceRange } from '../media/source-range.ts';

/**
 * The single source of truth for coverage status (SPEC §5.9, invariant COV).
 * Never stored: pages, API and CSV export all call this function.
 */

export interface CoverageShot {
  id: Uuid;
  required_status: RequiredStatus;
  content_hash: string;
}

export interface CoverageAsset {
  id: Uuid;
  availability: 'online' | 'offline';
  /** when present, source ranges are also checked against the probed streams */
  probe?: Pick<ProbeNormalized, 'streams'> | null;
}

export interface CoverageInput {
  shot: CoverageShot;
  /** takes; only those whose shot_ids include the shot count (TakeShotLink) */
  takes: readonly Pick<Take, 'id' | 'shot_ids'>[];
  /** links; only those of this shot count, rejected links are ignored */
  links: readonly Pick<ShotMediaLink, 'id' | 'shot_id' | 'media_asset_id' | 'source_range' | 'status'>[];
  assets: readonly CoverageAsset[];
  /** append-only human decisions; replayed in `at` order (ties by id) */
  decisions: readonly CoverageDecision[];
}

export function computeCoverage(input: CoverageInput): CoverageResult {
  const { shot } = input;
  const assets = new Map(input.assets.map((a) => [a.id, a] as const));
  const online = (assetId: Uuid): boolean => assets.get(assetId)?.availability === 'online';

  const takes = input.takes.filter((t) => t.shot_ids.includes(shot.id));
  const links = input.links.filter((l) => l.shot_id === shot.id && l.status !== 'rejected');
  const confirmed = links.filter((l) => l.status === 'confirmed');
  const facts = {
    take_count: takes.length,
    link_count: links.length,
    confirmed_link_count: confirmed.length,
    /** non-rejected links whose file is offline or unknown */
    offline_link_count: links.filter((l) => !online(l.media_asset_id)).length,
  };

  const decision = effectiveDecision(input.decisions, shot.id);
  const stale = decision !== null && decision.basis_content_hash !== shot.content_hash;
  const flags = new Set<CoverageFlag>();
  if (stale) flags.add('decision_stale');

  // selected links of a usable decision that are still confirmed with a valid range
  const rangeOk = (l: CoverageInput['links'][number]): boolean => {
    const probe = assets.get(l.media_asset_id)?.probe;
    return (probe ? validateSourceRange(l.source_range, { probe }) : checkSourceRangeShape(l.source_range)).ok;
  };
  let usable = false;
  if (decision?.decision === 'usable' && !stale) {
    const selected = new Set(decision.selected_link_ids);
    const candidates = confirmed.filter((l) => selected.has(l.id) && rangeOk(l));
    usable = candidates.some((l) => online(l.media_asset_id));
    if (!usable) {
      flags.add('previously_usable');
      if (candidates.some((l) => !online(l.media_asset_id))) flags.add('source_offline');
    }
  }

  let status: CoverageResult['status'];
  if (shot.required_status === 'waived') status = 'waived';
  else if (decision?.decision === 'needs_pickup') status = 'needs_pickup';
  else if (usable) status = 'usable';
  else if (takes.length > 0 || confirmed.length > 0) status = 'attempted';
  else status = 'planned';

  let missing: MissingReason | null = null;
  if (shot.required_status === 'required' && status !== 'usable' && status !== 'waived') {
    if (takes.length === 0) missing = 'no_take';
    else if (links.length === 0) missing = 'no_link';
    else if (confirmed.length > 0 && confirmed.every((l) => !online(l.media_asset_id))) missing = 'file_offline';
    else missing = 'no_confirmed_usable';
  }

  return {
    shot_id: shot.id,
    status,
    required_status: shot.required_status,
    facts,
    flags: FLAG_ORDER.filter((f) => flags.has(f)),
    missing_reason: missing,
  };
}

const FLAG_ORDER: CoverageFlag[] = ['previously_usable', 'source_offline', 'decision_stale'];

/**
 * Replays the shot's decisions oldest → newest: usable/needs_pickup replace
 * the current decision, clear revokes it. Returns the one in force, if any.
 */
export function effectiveDecision(decisions: readonly CoverageDecision[], shotId: Uuid): CoverageDecision | null {
  const mine = decisions
    .filter((d) => d.shot_id === shotId)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || cmp(a.id, b.id));
  let current: CoverageDecision | null = null;
  for (const d of mine) current = d.decision === 'clear' ? null : d;
  return current;
}

/** Coverage for many shots at once (same function per shot — COV). */
export function computeCoverageAll(
  shots: readonly CoverageShot[],
  rest: Omit<CoverageInput, 'shot'>,
): CoverageResult[] {
  return shots.map((shot) => computeCoverage({ ...rest, shot }));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

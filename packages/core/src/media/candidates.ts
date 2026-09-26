import type { LinkCandidate, Take, Uuid } from '@storyscript/contracts';
import { compileSlateFormat, parseSlate } from './slate.ts';

/**
 * Link candidates from file names (SPEC FR-09). Candidates only feed the
 * review queue; nothing here ever confirms a link.
 *   R1  the file name contains a slate code in `codeFormat` → shot whose scene
 *       display number and code are numerically equal, and that shot's take
 *       with the same take number (if logged)
 *   R2  a take's clip_hint equals the file stem (case-insensitive) → every shot of the take
 *   R3  user regex with named groups scene / shot / take, matched like R1
 * An asset is flagged `conflict` when its candidates cannot all be true at
 * once: more than one take, or more than one shot not explained by a single
 * multi-shot take (INV-06 allows one take to cover several shots).
 */

export interface CandidateAsset {
  id: Uuid;
  /** path relative to its source root; only the last segment is used */
  rel_path: string;
}

export interface CandidateShot {
  id: Uuid;
  scene_display_no: string;
  code: string;
}

export interface BuildCandidatesInput {
  assets: readonly CandidateAsset[];
  shots: readonly CandidateShot[];
  takes: readonly Pick<Take, 'id' | 'take_no' | 'clip_hint' | 'shot_ids'>[];
  codeFormat: string;
  userRegex?: string | null;
}

export interface CandidateError {
  code: 'INVALID_FORMAT' | 'INVALID_REGEX';
  message: string;
}

export interface BuildCandidatesResult {
  candidates: LinkCandidate[];
  /** configuration problems (bad slate format or user regex); never thrown */
  errors: CandidateError[];
}

const MAX_USER_REGEX = 500;

/** "003" → 3, " 12 " → 12; anything that is not a plain number → null. */
export function numericValue(text: string): number | null {
  const m = /^\s*(\d{1,9})\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

export function baseName(relPath: string): string {
  const parts = relPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export function fileStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

type Claim = Omit<LinkCandidate, 'conflict'>;

export function buildCandidates(input: BuildCandidatesInput): BuildCandidatesResult {
  const errors: CandidateError[] = [];
  const shotIds = new Set(input.shots.map((s) => s.id));

  const format = compileSlateFormat(input.codeFormat);
  if (!format.ok) errors.push({ code: 'INVALID_FORMAT', message: format.message });

  let userRe: RegExp | null = null;
  if (input.userRegex) {
    const compiled = compileUserRegex(input.userRegex);
    if ('error' in compiled) errors.push({ code: 'INVALID_REGEX', message: compiled.error });
    else userRe = compiled.re;
  }

  const shotsFor = (scene: number | null, shot: number): CandidateShot[] =>
    input.shots.filter(
      (s) => numericValue(s.code) === shot && (scene === null || numericValue(s.scene_display_no) === scene),
    );
  const takesFor = (shotId: Uuid, takeNo: number | null): Uuid[] =>
    takeNo === null ? [] : input.takes.filter((t) => t.take_no === takeNo && t.shot_ids.includes(shotId)).map((t) => t.id);

  const claims: Claim[] = [];
  const claimCode = (assetId: Uuid, evidence: 'R1' | 'R3', code: { scene: number | null; shot: number; take: number | null }, what: string): void => {
    for (const s of shotsFor(code.scene, code.shot)) {
      const takeIds = takesFor(s.id, code.take);
      const takeNote = code.take === null ? '' : takeIds.length === 0 ? `, take ${code.take} not logged` : `, take ${code.take}`;
      const detail = `${evidence}: ${what} → scene ${s.scene_display_no}, shot ${s.code}${takeNote}`;
      if (takeIds.length === 0) claims.push({ shot_id: s.id, media_asset_id: assetId, take_id: null, evidence, detail });
      for (const tid of takeIds) claims.push({ shot_id: s.id, media_asset_id: assetId, take_id: tid, evidence, detail });
    }
  };

  for (const asset of input.assets) {
    const name = baseName(asset.rel_path);
    if (name.startsWith('._') || name === '') continue;
    const stem = fileStem(name);

    if (format.ok) {
      const code = parseSlate(input.codeFormat, name);
      if (code) claimCode(asset.id, 'R1', code, `slate code in "${name}"`);
    }

    const lowerStem = stem.toLowerCase();
    const lowerName = name.toLowerCase();
    for (const t of input.takes) {
      const hint = t.clip_hint?.trim().toLowerCase();
      if (!hint || (hint !== lowerStem && hint !== lowerName)) continue;
      for (const sid of t.shot_ids) {
        if (!shotIds.has(sid)) continue;
        claims.push({
          shot_id: sid,
          media_asset_id: asset.id,
          take_id: t.id,
          evidence: 'R2',
          detail: `R2: clip hint "${t.clip_hint}" of take ${t.take_no} equals "${stem}"`,
        });
      }
    }

    if (userRe) {
      const m = userRe.exec(name);
      const g = m?.groups ?? {};
      const shot = g.shot !== undefined ? numericValue(g.shot) : null;
      if (m && shot !== null) {
        const scene = g.scene !== undefined ? numericValue(g.scene) : null;
        const take = g.take !== undefined ? numericValue(g.take) : null;
        if (g.scene === undefined || scene !== null) claimCode(asset.id, 'R3', { scene, shot, take }, `user pattern matched "${m[0]}"`);
      }
    }
  }

  // de-duplicate, then flag conflicts per asset
  const unique = new Map<string, Claim>();
  for (const c of claims) {
    const key = `${c.media_asset_id}|${c.shot_id}|${c.take_id ?? ''}|${c.evidence}`;
    if (!unique.has(key)) unique.set(key, c);
  }
  const byAsset = new Map<Uuid, Claim[]>();
  for (const c of unique.values()) byAsset.set(c.media_asset_id, [...(byAsset.get(c.media_asset_id) ?? []), c]);
  const takeShots = new Map(input.takes.map((t) => [t.id, new Set(t.shot_ids)] as const));

  const candidates: LinkCandidate[] = [];
  for (const [, list] of byAsset) {
    const conflict = isConflict(list, takeShots);
    for (const c of list) candidates.push({ ...c, conflict });
  }
  candidates.sort(
    (a, b) =>
      cmp(a.media_asset_id, b.media_asset_id) || cmp(a.shot_id, b.shot_id) || cmp(a.evidence, b.evidence) || cmp(a.take_id ?? '', b.take_id ?? ''),
  );
  return { candidates, errors };
}

function isConflict(list: readonly Claim[], takeShots: Map<Uuid, Set<Uuid>>): boolean {
  const takes = new Set(list.map((c) => c.take_id).filter((t): t is Uuid => t !== null));
  if (takes.size > 1) return true;
  const shots = new Set(list.map((c) => c.shot_id));
  if (takes.size === 1) {
    const covered = takeShots.get([...takes][0]!) ?? new Set();
    return [...shots].some((s) => !covered.has(s));
  }
  return shots.size > 1;
}

/** Compiles a user pattern (case-insensitive). Invalid input is reported, never thrown. */
export function compileUserRegex(source: string): { re: RegExp } | { error: string } {
  if (source.length > MAX_USER_REGEX) return { error: `pattern is longer than ${MAX_USER_REGEX} characters` };
  let re: RegExp;
  try {
    re = new RegExp(source, 'i');
  } catch (e) {
    return { error: `invalid regular expression: ${(e as Error).message}` };
  }
  if (!/\(\?<shot>/.test(source)) return { error: 'pattern needs a named group (?<shot>…); (?<scene>…) and (?<take>…) are optional' };
  return { re };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

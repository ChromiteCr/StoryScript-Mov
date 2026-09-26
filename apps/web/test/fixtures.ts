import type { DraftIssue, Shot, ShotDraft, ShotFields } from '@storyscript/contracts';

/** Test fixtures for the M3 web logic. Original data; no real names. */

export const SCENE_ID = '5b0c7a52-3f1e-4c7a-9a55-0d7f3b6e2a10';
export const VERSION_ID = '0e4b1c1d-7c55-4f7a-8f0a-2b6c1e9d3a41';

let n = 0;
export function uuid(): string {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function fields(over: Partial<ShotFields> = {}): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: 50,
    movement: 'static',
    subjects: [{ alias: 'c1', screen: 'L', depth: 'mg', facing: 'screen_right', pose: 'stand' }],
    props: [],
    env: 'interior',
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 4,
    narrative_purpose: '交代店主的日常',
    action: '店主把一本旧书放回书架',
    dialogue_quote: null,
    source: { paragraph_id: 'p-002', quote: '店主整理书架' },
    assumptions: [],
    questions: [],
    ...over,
  };
}

export function shot(over: Partial<Shot> = {}): Shot {
  const t = '2026-09-26T08:00:00.000Z';
  return {
    id: uuid(),
    scene_id: SCENE_ID,
    code: 'S01-001',
    narrative_pos: 1,
    source_anchor: { script_version_id: VERSION_ID, paragraph_id: 'p-002', quote: '店主整理书架', match: 'exact' },
    manual_note: null,
    origin: 'ai',
    fields: fields(),
    locked: false,
    archived: false,
    required_status: 'required',
    requirement_reason: null,
    setup_id: null,
    needs_relink: false,
    content_hash: 'h',
    revision: 1,
    created_at: t,
    updated_at: t,
    ...over,
  };
}

export function issue(level: DraftIssue['level'], item: number | null, code = 'X', message = 'm'): DraftIssue {
  return { level, item, code, message };
}

export function draft(parsed: unknown, issues: DraftIssue[] = [], over: Partial<ShotDraft> = {}): ShotDraft {
  return {
    id: uuid(),
    kind: 'breakdown',
    scope: { scene_id: SCENE_ID },
    model: 'test-model',
    prompt_version: 'breakdown-v1',
    raw_output: null,
    parsed,
    issues,
    attempts: 1,
    usage: null,
    status: 'pending',
    created_at: '2026-09-26T08:00:00.000Z',
    ...over,
  };
}

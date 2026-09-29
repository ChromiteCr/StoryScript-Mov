import { describe, expect, it } from 'vitest';
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, formatProgress, isJobInFlight } from '../src/lib/jobs.ts';
import { parseView, VIEWS } from '../src/lib/route.ts';
import { currentPage, isStage, nextIndex, pageHref, STAGES, stageDef, stageIndex } from '../src/lib/stages.ts';

/** S0a page bar: the workflow order, routing and keyboard movement (pure logic). */

describe('workflow stages', () => {
  it('runs script → boards → plan → set → media → deliver, in that order', () => {
    expect(STAGES.map((s) => s.id)).toEqual(['script', 'boards', 'plan', 'set', 'media', 'deliver']);
    expect(STAGES.map((s) => s.label)).toEqual(['剧本', '分镜', '计划', '现场', '素材', '交付']);
    STAGES.forEach((s, i) => expect(stageIndex(s.id)).toBe(i));
  });

  it('gives every stage a one-line lead without an arrow or a middle dot', () => {
    for (const s of STAGES) {
      expect(s.lead.length).toBeGreaterThan(0);
      expect(s.lead).not.toMatch(/→|·/);
    }
  });

  it('keeps settings out of the flow', () => {
    expect(STAGES.some((s) => (s.id as string) === 'settings')).toBe(false);
    expect(isStage('settings')).toBe(false);
    expect(isStage(null)).toBe(false);
    for (const s of STAGES) expect(isStage(s.id)).toBe(true);
  });

  it('looks up stage definitions and rejects unknown ids', () => {
    expect(stageDef('set').label).toBe('现场');
    expect(() => stageDef('nope' as never)).toThrow();
  });
});

describe('hash routes', () => {
  it('routes every stage, settings and (hosted) projects, including #/set and #/deliver', () => {
    expect(VIEWS).toEqual(['script', 'boards', 'plan', 'set', 'media', 'deliver', 'settings', 'projects']);
    expect(parseView('#/projects')).toBe('projects');
    expect(parseView('#/set')).toBe('set');
    expect(parseView('#/deliver/')).toBe('deliver');
  });

  it('round-trips every page href through the parser', () => {
    for (const id of [...STAGES.map((s) => s.id), 'settings' as const]) {
      expect(pageHref(id)).toBe(`#/${id}`);
      expect(parseView(pageHref(id))).toBe(id);
    }
  });

  it('ignores the session token hash and unknown pages', () => {
    expect(parseView('#t=abc')).toBeNull();
    expect(parseView('#/Set')).toBeNull();
    expect(parseView('#/set/take')).toBeNull();
    expect(parseView('#/export')).toBeNull();
  });
});

describe('current page', () => {
  it('marks nothing on the project manager (no project, bare URL)', () => {
    expect(currentPage(null, false)).toBeNull();
  });

  it('does not mark a stage while no project is open, even via a stage URL', () => {
    for (const s of STAGES) expect(currentPage(s.id, false)).toBeNull();
  });

  it('marks settings whether or not a project is open', () => {
    expect(currentPage('settings', false)).toBe('settings');
    expect(currentPage('settings', true)).toBe('settings');
  });

  it('marks the routed stage with a project open, the first stage for the bare URL', () => {
    expect(currentPage(null, true)).toBe('script');
    for (const s of STAGES) expect(currentPage(s.id, true)).toBe(s.id);
  });
});

describe('arrow-key movement', () => {
  it('moves along a row with left/right and stops at the ends', () => {
    expect(nextIndex(2, 'ArrowRight', 6)).toBe(3);
    expect(nextIndex(2, 'ArrowLeft', 6)).toBe(1);
    expect(nextIndex(5, 'ArrowRight', 6)).toBe(5);
    expect(nextIndex(0, 'ArrowLeft', 6)).toBe(0);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextIndex(3, 'Home', 6)).toBe(0);
    expect(nextIndex(1, 'End', 6)).toBe(5);
  });

  it('uses up/down for a vertical list and leaves the other axis alone', () => {
    expect(nextIndex(0, 'ArrowDown', 3, 'vertical')).toBe(1);
    expect(nextIndex(2, 'ArrowUp', 3, 'vertical')).toBe(1);
    expect(nextIndex(1, 'ArrowRight', 3, 'vertical')).toBeNull();
    expect(nextIndex(1, 'ArrowDown', 6)).toBeNull();
  });

  it('ignores other keys and empty lists, and clamps a stale index', () => {
    expect(nextIndex(1, 'Enter', 6)).toBeNull();
    expect(nextIndex(1, 'Tab', 6)).toBeNull();
    expect(nextIndex(0, 'ArrowRight', 0)).toBeNull();
    expect(nextIndex(9, 'ArrowLeft', 6)).toBe(4);
    expect(nextIndex(-1, 'ArrowRight', 6)).toBe(1);
  });
});

describe('background jobs indicator', () => {
  it('counts queued and running jobs as in flight, nothing else', () => {
    expect(isJobInFlight({ status: 'queued' })).toBe(true);
    expect(isJobInFlight({ status: 'running' })).toBe(true);
    for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown'] as const) {
      expect(isJobInFlight({ status })).toBe(false);
    }
  });

  it('formats progress as a clamped whole percentage', () => {
    expect(formatProgress(null)).toBeNull();
    expect(formatProgress(0)).toBe('0%');
    expect(formatProgress(0.426)).toBe('43%');
    expect(formatProgress(1.2)).toBe('100%');
    expect(formatProgress(-0.1)).toBe('0%');
  });

  it('has a Chinese label for every job kind and status', () => {
    for (const label of [...Object.values(JOB_KIND_LABEL), ...Object.values(JOB_STATUS_LABEL)]) {
      expect(label).toMatch(/[一-鿿]/);
    }
  });
});

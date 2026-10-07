import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabArea, type ActorRef, type CollabChanges, type CollabEvent, type PresenceEntry } from '@storyscript/contracts';
import { ApiClientError } from '../src/lib/api.ts';
import {
  ACTIVITY_MS,
  activityLine,
  clockText,
  collabQueryString,
  createPoller,
  eventLine,
  eventPlace,
  eventSentence,
  FEED_LINES,
  initialOf,
  isFatalPollError,
  lastChangerOf,
  getCollabFeed,
  mergeEvents,
  othersOnline,
  planPoll,
  recordPoll,
  resetCollabFeed,
  subscribeCollabFeed,
  pollBaseMs,
  pollDelayMs,
  presenceTitle,
  unsavedShotText,
  VERB_PHRASE,
  watchersOf,
  watchersText,
  type CollabCursor,
  type PollerDeps,
} from '../src/lib/collab.ts';
import { allRoots, AREA_ROOTS, COLLAB_AREAS, isCoveredKey, rootsOfAreas } from '../src/lib/collab-areas.ts';
import { boardKeys } from '../src/lib/queries-boards.ts';
import { castKeys } from '../src/lib/queries-cast.ts';
import { checkKeys } from '../src/lib/queries-check.ts';
import { pasteKeys } from '../src/lib/queries-paste.ts';
import { deliverKeys } from '../src/lib/queries-deliver.ts';
import { mediaKeys } from '../src/lib/queries-media.ts';
import { planKeys } from '../src/lib/queries-plan.ts';
import { rasterKeys } from '../src/lib/queries-raster.ts';
import { styleKeys } from '../src/lib/queries-style.ts';
import { keys } from '../src/lib/queries.ts';
import { DUR_KEYS, setupCommit, setupForm } from '../src/lib/setup-form.ts';
import { hasConflict, isDirty, rebasedInit, rebasedReduce, type RebasedAction, type RebasedState } from '../src/lib/useRebasedForm.ts';

// S4a web logic: the change feed's polling (what to refetch, how long to wait,
// the loop under fake timers), the area → query map, how events read, and the
// form that keeps typing when a teammate saves the same thing. Names are made up.

const jie: ActorRef = { id: 'a-jie', name: '阿杰', crew_roles: ['导演'], left: false };
const lin: ActorRef = { id: 'a-lin', name: '小林', crew_roles: ['摄影'], left: false };

const event = (seq: number, actor: ActorRef | null, areas: CollabArea[], over: Partial<CollabEvent> = {}): CollabEvent => ({
  seq,
  at: '2026-09-30T02:32:00.000Z',
  actor,
  areas,
  verb: 'changed',
  scene_no: null,
  shot_code: null,
  from_this_tab: false,
  ...over,
});

const presence = (actor: ActorRef, over: Partial<PresenceEntry> = {}): PresenceEntry => ({ actor, page: 'boards', focus_shot_id: null, away: false, you: false, at: '2026-09-30T02:32:00.000Z', ...over });

const answer = (over: Partial<CollabChanges> = {}): CollabChanges => ({
  epoch: 'e1',
  seq: 0,
  area_seq: {},
  events: [],
  reset: false,
  presence: [presence(lin, { you: true })],
  members_rev: 'm1',
  ...over,
});

const cursor = (over: Partial<CollabCursor> = {}): CollabCursor => ({ epoch: 'e1', seq: 5, members_rev: 'm1', ...over });
const rootKeys = (roots: readonly (readonly string[])[]) => roots.map((r) => r.join('/')).sort();

// ------------------------------------------------------------ areas → queries --

describe('area → query roots', () => {
  it('has an entry for every area of the feed, and only those', () => {
    expect([...COLLAB_AREAS].sort()).toEqual([...CollabArea.options].sort());
  });

  it('covers every query key the app uses', () => {
    const cases: [string, readonly unknown[]][] = [];
    const add = (name: string, k: unknown) => cases.push([name, (typeof k === 'function' ? (k as (...a: string[]) => unknown[])('x', 'y', 'z') : k) as unknown[]]);
    const sources: Record<string, Record<string, unknown>> = { keys, planKeys, boardKeys, mediaKeys, deliverKeys, styleKeys, castKeys, rasterKeys, checkKeys, pasteKeys };
    for (const [group, obj] of Object.entries(sources)) {
      for (const [name, k] of Object.entries(obj)) {
        if (name === 'all' || name === 'plan') continue; // whole-page prefixes, not queries
        add(`${group}.${name}`, k);
      }
    }
    // roots used inline by components
    cases.push(['me', ['me']], ['boards rasters', ['boards', 'rasters']], ['search', mediaKeys.search('q', 'all')]);
    const uncovered = cases.filter(([, k]) => !isCoveredKey(k)).map(([n, k]) => `${n} ${JSON.stringify(k)}`);
    expect(uncovered).toEqual([]);
    expect(cases.length).toBeGreaterThan(40);
  });

  it('does not cover what has nothing to do with the project', () => {
    expect(isCoveredKey(['nothing-here'])).toBe(false);
    expect(isCoveredKey([])).toBe(false);
  });

  it('gives each root once, in area order', () => {
    const roots = rootsOfAreas(['project', 'settings', 'shots']);
    expect(rootKeys(roots).filter((r) => r === 'health')).toHaveLength(1); // project and settings both list it
    expect(rootKeys(rootsOfAreas(['shots']))).toEqual(rootKeys(AREA_ROOTS.shots));
    expect(rootsOfAreas([])).toEqual([]);
  });

  it('everything is the union of all areas', () => {
    const all = rootKeys(allRoots());
    for (const area of COLLAB_AREAS) for (const root of AREA_ROOTS[area]) expect(all).toContain(root.join('/'));
  });
});

// ----------------------------------------------------------------- one answer --

describe('planPoll: what an answer means', () => {
  it('the first answer adopts the state and refetches nothing (the server calls an unknown epoch a reset)', () => {
    const out = planPoll(null, answer({ seq: 7, reset: true, events: [] }), null);
    expect(out).toMatchObject({ first: true, reset: false, roots: [], refreshMe: false, fresh: [] });
    expect(out.cursor).toEqual({ epoch: 'e1', seq: 7, members_rev: 'm1' });
  });

  it('a teammate write refetches the roots of its areas, once each', () => {
    const res = answer({ seq: 8, events: [event(6, jie, ['shots', 'boards']), event(7, jie, ['shots']), event(8, jie, ['plan'])] });
    const out = planPoll(cursor(), res, lin.id);
    expect(rootKeys(out.roots)).toEqual(rootKeys(rootsOfAreas(['shots', 'boards', 'plan'])));
    expect(out.fresh.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(out.cursor.seq).toBe(8);
    expect(out.reset).toBe(false);
  });

  it('this tab’s own writes are not refetched; nobody’s own writes show as news', () => {
    const res = answer({ seq: 7, events: [event(6, lin, ['shots'], { from_this_tab: true }), event(7, lin, ['plan'], { from_this_tab: true })] });
    const out = planPoll(cursor(), res, null); // the member's id comes from presence `you`
    expect(out.roots).toEqual([]);
    expect(out.fresh).toEqual([]);
    expect(out.myId).toBe(lin.id);
    expect(out.cursor.seq).toBe(7);
  });

  it('the same member’s write from another tab is refetched here (but is not news)', () => {
    const out = planPoll(cursor(), answer({ seq: 6, events: [event(6, lin, ['shots'])] }), lin.id);
    expect(rootKeys(out.roots)).toEqual(rootKeys(rootsOfAreas(['shots'])));
    expect(out.fresh).toEqual([]);
  });

  it('a finished job is refetched even when the member started it', () => {
    const res = answer({ seq: 6, events: [event(6, lin, ['drafts', 'jobs'], { verb: 'finished' })] });
    const out = planPoll(cursor(), res, lin.id);
    expect(rootKeys(out.roots)).toEqual(rootKeys(rootsOfAreas(['drafts', 'jobs'])));
    expect(out.fresh).toEqual([]); // refetched, but it is the member's own job: not news
    const theirs = planPoll(cursor(), answer({ seq: 6, events: [event(6, jie, ['drafts', 'jobs'], { verb: 'finished' })] }), lin.id);
    expect(theirs.fresh).toHaveLength(1);
  });

  it('an event without an actor (a job that outlived its requester, or the local app) refetches but is nobody', () => {
    const out = planPoll(cursor(), answer({ seq: 6, events: [event(6, null, ['takes'])] }), lin.id);
    expect(rootKeys(out.roots)).toEqual(rootKeys(rootsOfAreas(['takes'])));
    expect(out.fresh).toEqual([]);
  });

  it('a reset, or another epoch, refetches everything', () => {
    const viaReset = planPoll(cursor(), answer({ seq: 2, reset: true }), null);
    expect(viaReset).toMatchObject({ reset: true, refreshMe: true, fresh: [] });
    expect(rootKeys(viaReset.roots)).toEqual(rootKeys(allRoots()));
    expect(viaReset.cursor).toEqual({ epoch: 'e1', seq: 2, members_rev: 'm1' });

    const restarted = planPoll(cursor(), answer({ epoch: 'e2', seq: 0 }), null);
    expect(restarted.reset).toBe(true);
    expect(restarted.cursor.epoch).toBe('e2');
    expect(restarted.cursor.seq).toBe(0);
  });

  it('a new roster refreshes the account, and only then', () => {
    expect(planPoll(cursor(), answer({ members_rev: 'm2' }), null).refreshMe).toBe(true);
    expect(planPoll(cursor(), answer({ members_rev: 'm1' }), null).refreshMe).toBe(false);
  });

  it('nothing new: nothing to do, the cursor stays', () => {
    const out = planPoll(cursor(), answer({ seq: 5 }), null);
    expect(out).toMatchObject({ first: false, reset: false, roots: [], fresh: [], refreshMe: false });
    expect(out.cursor).toEqual(cursor());
  });

  it('ignores events at or before the cursor', () => {
    const out = planPoll(cursor(), answer({ seq: 6, events: [event(5, jie, ['plan']), event(6, jie, ['styles'])] }), null);
    expect(rootKeys(out.roots)).toEqual(rootKeys(rootsOfAreas(['styles'])));
  });
});

// -------------------------------------------------------------------- cadence --

describe('polling interval', () => {
  it('4 s while visible and active, 10 s when idle over a minute, 30 s in the background', () => {
    expect(pollBaseMs({ hidden: false, idleMs: 0 })).toBe(4_000);
    expect(pollBaseMs({ hidden: false, idleMs: 60_000 })).toBe(4_000);
    expect(pollBaseMs({ hidden: false, idleMs: 60_001 })).toBe(10_000);
    expect(pollBaseMs({ hidden: true, idleMs: 0 })).toBe(30_000);
    expect(pollBaseMs({ hidden: true, idleMs: 999_999 })).toBe(30_000);
  });

  it('jitters by at most 20 % either way', () => {
    expect(pollDelayMs({ hidden: false, idleMs: 0, random: 0.5 })).toBe(4_000);
    expect(pollDelayMs({ hidden: false, idleMs: 0, random: 0 })).toBe(3_200);
    expect(pollDelayMs({ hidden: false, idleMs: 0, random: 0.999999 })).toBeLessThanOrEqual(4_800);
    expect(pollDelayMs({ hidden: true, idleMs: 0, random: 0 })).toBe(24_000);
    for (let i = 0; i <= 100; i++) {
      const ms = pollDelayMs({ hidden: false, idleMs: 100_000, random: i / 100 });
      expect(ms).toBeGreaterThanOrEqual(8_000);
      expect(ms).toBeLessThanOrEqual(12_000);
    }
  });
});

describe('the polling loop (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  interface Harness {
    poller: ReturnType<typeof createPoller>;
    calls: { since: number; epoch: string }[];
    applied: ReturnType<typeof planPoll>[];
    fatal: unknown[];
    state: { hidden: boolean; page: 'script' | 'boards'; focus: string | null };
    next: { res: () => CollabChanges | Promise<CollabChanges> };
  }

  function harness(over: Partial<PollerDeps> = {}): Harness {
    const h: Harness = {
      poller: undefined as never,
      calls: [],
      applied: [],
      fatal: [],
      state: { hidden: false, page: 'script', focus: null },
      next: { res: () => answer() },
    };
    h.poller = createPoller({
      fetch: async (q) => {
        h.calls.push(q);
        return h.next.res();
      },
      context: () => ({ ...h.state }),
      apply: (outcome) => h.applied.push(outcome),
      onFatal: (e) => h.fatal.push(e),
      now: () => Date.now(),
      random: () => 0.5, // no jitter
      ...over,
    });
    return h;
  }

  it('polls at once, then every 4 s while the tab is visible and active', async () => {
    const h = harness();
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({ since: 0, epoch: '' });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls).toHaveLength(3);
    h.poller.stop();
  });

  it('asks from where it left off, and adopts the first answer without invalidating', async () => {
    const h = harness();
    h.next.res = () => answer({ seq: 3, reset: true });
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied[0]).toMatchObject({ first: true, roots: [] });
    h.next.res = () => answer({ seq: 4, events: [event(4, jie, ['shots'])] });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls[1]).toEqual({ since: 3, epoch: 'e1' });
    expect(rootKeys(h.applied[1]!.roots)).toEqual(rootKeys(rootsOfAreas(['shots'])));
    h.poller.stop();
  });

  it('slows to 10 s once nothing has been touched for a minute, and back to 4 s on activity', async () => {
    const h = harness();
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // 4 s polls until the minute is up
    await vi.advanceTimersByTimeAsync(60_000);
    const before = h.calls.length;
    expect(before).toBeGreaterThanOrEqual(15);
    await vi.advanceTimersByTimeAsync(4_000); // the poll that was already due
    const idleStart = h.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.length - idleStart).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.length - idleStart).toBe(2);
    h.poller.noteActivity();
    await vi.advanceTimersByTimeAsync(10_000); // the wait already scheduled is a 10 s one; the one after it is 4 s
    const afterActivity = h.calls.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls.length - afterActivity).toBe(1);
    h.poller.stop();
  });

  it('polls every 30 s in the background, and at once when the tab comes back', async () => {
    const h = harness();
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.state.hidden = true;
    await vi.advanceTimersByTimeAsync(4_000); // the poll that was scheduled while visible
    const n = h.calls.length;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.calls.length).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.length).toBe(n + 1);
    h.state.hidden = false;
    h.poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.length).toBe(n + 2);
    h.poller.stop();
  });

  it('a request is never sent while another is out', async () => {
    let release: (r: CollabChanges) => void = () => undefined;
    const h = harness();
    h.next.res = () => new Promise<CollabChanges>((r) => (release = r));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.poller.wake();
    h.poller.wake();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toHaveLength(1);
    release(answer());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls).toHaveLength(2);
    h.poller.stop();
  });

  it('a request that never answers is given up after 15 s and the loop goes on', async () => {
    const signals: AbortSignal[] = [];
    const h = harness({
      fetch: (_q, signal) => {
        signals.push(signal);
        return new Promise<CollabChanges>((_ok, fail) => signal.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      },
    });
    h.poller.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(h.fatal).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000); // a failed request waits at least 10 s
    expect(signals).toHaveLength(2);
    h.poller.stop();
  });

  it('a failed request waits at least 10 s and polling goes on', async () => {
    const h = harness();
    let fail = true;
    h.next.res = () => {
      if (fail) throw new ApiClientError({ code: 'NETWORK_ERROR', message: 'x', status: 0, retryable: true });
      return answer();
    };
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.calls).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    expect(h.fatal).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls).toHaveLength(3);
    h.poller.stop();
  });

  it('stops for good on an expired session, a lost group, or a server without the feed', async () => {
    for (const [code, status] of [['UNAUTHORIZED', 401], ['NO_TEAM', 403], ['NOT_FOUND', 404]] as const) {
      const h = harness();
      h.next.res = () => {
        throw new ApiClientError({ code, message: 'x', status, retryable: false });
      };
      h.poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fatal).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.calls).toHaveLength(1);
    }
  });

  it('stop cancels the timer, and a request that was cancelled cannot revive the loop after a restart', async () => {
    let release: (r: CollabChanges) => void = () => undefined;
    const h = harness();
    h.next.res = () => new Promise<CollabChanges>((r) => (release = r));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const stale = release;
    h.poller.stop(); // StrictMode: the effect runs, is cleaned up, runs again
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(2);
    stale(answer({ seq: 9 })); // the first request answers late
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toHaveLength(0); // its answer is dropped
    release(answer({ seq: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.applied).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls).toHaveLength(3); // one loop, not two
    h.poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(3);
  });

  it('starts over from an unknown epoch: everything is refetched once', async () => {
    const h = harness();
    h.next.res = () => answer({ seq: 4, epoch: 'e1' });
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.next.res = () => answer({ seq: 0, epoch: 'e2', reset: true });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.applied[1]).toMatchObject({ reset: true });
    expect(rootKeys(h.applied[1]!.roots)).toEqual(rootKeys(allRoots()));
    h.next.res = () => answer({ seq: 0, epoch: 'e2' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.calls[2]).toEqual({ since: 0, epoch: 'e2' });
    expect(h.applied[2]).toMatchObject({ reset: false, roots: [] });
    h.poller.stop();
  });
});

describe('what ends polling, and the query string', () => {
  it('only session, group and missing-feed errors are fatal', () => {
    const err = (code: ApiClientError['code'], status: number) => new ApiClientError({ code, message: 'x', status, retryable: false });
    expect(isFatalPollError(err('UNAUTHORIZED', 401))).toBe(true);
    expect(isFatalPollError(err('NO_TEAM', 403))).toBe(true);
    expect(isFatalPollError(err('NOT_FOUND', 404))).toBe(true);
    expect(isFatalPollError(err('NETWORK_ERROR', 0))).toBe(false);
    expect(isFatalPollError(err('INTERNAL', 500))).toBe(false);
    expect(isFatalPollError(new Error('x'))).toBe(false);
  });

  it('carries since, epoch, tab, page and visibility, and the focus only when there is one', () => {
    const base = { since: 5, epoch: 'e1', tab: 't-1', page: 'boards', focus: null, hidden: false } as const;
    expect(new URLSearchParams(collabQueryString(base)).get('hidden')).toBe('0');
    expect(collabQueryString(base)).not.toContain('focus');
    const q = new URLSearchParams(collabQueryString({ ...base, focus: 'f3c1', hidden: true }));
    expect(Object.fromEntries(q)).toEqual({ since: '5', epoch: 'e1', tab: 't-1', page: 'boards', hidden: '1', focus: 'f3c1' });
  });
});

// -------------------------------------------------------------------- wording --

describe('how events and presence read', () => {
  it('names the place: scene and shot, scene only, or none', () => {
    expect(eventPlace({ scene_no: '3', shot_code: '002' })).toBe('第 3 场 002');
    expect(eventPlace({ scene_no: '3', shot_code: null })).toBe('第 3 场');
    expect(eventPlace({ scene_no: null, shot_code: '002' })).toBe('002');
    expect(eventPlace({ scene_no: null, shot_code: null })).toBe('');
  });

  it('has a phrase for every verb', () => {
    expect(VERB_PHRASE).toEqual({
      changed: '改了',
      created: '新建了',
      archived: '归档了',
      imported: '导入了剧本',
      applied: '应用了草案',
      approved: '批准了计划',
      logged: '记了一条场记',
      saved: '保存了分镜',
      finished: '完成了任务',
      commented: '写了批注',
    });
  });

  it('writes 「阿杰（导演）改了 第 3 场 002 · 10:32」', () => {
    const e = event(1, jie, ['shots'], { scene_no: '3', shot_code: '002' });
    expect(eventSentence(e)).toBe('阿杰（导演）改了 第 3 场 002');
    expect(eventLine(e)).toBe(`阿杰（导演）改了 第 3 场 002 · ${clockText(e.at)}`);
    expect(clockText(e.at)).toMatch(/^\d{2}:\d{2}$/);
    expect(eventSentence(event(2, jie, ['script'], { verb: 'imported' }))).toBe('阿杰（导演）导入了剧本');
    expect(eventSentence(event(3, { ...lin, crew_roles: [] }, ['takes'], { verb: 'logged', scene_no: '1', shot_code: '004' }))).toBe('小林记了一条场记 第 1 场 004');
  });

  it('says so when nobody asked for the job', () => {
    expect(eventSentence(event(1, null, ['jobs'], { verb: 'finished' }))).toBe('有任务完成了');
    expect(eventSentence(event(1, null, ['plan']))).toBe('有内容改了');
  });

  it('the activity line is short: the name only', () => {
    expect(activityLine(event(1, jie, ['shots'], { scene_no: '3', shot_code: '002' }))).toBe('阿杰刚改了 第 3 场 002');
    expect(activityLine(event(1, jie, ['plan'], { verb: 'approved' }))).toBe('阿杰刚批准了计划');
    expect(ACTIVITY_MS).toBe(8_000);
  });

  it('presence tooltip: 「小林（摄影）· 分镜页」, dimmed ones say they are away', () => {
    expect(presenceTitle(presence(lin))).toBe('小林（摄影）· 分镜页');
    expect(presenceTitle(presence(lin, { away: true, page: 'set' }))).toBe('小林（摄影）· 现场页（离开）');
    expect(initialOf('小林')).toBe('小');
    expect(initialOf('  Ann')).toBe('A');
    expect(initialOf('')).toBe('?');
  });

  it('leaves oneself out of the avatars and finds who has a shot open', () => {
    const me = presence(lin, { you: true });
    const a = presence(jie, { focus_shot_id: 'shot-1' });
    const b = presence({ id: 'a-zhou', name: '小周', crew_roles: [], left: false }, { focus_shot_id: 'shot-2' });
    expect(othersOnline([me, a, b])).toEqual([a, b]);
    expect(watchersOf('shot-1', [me, a, b])).toEqual([a]);
    expect(watchersOf('shot-1', [{ ...me, focus_shot_id: 'shot-1' }])).toEqual([]); // not oneself
    expect(watchersOf(null, [a])).toEqual([]);
    expect(watchersText([a])).toBe('阿杰也在看这个镜头');
    expect(watchersText([a, b])).toBe('阿杰、小周也在看这个镜头');
    expect(watchersText([])).toBeNull();
    const four = ['甲', '乙', '丙', '丁'].map((name) => presence({ id: name, name, crew_roles: [], left: false }));
    expect(watchersText(four)).toBe('甲、乙、丙等 4 人也在看这个镜头');
  });

  it('keeps the newest twenty events, once each', () => {
    const many = Array.from({ length: 30 }, (_, i) => event(i + 1, jie, ['shots']));
    const merged = mergeEvents([], many);
    expect(merged).toHaveLength(FEED_LINES);
    expect(merged[0]!.seq).toBe(30);
    expect(merged.at(-1)!.seq).toBe(11);
    const again = mergeEvents(merged, [event(30, jie, ['shots']), event(31, lin, ['plan'])]);
    expect(again.map((e) => e.seq).slice(0, 2)).toEqual([31, 30]);
    expect(again.filter((e) => e.seq === 30)).toHaveLength(1);
  });

  it('who last changed an area, never oneself', () => {
    const list = [event(9, lin, ['plan']), event(8, jie, ['shots']), event(7, jie, ['plan'])];
    expect(lastChangerOf(list, ['plan'], lin.id)?.name).toBe('阿杰');
    expect(lastChangerOf(list, ['plan'], null)?.name).toBe('小林');
    expect(lastChangerOf(list, ['styles'], null)).toBeNull();
    expect(lastChangerOf([event(1, null, ['plan'])], ['plan'], null)).toBeNull();
  });

  it('the feed store: a poll with nothing new changes nothing and tells nobody', () => {
    resetCollabFeed();
    let told = 0;
    const off = subscribeCollabFeed(() => told++);
    const you = presence(lin, { you: true, at: '2026-09-30T02:32:00.000Z' });
    const them = presence(jie, { page: 'plan' });
    recordPoll({ presence: [you, them] }, { fresh: [], myId: lin.id, reset: false }, 1_000);
    expect(told).toBe(1);
    const first = getCollabFeed();
    expect(first.myId).toBe(lin.id);
    // the same people on the same pages, a later heartbeat: the same state
    recordPoll({ presence: [{ ...you, at: '2026-09-30T02:32:04.000Z' }, { ...them, at: '2026-09-30T02:32:04.000Z' }] }, { fresh: [], myId: lin.id, reset: false }, 5_000);
    expect(told).toBe(1);
    expect(getCollabFeed()).toBe(first);
    // someone moves to another page: news
    recordPoll({ presence: [you, { ...them, page: 'boards' }] }, { fresh: [], myId: lin.id, reset: false }, 9_000);
    expect(told).toBe(2);
    expect(getCollabFeed().presence[1]!.page).toBe('boards');
    // an event of a teammate: it is the latest, for eight seconds from `shownAt`
    const e = event(3, jie, ['shots'], { scene_no: '3', shot_code: '002' });
    recordPoll({ presence: [you, { ...them, page: 'boards' }] }, { fresh: [e], myId: lin.id, reset: false }, 12_000);
    expect(told).toBe(3);
    expect(getCollabFeed().latest).toEqual({ event: e, shownAt: 12_000 });
    expect(getCollabFeed().events.map((x) => x.seq)).toEqual([3]);
    // a reset forgets the list
    recordPoll({ presence: [you] }, { fresh: [], myId: lin.id, reset: true }, 15_000);
    expect(getCollabFeed().events).toEqual([]);
    off();
    resetCollabFeed();
  });

  it('the copy of an archived shot’s unsaved text keeps only what was typed', () => {
    expect(unsavedShotText({ action: ' 店主抬头 ', notes: '倒退跟拍', dialogue: '', narrative: '' })).toBe('动作：店主抬头\n拍法说明：倒退跟拍');
    expect(unsavedShotText({ action: '', notes: '', dialogue: '「你好」', narrative: '交代关系' })).toBe('台词：「你好」\n叙事作用：交代关系');
    expect(unsavedShotText({ action: '', notes: '', dialogue: '', narrative: '' })).toBe('');
  });
});

// ---------------------------------------------------------------- rebased form --

interface Form {
  label: string;
  minutes: string;
}
const F = (label: string, minutes = '10'): Form => ({ label, minutes });
const run = (s: RebasedState<Form>, ...actions: RebasedAction<Form>[]) => actions.reduce((acc, a) => rebasedReduce(acc, a), s);
const server = (value: Form, revision: number | undefined): RebasedAction<Form> => ({ type: 'server', value, revision });
const edit = (draft: Form): RebasedAction<Form> => ({ type: 'edit', draft });

describe('useRebasedForm: what happens when the server value moves', () => {
  it('seeds once and is clean', () => {
    const s = rebasedInit(F('主厅'), 3);
    expect(s).toEqual({ draft: F('主厅'), seed: F('主厅'), base: 3, latest: F('主厅'), latestRevision: 3 });
    expect(isDirty(s)).toBe(false);
    expect(hasConflict(s)).toBe(false);
  });

  it('a clean form follows the server silently', () => {
    const s = run(rebasedInit(F('主厅'), 3), server(F('大厅'), 4));
    expect(s.draft).toEqual(F('大厅'));
    expect(s.base).toBe(4);
    expect(isDirty(s)).toBe(false);
    expect(hasConflict(s)).toBe(false);
  });

  it('typing is kept when the server value changes: a conflict, with the old base still in force', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4));
    expect(s.draft).toEqual(F('主厅二楼'));
    expect(s.base).toBe(3); // saving now would be refused
    expect(isDirty(s)).toBe(true);
    expect(hasConflict(s)).toBe(true);
    expect(s.latest).toEqual(F('大厅'));
  });

  it('用他的: the draft becomes the server’s value and the base its revision', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4), { type: 'theirs' });
    expect(s).toEqual({ draft: F('大厅'), seed: F('大厅'), base: 4, latest: F('大厅'), latestRevision: 4 });
    expect(hasConflict(s)).toBe(false);
    expect(isDirty(s)).toBe(false);
  });

  it('保留我的: the draft stays and the base moves to the server’s revision, so a save wins on purpose', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4), { type: 'mine' });
    expect(s.draft).toEqual(F('主厅二楼'));
    expect(s.base).toBe(4);
    expect(hasConflict(s)).toBe(false);
    expect(isDirty(s)).toBe(true); // still to be saved
  });

  it('keeping mine when it now equals theirs leaves nothing to save', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('大厅')), server(F('大厅'), 4));
    expect(isDirty(s)).toBe(false); // the same words: no conflict, nothing to save
    expect(s.base).toBe(4);
  });

  it('a change to something the form does not hold only moves the base', () => {
    // the form holds the label and minutes; the teammate ticked a box elsewhere: same form value, new revision
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('主厅'), 4));
    expect(s.draft).toEqual(F('主厅二楼'));
    expect(s.base).toBe(4);
    expect(hasConflict(s)).toBe(false);
    expect(isDirty(s)).toBe(true);
  });

  it('the same answer again changes nothing (no render loop)', () => {
    const s0 = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4));
    expect(rebasedReduce(s0, server(F('大厅'), 4))).toBe(s0);
    const clean = rebasedInit(F('主厅'), 3);
    expect(rebasedReduce(clean, server(F('主厅'), 3))).toBe(clean);
  });

  it('a further change of the teammate during a conflict updates only what theirs is', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4), server(F('大堂'), 5));
    expect(s.latest).toEqual(F('大堂'));
    expect(s.latestRevision).toBe(5);
    expect(s.draft).toEqual(F('主厅二楼'));
    expect(s.base).toBe(3);
    expect(hasConflict(s)).toBe(true);
  });

  it('the teammate changing it back ends the conflict', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4), server(F('主厅'), 5));
    expect(hasConflict(s)).toBe(false);
    expect(s.base).toBe(5);
    expect(s.draft).toEqual(F('主厅二楼'));
  });

  it('the person’s own save: acknowledged with what the server returned, so the next save names the new revision', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), { type: 'acknowledge', value: F('主厅二楼'), revision: 4 });
    expect(isDirty(s)).toBe(false);
    expect(s.base).toBe(4);
    expect(s.seed).toEqual(F('主厅二楼'));
    // the refetch that follows brings the same value: nothing happens
    expect(rebasedReduce(s, server(F('主厅二楼'), 4))).toBe(s);
  });

  it('the person’s own save, before the refetch: typing that went on meanwhile stays dirty', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), { type: 'acknowledge', value: F('主厅二楼'), revision: 4 }, edit(F('主厅二楼', '20')));
    expect(isDirty(s)).toBe(true);
    expect(s.base).toBe(4);
    expect(hasConflict(s)).toBe(false);
  });

  it('a save does not swallow a conflict that is still open', () => {
    // a teammate saved the label; the person then saved a checkbox elsewhere on the same item
    const s = run(rebasedInit(F('主厅'), 3), edit(F('主厅二楼')), server(F('大厅'), 4), { type: 'acknowledge', value: F('大厅'), revision: 5 });
    expect(hasConflict(s)).toBe(true);
    expect(s.base).toBe(3);
    expect(s.draft).toEqual(F('主厅二楼'));
    expect(s.latestRevision).toBe(5);
  });

  it('a late acknowledgement does not move theirs backwards', () => {
    const s = run(rebasedInit(F('主厅'), 3), server(F('大厅'), 6), { type: 'acknowledge', value: F('主厅'), revision: 4 });
    expect(s.latest).toEqual(F('大厅'));
    expect(s.latestRevision).toBe(6);
  });

  it('works without revisions (the server sends none): values decide', () => {
    const s = run(rebasedInit(F('主厅'), undefined), edit(F('主厅二楼')), server(F('大厅'), undefined));
    expect(hasConflict(s)).toBe(true);
    expect(s.base).toBeUndefined();
    const t = run(rebasedInit(F('主厅'), undefined), server(F('大厅'), undefined));
    expect(t.draft).toEqual(F('大厅'));
  });

  it('reset throws the edits away', () => {
    const s = run(rebasedInit(F('主厅'), 3), edit(F('x')), { type: 'reset', value: F('大厅'), revision: 9 });
    expect(s).toEqual(rebasedInit(F('大厅'), 9));
  });

  it('compares by value, not by key order', () => {
    const a = rebasedInit({ b: 1, a: 2 }, 1);
    const same = rebasedReduce(a, { type: 'server', value: { a: 2, b: 1 }, revision: 1 });
    expect(same).toBe(a);
  });
});

// ----------------------------------------------------------------- setup form --

describe('setup form: the name and the durations', () => {
  const setup = { label: '书店主厅', durations: { setup_min: 15, per_shot_min: 5, reset_min: 10 } };

  it('shows the durations as typed strings', () => {
    expect(setupForm(setup)).toEqual({ label: '书店主厅', setup_min: '15', per_shot_min: '5', reset_min: '10' });
    expect(DUR_KEYS).toEqual(['setup_min', 'per_shot_min', 'reset_min']);
  });

  it('nothing changed: nothing is sent', () => {
    const f = setupForm(setup);
    expect(setupCommit(f, f)).toEqual({ input: null, draft: f });
    expect(setupCommit(f, { ...f, label: '  书店主厅  ' })).toEqual({ input: null, draft: f });
  });

  it('a new name is sent trimmed', () => {
    const f = setupForm(setup);
    expect(setupCommit(f, { ...f, label: '  二楼书架  ' })).toEqual({ input: { label: '二楼书架' }, draft: { ...f, label: '二楼书架' } });
  });

  it('an empty name goes back to the old one', () => {
    const f = setupForm(setup);
    expect(setupCommit(f, { ...f, label: '   ' })).toEqual({ input: null, draft: f });
  });

  it('changed durations are sent together', () => {
    const f = setupForm(setup);
    const out = setupCommit(f, { ...f, per_shot_min: '7.5', reset_min: '010' });
    expect(out.input).toEqual({ durations: { setup_min: 15, per_shot_min: 7.5, reset_min: 10 } });
    expect(out.draft).toEqual({ ...f, per_shot_min: '7.5', reset_min: '10' });
  });

  it('an invalid duration goes back and nothing about durations is sent', () => {
    const f = setupForm(setup);
    for (const bad of ['', ' ', 'abc', '-1', 'NaN']) {
      const out = setupCommit(f, { ...f, per_shot_min: bad, setup_min: '20' });
      expect(out.input).toBeNull();
      expect(out.draft.per_shot_min).toBe('5');
    }
  });

  it('a name and durations together', () => {
    const f = setupForm(setup);
    expect(setupCommit(f, { ...f, label: '走廊', setup_min: '30' }).input).toEqual({ label: '走廊', durations: { setup_min: 30, per_shot_min: 5, reset_min: 10 } });
  });
});

describe('review fixes', () => {
  it('保留我的 keeps only the fields the person changed; the rest follow the teammate', async () => {
    const { rebaseOntoLatest, rebasedInit, rebasedReduce } = await import('../src/lib/useRebasedForm.ts');
    const seed = { label: '天台', setup_min: 10, per_shot_min: 5 };
    const draft = { label: '天台 · 仰拍', setup_min: 10, per_shot_min: 5 };
    const latest = { label: '天台', setup_min: 20, per_shot_min: 5 };
    expect(rebaseOntoLatest(draft, seed, latest)).toEqual({ label: '天台 · 仰拍', setup_min: 20, per_shot_min: 5 });
    let s = rebasedInit(seed, 0);
    s = rebasedReduce(s, { type: 'edit', draft });
    s = rebasedReduce(s, { type: 'server', value: latest, revision: 1 });
    s = rebasedReduce(s, { type: 'mine' });
    expect(s).toMatchObject({ draft: { label: '天台 · 仰拍', setup_min: 20 }, seed: latest, base: 1 });
  });

  it('a shot change also refreshes the views computed from shots', () => {
    const keys = rootsOfAreas(['shots']).map((r) => JSON.stringify(r));
    for (const k of [['boards', 'list'], ['plan', 'plans'], ['m6', 'coverage'], ['deliver', 'coverage']]) expect(keys).toContain(JSON.stringify(k));
  });
});

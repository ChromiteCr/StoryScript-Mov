import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Api, type ActorRef, type CollabArea, type CollabChanges, type CollabEvent, type CollabPage, type CollabVerb, type PresenceEntry } from '@storyscript/contracts';
import { isApiClientError, isUnauthorized, send, setRequestTab } from './api.ts';
import { allRoots, rootsOfAreas, type QueryRoot } from './collab-areas.ts';
import { actorText } from './crew.ts';
import { markNoTeam, markSessionExpired } from './session.ts';

/**
 * S4a — teammates' changes appear without reloading, and who is online.
 *
 * The browser polls GET /collab/changes. The answer says which areas moved
 * since the last poll; the queries of those areas (collab-areas.ts) refetch.
 * The poll also tells the server which page this tab is on (the heartbeat
 * behind 「谁在线」) and brings back who else is there.
 *
 * Everything with a decision in it is a pure function here (what to
 * invalidate, how long to wait, how to word an event) and is unit-tested;
 * the poller takes its clock and its fetch as arguments so fake timers can
 * drive it; only useCollabSync touches React and the DOM.
 */

// ------------------------------------------------------------------ cadence --

export const POLL_ACTIVE_MS = 4_000;
export const POLL_IDLE_MS = 10_000;
export const POLL_HIDDEN_MS = 30_000;
/** no pointer or key for this long: the tab counts as idle */
export const IDLE_AFTER_MS = 60_000;
/** ± this share of the interval, so the tabs of a group do not poll in step */
export const POLL_JITTER = 0.2;
/** a request that has not answered by then is given up (and the next poll tries again) */
export const POLL_TIMEOUT_MS = 15_000;

/** Base interval before jitter: 30 s in the background, 10 s when idle, else 4 s. */
export function pollBaseMs(o: { hidden: boolean; idleMs: number }): number {
  if (o.hidden) return POLL_HIDDEN_MS;
  return o.idleMs > IDLE_AFTER_MS ? POLL_IDLE_MS : POLL_ACTIVE_MS;
}

/** The wait before the next poll; `random` is Math.random (0 ≤ r < 1). */
export function pollDelayMs(o: { hidden: boolean; idleMs: number; random: number }): number {
  const factor = 1 + (o.random * 2 - 1) * POLL_JITTER;
  return Math.round(pollBaseMs(o) * factor);
}

// ------------------------------------------------------------------ one poll --

/** What this browser has applied so far. `null` before the first answer. */
export interface CollabCursor {
  epoch: string;
  seq: number;
  members_rev: string;
}

export interface PollOutcome {
  cursor: CollabCursor;
  /** the first answer only adopts the state: the page has just been loaded, so nothing is stale */
  first: boolean;
  /** everything is stale (the server restarted, or the feed forgot events) */
  reset: boolean;
  /** query roots to refetch, each once */
  roots: QueryRoot[];
  /** the roster changed (someone joined, left, was renamed or got another role) */
  refreshMe: boolean;
  /** teammates' events since the last poll, oldest first (own writes are not in it) */
  fresh: CollabEvent[];
  /** the signed-in member's id as the server sees it (from presence), when known */
  myId: string | null;
}

/**
 * Turn an answer into what to do. Pure.
 *
 *  - first answer: adopt epoch and seq, invalidate nothing (the server also
 *    says `reset` for an unknown epoch; that is not news);
 *  - epoch changed or `reset`: every area's roots;
 *  - otherwise the roots of the areas of teammates' events. A member's own
 *    writes already refreshed what they touched, so they are skipped, except
 *    a finished job: it changes things nobody was told about yet.
 */
export function planPoll(cursor: CollabCursor | null, res: CollabChanges, knownMyId: string | null): PollOutcome {
  const myId = res.presence.find((p) => p.you)?.actor.id ?? knownMyId;
  const next: CollabCursor = { epoch: res.epoch, seq: res.seq, members_rev: res.members_rev };
  if (cursor === null) return { cursor: next, first: true, reset: false, roots: [], refreshMe: false, fresh: [], myId };
  if (res.reset || res.epoch !== cursor.epoch) {
    return { cursor: next, first: false, reset: true, roots: allRoots(), refreshMe: true, fresh: [], myId };
  }
  const events = res.events.filter((e) => e.seq > cursor.seq);
  const areas = new Set<CollabArea>();
  const fresh: CollabEvent[] = [];
  for (const e of events) {
    const own = e.actor !== null && myId !== null && e.actor.id === myId;
    if (e.actor !== null && !own) fresh.push(e);
    // this tab's own writes already refreshed what they touched; another tab of the same member did not
    if (e.from_this_tab && e.verb !== 'finished') continue;
    for (const a of e.areas) areas.add(a);
  }
  return {
    cursor: { epoch: res.epoch, seq: Math.max(cursor.seq, res.seq), members_rev: res.members_rev },
    first: false,
    reset: false,
    roots: rootsOfAreas(areas),
    refreshMe: res.members_rev !== cursor.members_rev,
    fresh,
    myId,
  };
}

// ------------------------------------------------------------------- request --

export interface CollabQuery {
  since: number;
  epoch: string;
  tab: string;
  page: CollabPage;
  /** the shot open in the script inspector */
  focus: string | null;
  hidden: boolean;
}

export function collabQueryString(q: CollabQuery): string {
  const p = new URLSearchParams({ since: String(q.since), epoch: q.epoch, tab: q.tab, page: q.page, hidden: q.hidden ? '1' : '0' });
  if (q.focus) p.set('focus', q.focus);
  return p.toString();
}

/** GET /api/v1/collab/changes: the api client's error handling and schema check, plus the query string. */
export function fetchCollabChanges(q: CollabQuery, signal?: AbortSignal): Promise<CollabChanges> {
  const qs = collabQueryString(q);
  return send(Api.collabChanges, undefined, { signal }, (url, init) => fetch(`${url}?${qs}`, init)) as Promise<CollabChanges>;
}

const TAB_KEY = 'ssm-collab-tab';
let memoryTab: string | null = null;

function newTabId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** One id per browser tab: it survives a reload of the tab (sessionStorage) but a second tab gets its own. */
export function collabTabId(): string {
  try {
    const kept = window.sessionStorage.getItem(TAB_KEY);
    if (kept) return kept;
    const id = newTabId();
    window.sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    memoryTab ??= newTabId();
    return memoryTab;
  }
}

/** Errors that end polling: the session is gone, the member left the group, or this server has no feed. */
export function isFatalPollError(e: unknown): boolean {
  return isUnauthorized(e) || (isApiClientError(e) && (e.code === 'NO_TEAM' || e.status === 404));
}

// -------------------------------------------------------------------- poller --

export interface PollerDeps {
  /** one request; the poller passes what it has applied so far */
  fetch: (q: Pick<CollabQuery, 'since' | 'epoch'>, signal: AbortSignal) => Promise<CollabChanges>;
  /** this tab's page, focus and visibility, read at the time of each poll */
  context: () => Pick<CollabQuery, 'page' | 'focus' | 'hidden'>;
  /** an answer arrived */
  apply: (outcome: PollOutcome, res: CollabChanges) => void;
  /** polling ended for good (see isFatalPollError) */
  onFatal: (error: unknown) => void;
  now?: () => number;
  random?: () => number;
  myId?: () => string | null;
}

export interface Poller {
  start: () => void;
  stop: () => void;
  /** poll now (the tab became visible again) */
  wake: () => void;
  /** a pointer or key event: the tab is not idle */
  noteActivity: () => void;
  /** for tests */
  cursor: () => CollabCursor | null;
}

/**
 * The polling loop. One request in flight at a time; the next is scheduled
 * when the last one settled, after pollDelayMs (a failed request waits at
 * least the idle interval). Timers are plain setTimeout, so fake timers work.
 */
export function createPoller(deps: PollerDeps): Poller {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  let cursor: CollabCursor | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let stopped = true;
  let lastActivity = now();
  let myId: string | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (atLeast = 0) => {
    clear();
    if (stopped) return;
    const ctx = deps.context();
    const delay = Math.max(atLeast, pollDelayMs({ hidden: ctx.hidden, idleMs: now() - lastActivity, random: random() }));
    timer = setTimeout(() => void poll(), delay);
  };

  const poll = async (): Promise<void> => {
    clear();
    if (stopped || inflight) return;
    const controller = new AbortController();
    inflight = controller;
    // a request that was cancelled by stop() (and a start() after it) must not touch the new loop
    const current = () => !stopped && inflight === controller;
    const giveUp = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const res = await deps.fetch({ since: cursor?.seq ?? 0, epoch: cursor?.epoch ?? '' }, controller.signal);
      if (!current()) return;
      const outcome = planPoll(cursor, res, deps.myId?.() ?? myId);
      cursor = outcome.cursor;
      myId = outcome.myId ?? myId;
      deps.apply(outcome, res);
      inflight = null;
      schedule();
    } catch (e) {
      if (!current()) return;
      inflight = null;
      if (isFatalPollError(e)) {
        stopped = true;
        deps.onFatal(e);
        return;
      }
      schedule(POLL_IDLE_MS);
    } finally {
      clearTimeout(giveUp);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      lastActivity = now();
      void poll();
    },
    stop() {
      stopped = true;
      clear();
      inflight?.abort();
      inflight = null;
    },
    wake() {
      if (stopped || inflight) return;
      void poll();
    },
    noteActivity() {
      lastActivity = now();
    },
    cursor: () => cursor,
  };
}

// ------------------------------------------------------------------ wording --

/** 「改了」「新建了」… the verb of an event as it reads after the name. */
export const VERB_PHRASE: Readonly<Record<CollabVerb, string>> = {
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
};

export const PAGE_LABEL: Readonly<Record<CollabPage, string>> = {
  home: '首页',
  projects: '项目页',
  script: '剧本页',
  boards: '分镜页',
  plan: '计划页',
  set: '现场页',
  media: '素材页',
  deliver: '交付页',
  settings: '设置页',
  other: '其他页面',
};

/** 「第 3 场 002」, 「第 3 场」, or '' when the event has no place. */
export function eventPlace(e: Pick<CollabEvent, 'scene_no' | 'shot_code'>): string {
  const scene = e.scene_no ? `第 ${e.scene_no} 场` : '';
  return [scene, e.shot_code ?? ''].filter((s) => s !== '').join(' ');
}

/** "10:32" in the viewer's zone. */
export function clockText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 「阿杰（导演）改了 第 3 场 002」 (no time); a job with no requester reads 「有任务完成了」. */
export function eventSentence(e: CollabEvent): string {
  const who = e.actor ? actorText(e.actor) : null;
  const place = eventPlace(e);
  if (!who) return `${e.verb === 'finished' ? '有任务完成了' : '有内容改了'}${place ? ` ${place}` : ''}`;
  return `${who}${VERB_PHRASE[e.verb]}${place ? ` ${place}` : ''}`;
}

/** 「阿杰（导演）改了 第 3 场 002 · 10:32」 */
export function eventLine(e: CollabEvent): string {
  const time = clockText(e.at);
  return time ? `${eventSentence(e)} · ${time}` : eventSentence(e);
}

/** The short activity line: 「阿杰刚改了 第 3 场 002」. */
export function activityLine(e: CollabEvent): string {
  const name = e.actor?.name ?? '组员';
  const place = eventPlace(e);
  return `${name}刚${VERB_PHRASE[e.verb]}${place ? ` ${place}` : ''}`;
}

/** 「小林（摄影）· 分镜页」, with 「（离开）」 when their tab is in the background. */
export function presenceTitle(p: Pick<PresenceEntry, 'actor' | 'page' | 'away'>): string {
  return `${actorText(p.actor)}· ${PAGE_LABEL[p.page]}${p.away ? '（离开）' : ''}`;
}

/** First character of a name, for the avatar. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}

/**
 * The text 复制 puts on the clipboard when the shot being edited was archived
 * by a teammate: what was typed, so it can be pasted into another shot.
 */
export function unsavedShotText(f: { action: string; notes: string; dialogue: string; narrative: string }): string {
  const lines: string[] = [];
  if (f.action.trim() !== '') lines.push(`动作：${f.action.trim()}`);
  if (f.notes.trim() !== '') lines.push(`拍法说明：${f.notes.trim()}`);
  if (f.dialogue.trim() !== '') lines.push(`台词：${f.dialogue.trim()}`);
  if (f.narrative.trim() !== '') lines.push(`叙事作用：${f.narrative.trim()}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------- store --

/** How many events the popover keeps. */
export const FEED_LINES = 20;
/** How long the activity line stays. */
export const ACTIVITY_MS = 8_000;

export interface CollabFeedState {
  presence: readonly PresenceEntry[];
  /** newest first, at most FEED_LINES */
  events: readonly CollabEvent[];
  /** the newest event of a teammate seen after the page loaded, with the time it arrived */
  latest: { event: CollabEvent; shownAt: number } | null;
  /** the signed-in member's id, once the server said (presence `you`) */
  myId: string | null;
}

const EMPTY_FEED: CollabFeedState = { presence: [], events: [], latest: null, myId: null };
let feed: CollabFeedState = EMPTY_FEED;
const feedListeners = new Set<() => void>();

function setFeed(next: CollabFeedState): void {
  feed = next;
  for (const l of feedListeners) l();
}

/** Merge events into a newest-first list by seq, capped. Pure. */
export function mergeEvents(current: readonly CollabEvent[], incoming: readonly CollabEvent[], cap = FEED_LINES): CollabEvent[] {
  const bySeq = new Map<number, CollabEvent>();
  for (const e of [...current, ...incoming]) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, cap);
}

/** What of a presence list a screen shows: the heartbeat time changes with every poll and is left out. */
function presenceSignature(list: readonly PresenceEntry[]): string {
  return JSON.stringify(list.map((p) => [p.actor.id, p.actor.name, p.actor.crew_roles, p.page, p.focus_shot_id, p.away, p.you]));
}

/**
 * Record an answer: who is online, and the events for the popover and the
 * activity line. A poll that brings nothing new leaves the state as it was
 * (same objects, no notification), so the screens that read it do not redraw
 * every few seconds for nothing.
 */
export function recordPoll(res: Pick<CollabChanges, 'presence'>, outcome: Pick<PollOutcome, 'fresh' | 'myId' | 'reset'>, at: number, history: readonly CollabEvent[] = []): void {
  const newest = outcome.fresh.at(-1);
  const merged = mergeEvents(outcome.reset ? [] : feed.events, [...history, ...outcome.fresh]);
  const events = merged.length === feed.events.length && merged.every((e, i) => e.seq === feed.events[i]?.seq) ? feed.events : merged;
  const presence = presenceSignature(res.presence) === presenceSignature(feed.presence) ? feed.presence : res.presence;
  const latest = newest ? { event: newest, shownAt: at } : feed.latest;
  const myId = outcome.myId ?? feed.myId;
  if (events === feed.events && presence === feed.presence && latest === feed.latest && myId === feed.myId) return;
  setFeed({ presence, events, latest, myId });
}

export function resetCollabFeed(): void {
  setFeed(EMPTY_FEED);
}

export function getCollabFeed(): CollabFeedState {
  return feed;
}

export function subscribeCollabFeed(listener: () => void): () => void {
  feedListeners.add(listener);
  return () => feedListeners.delete(listener);
}

export function useCollabFeed(): CollabFeedState {
  return useSyncExternalStore(subscribeCollabFeed, getCollabFeed, getCollabFeed);
}

/** Teammates online now (not this member), for the avatars and the shot editor's notice. */
export function othersOnline(presence: readonly PresenceEntry[]): PresenceEntry[] {
  return presence.filter((p) => !p.you);
}

/** Teammates who have this shot open in their editor. */
export function watchersOf(shotId: string | null, presence: readonly PresenceEntry[]): PresenceEntry[] {
  if (!shotId) return [];
  return othersOnline(presence).filter((p) => p.focus_shot_id === shotId);
}

/** 「阿杰也在看这个镜头」, 「阿杰、小林也在看这个镜头」; null when nobody is. */
export function watchersText(watchers: readonly PresenceEntry[]): string | null {
  if (watchers.length === 0) return null;
  const names = watchers.map((w) => w.actor.name);
  return `${names.length > 3 ? `${names.slice(0, 3).join('、')}等 ${names.length} 人` : names.join('、')}也在看这个镜头`;
}

/** The newest teammate (not me) who changed one of these areas, for 「阿杰刚改了这一项」. */
export function lastChangerOf(events: readonly CollabEvent[], areas: readonly CollabArea[], myId: string | null): ActorRef | null {
  for (const e of events) {
    if (!e.actor || (myId !== null && e.actor.id === myId)) continue;
    if (e.areas.some((a) => areas.includes(a))) return e.actor;
  }
  return null;
}

/** Name of the teammate who last changed something in these areas, or null. */
export function useChangedBy(areas: readonly CollabArea[]): string | null {
  const { events, myId } = useCollabFeed();
  const key = areas.join(',');
  return useMemo(() => lastChangerOf(events, key.split(',') as CollabArea[], myId)?.name ?? null, [events, myId, key]);
}

// ---------------------------------------------------------------------- focus --

let focusShot: string | null = null;

/** The script page reports the shot open in its inspector; the next poll carries it. */
export function setCollabFocus(shotId: string | null): void {
  focusShot = shotId;
}

export function getCollabFocus(): string | null {
  return focusShot;
}

// ----------------------------------------------------------------------- hook --

function invalidateRoots(qc: QueryClient, roots: readonly QueryRoot[]): void {
  for (const root of roots) void qc.invalidateQueries({ queryKey: [...root] });
}

/**
 * Keep this browser in step with the group. Mount once while a project is
 * open. `page` is where this tab is (it goes to the server as presence).
 * Own writes are not refetched; the first answer only adopts the state.
 */
export function useCollabSync(page: CollabPage, enabled = true): void {
  const qc = useQueryClient();
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    if (!enabled) return;
    const tab = collabTabId();
    setRequestTab(tab);
    let live = true;
    const context = () => ({ page: pageRef.current, focus: getCollabFocus(), hidden: document.hidden });
    const poller = createPoller({
      fetch: (q, signal) => fetchCollabChanges({ ...q, tab, ...context() }, signal),
      context,
      myId: () => getCollabFeed().myId,
      apply: (outcome, res) => {
        if (!live) return;
        invalidateRoots(qc, outcome.roots);
        if (outcome.refreshMe) void qc.invalidateQueries({ queryKey: ['me'] });
        recordPoll(res, outcome, Date.now());
        if (outcome.first && res.seq > 0) {
          // the popover's recent lines: the feed remembers the last events, so ask once for them
          void fetchCollabChanges({ since: 0, epoch: res.epoch, tab, ...context() })
            .then((past) => {
              if (live && !past.reset) recordPoll(past, { fresh: [], myId: outcome.myId, reset: false }, Date.now(), past.events);
            })
            .catch(() => undefined);
        }
      },
      onFatal: (e) => {
        // the existing handling takes over: a 401 shows sign-in, NO_TEAM the group screen
        if (isUnauthorized(e)) markSessionExpired();
        else if (isApiClientError(e) && e.code === 'NO_TEAM') markNoTeam();
      },
    });
    const onVisibility = () => {
      poller.noteActivity();
      if (!document.hidden) poller.wake();
    };
    const onActivity = () => poller.noteActivity();
    document.addEventListener('visibilitychange', onVisibility);
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, onActivity, { passive: true });
    poller.start();
    return () => {
      live = false;
      poller.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const name of events) window.removeEventListener(name, onActivity);
      resetCollabFeed();
    };
  }, [enabled, qc]);
}

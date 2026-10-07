import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  Api,
  type ActorRef,
  type CollabArea,
  type CollabChanges,
  type CollabEvent,
  type CollabPage,
  type CollabVerb,
  type JobKind,
  type PresenceEntry,
} from '@storyscript/contracts';
import type { RosterEntry } from './actor.ts';

/**
 * S4a — one in-memory change feed per group instance (and one for the local
 * app, whose tabs benefit too). A successful write bumps the areas it
 * touched; browsers poll `GET /collab/changes` and refetch the queries of the
 * areas that moved. The poll doubles as the presence heartbeat. Nothing is
 * stored: after a restart the epoch changes and browsers refetch everything.
 */

type Route = keyof typeof Api;
type WriteRoute = { [K in Route]: (typeof Api)[K]['method'] extends 'GET' ? never : K }[Route];

/**
 * Which areas each write touches. Typed over every non-GET route, so a new
 * route fails to compile until it is listed here. 'ignore': no shared data
 * changes (previews, tests, the gateway's own account and group routes).
 */
export const AREA_OF: Record<WriteRoute, readonly CollabArea[] | 'ignore'> = {
  session: 'ignore',
  logout: 'ignore',
  registerCode: 'ignore',
  register: 'ignore',
  passwordLogin: 'ignore',
  loginCode: 'ignore',
  codeLogin: 'ignore',
  changePassword: 'ignore',
  createGroup: 'ignore',
  previewGroup: 'ignore',
  joinGroup: 'ignore',
  switchGroup: 'ignore',
  leaveGroup: 'ignore',
  resetGroupCode: 'ignore',
  removeGroupMember: 'ignore',
  disbandGroup: 'ignore',
  setCrewRoles: 'ignore',
  setModelChoice: 'ignore',
  createProject: ['project'],
  openProject: ['project'],
  closeProject: ['project'],
  chooseFolder: 'ignore',
  saveTextProvider: ['settings'],
  testTextProvider: 'ignore',
  saveMyTextProvider: 'ignore',
  testMyTextProvider: 'ignore',
  previewScript: 'ignore',
  importScript: ['script', 'shots', 'entities', 'boards'],
  updateScene: ['script'],
  createEntity: ['entities'],
  updateEntity: ['entities'],
  extractEntities: ['jobs'],
  applyEntityDraft: ['entities', 'drafts'],
  createShot: ['shots', 'boards'],
  updateShot: ['shots', 'boards'],
  archiveShot: ['shots', 'boards'],
  setRequirement: ['shots'],
  setNarrativeOrder: ['shots'],
  requestBreakdown: ['jobs'],
  applyBreakdown: ['shots', 'boards', 'drafts'],
  discardDraft: ['drafts'],
  createStyle: ['styles'],
  saveStyleDefaults: ['styles'],
  researchStyle: ['jobs'],
  updateStyle: ['styles'],
  deleteStyle: ['styles'],
  saveResearchedStyle: ['styles', 'drafts'],
  requestPolish: ['jobs'],
  applyPolish: ['shots', 'drafts'],
  applyCast: ['entities'],
  applyCastSync: ['plan'],
  startScriptCheck: ['jobs'],
  setRiskHandled: ['script'],
  saveUsagePrice: ['settings'],
  cancelJob: ['jobs'],
  createResource: ['plan'],
  updateResource: ['plan'],
  deleteResource: ['plan'],
  deriveSetups: ['plan'],
  createSetup: ['plan'],
  updateSetup: ['plan'],
  deleteSetup: ['plan'],
  createConstraint: ['plan'],
  deleteConstraint: ['plan'],
  createPlan: ['plan'],
  recomputePlan: ['plan'],
  reorderPlan: ['plan'],
  approvePlan: ['plan'],
  suggestOrder: ['jobs'],
  adoptSuggestion: ['plan', 'drafts'],
  createTake: ['takes'],
  updateTake: ['takes'],
  addRoot: ['media'],
  scanRoot: ['media', 'jobs'],
  checkRoot: ['media'],
  createBrowserRoot: ['media'],
  reportBrowserFiles: ['media'],
  reportAssetFacts: ['media'],
  searchAssets: 'ignore',
  buildCandidates: ['media'],
  createLink: ['media', 'takes'],
  reviewLink: ['media', 'takes'],
  addCoverageDecision: ['takes', 'media'],
  regenerateBoard: ['boards'],
  relayoutBoards: ['boards'],
  saveBoard: ['boards'],
  keepBoard: ['boards'],
  saveImageProvider: ['settings'],
  testImageProvider: 'ignore',
  saveMyImageProvider: 'ignore',
  testMyImageProvider: 'ignore',
  requestRedraw: ['jobs'],
  createComment: ['comments'],
  markCommentsRead: 'ignore',
  updateComment: ['comments'],
  deleteComment: ['comments'],
  resolveComment: ['comments'],
  reopenComment: ['comments'],
  adoptRaster: ['boards'],
  rejectRaster: ['boards'],
};

/** How a write reads in the activity line (the web writes the Chinese). */
const VERB_OF: Partial<Record<WriteRoute, CollabVerb>> = {
  importScript: 'imported',
  createShot: 'created',
  archiveShot: 'archived',
  applyBreakdown: 'applied',
  applyPolish: 'applied',
  applyEntityDraft: 'applied',
  approvePlan: 'approved',
  createTake: 'logged',
  saveBoard: 'saved',
  keepBoard: 'saved',
  createPlan: 'created',
  createStyle: 'created',
  saveResearchedStyle: 'created',
  createComment: 'commented',
};

/** Areas a finished job touches. */
export const JOB_AREAS: Record<JobKind, readonly CollabArea[]> = {
  extract_entities: ['jobs', 'drafts'],
  breakdown_scene: ['jobs', 'drafts'],
  suggest_order: ['jobs', 'drafts', 'plan'],
  scan_root: ['jobs', 'media'],
  probe_asset: ['jobs', 'media'],
  hash_asset: ['jobs', 'media'],
  poster_asset: ['jobs', 'media'],
  image_redraw: ['jobs', 'boards'],
  research_style: ['jobs', 'drafts'],
  polish_shots: ['jobs', 'drafts'],
  check_script: ['jobs', 'script'],
};

const ALL_AREAS: readonly CollabArea[] = [
  'script',
  'shots',
  'boards',
  'plan',
  'takes',
  'media',
  'entities',
  'styles',
  'drafts',
  'jobs',
  'project',
  'comments',
  'members',
  'settings',
];

interface Matcher {
  route: WriteRoute;
  method: string;
  re: RegExp;
}

const MATCHERS: Matcher[] = (Object.keys(AREA_OF) as WriteRoute[])
  .map((route) => {
    const { method, path } = Api[route];
    // static segments first: "/shots/polish" must not be read as "/shots/:id"
    const re = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z_]+/g, '[^/]+')}$`);
    return { route, method, re, statics: path.split('/').filter((p) => p && !p.startsWith(':')).length };
  })
  .sort((a, b) => b.statics - a.statics);

export function writeRouteOf(method: string, path: string): WriteRoute | null {
  const m = MATCHERS.find((x) => x.method === method && x.re.test(path));
  return m?.route ?? null;
}

/** Areas a successful write touched; an unknown write moves everything (safe side). */
export function areasOf(method: string, path: string): { route: WriteRoute | null; areas: readonly CollabArea[] } {
  const route = writeRouteOf(method, path);
  // the poster upload is registered by hand (a binary body), outside the contract
  if (!route && method === 'PUT' && /^\/api\/v1\/media\/assets\/[^/]+\/poster$/.test(path)) return { route: null, areas: ['media'] };
  if (!route) return { route: null, areas: ALL_AREAS };
  const a = AREA_OF[route];
  return { route, areas: a === 'ignore' ? [] : a };
}

export function verbOf(route: WriteRoute | null): CollabVerb {
  return (route && VERB_OF[route]) ?? 'changed';
}

// ------------------------------------------------------------------- feed --

interface StoredEvent {
  seq: number;
  at: string;
  actor_id: string | null;
  areas: CollabArea[];
  verb: CollabVerb;
  scene_no: string | null;
  shot_code: string | null;
  /** the browser tab that made the write (X-SSM-Tab), if it said */
  tab: string | null;
}

interface Heartbeat {
  page: CollabPage;
  focus: string | null;
  hidden: boolean;
  at: number;
}

export const FEED_KEEP = 50;
export const PRESENCE_TTL_MS = 45_000;

export class CollabFeed {
  readonly epoch = randomUUID().replace(/-/g, '').slice(0, 16);
  private seq = 0;
  private readonly areaSeq = new Map<CollabArea, number>();
  private readonly events: StoredEvent[] = [];
  /** account → tab → last heartbeat */
  private readonly presence = new Map<string, Map<string, Heartbeat>>();

  constructor(private readonly now: () => number = Date.now) {}

  bump(
    areas: readonly CollabArea[],
    e: { actor_id: string | null; verb?: CollabVerb; scene_no?: string | null; shot_code?: string | null; tab?: string | null },
  ): void {
    if (areas.length === 0) return;
    this.seq++;
    for (const a of areas) this.areaSeq.set(a, this.seq);
    this.events.push({
      seq: this.seq,
      at: new Date(this.now()).toISOString(),
      actor_id: e.actor_id,
      areas: [...areas],
      verb: e.verb ?? 'changed',
      scene_no: e.scene_no ?? null,
      shot_code: e.shot_code ?? null,
      tab: e.tab ?? null,
    });
    if (this.events.length > FEED_KEEP) this.events.splice(0, this.events.length - FEED_KEEP);
  }

  touch(accountId: string, tab: string, beat: Omit<Heartbeat, 'at'>): void {
    let tabs = this.presence.get(accountId);
    if (!tabs) this.presence.set(accountId, (tabs = new Map()));
    tabs.set(tab || 'default', { ...beat, at: this.now() });
  }

  /** Who is online: one entry per account (a visible tab wins over hidden ones), stale tabs dropped. */
  online(roster: readonly RosterEntry[], me: string | null): PresenceEntry[] {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    const byId = new Map(roster.map((r) => [r.id, r] as const));
    const out: PresenceEntry[] = [];
    for (const [id, tabs] of this.presence) {
      for (const [tab, beat] of tabs) if (beat.at < cutoff) tabs.delete(tab);
      const person = byId.get(id);
      if (tabs.size === 0 || !person) {
        if (tabs.size === 0) this.presence.delete(id);
        continue;
      }
      const beats = [...tabs.values()].sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.at - a.at);
      const best = beats[0]!;
      const actor: ActorRef = { id, name: person.name, crew_roles: person.crew_roles, left: false };
      out.push({ actor, page: best.page, focus_shot_id: best.focus, away: best.hidden, you: id === me, at: new Date(best.at).toISOString() });
    }
    return out.sort((a, b) => Number(b.you) - Number(a.you) || a.actor.name.localeCompare(b.actor.name, 'zh'));
  }

  changes(
    q: { since: number; epoch: string; tab?: string },
    ctx: { roster: readonly RosterEntry[]; me: string | null; actor: (id: string | null) => ActorRef | null },
  ): CollabChanges {
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    const reset = q.epoch !== this.epoch || q.since > this.seq || (q.since > 0 && q.since < oldest - 1);
    const events: CollabEvent[] = reset
      ? []
      : this.events
          .filter((e) => e.seq > q.since)
          .map((e) => ({
            seq: e.seq,
            at: e.at,
            actor: ctx.actor(e.actor_id),
            areas: e.areas,
            verb: e.verb,
            scene_no: e.scene_no,
            shot_code: e.shot_code,
            from_this_tab: !!q.tab && e.tab === q.tab,
          }));
    return {
      epoch: this.epoch,
      seq: this.seq,
      area_seq: Object.fromEntries(this.areaSeq),
      events,
      reset,
      presence: this.online(ctx.roster, ctx.me),
      members_rev: createHash('sha256')
        .update(JSON.stringify(ctx.roster.map((r) => [r.id, r.name, r.role, r.crew_roles])))
        .digest('hex')
        .slice(0, 16),
    };
  }
}

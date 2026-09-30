import { randomInt } from 'node:crypto';
import type { GroupPreview, GroupView } from '@storyscript/contracts';
import { AppError } from '../http/errors.ts';
import { generateJoinCode, normalizeJoinCode, showJoinCode, type HostedConfig } from './config.ts';
import { LoginLimiter } from './limiter.ts';
import { crewRolesOf, type Account, type Membership, type SiteDb } from './site-db.ts';
import type { TeamRuntime } from './teams.ts';

/**
 * Groups on a hosted server. Anyone signed in can start one (and leads it)
 * or join one with its code; a group shares one project. An account may be
 * in up to `limits.max_groups_per_account` groups at once (S2d; 2 by
 * default, its own included) and switches between them on the 项目 page.
 * The leader removes members and replaces the code; when the leader leaves,
 * the earliest-joined member leads; a leader alone can disband the group,
 * which deletes its project.
 */

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export class Groups {
  /** wrong join codes per account */
  readonly wrongCodes: LoginLimiter;

  constructor(
    private readonly d: { site: SiteDb; runtime: TeamRuntime; config: HostedConfig; now?: () => number },
  ) {
    this.wrongCodes = new LoginLimiter(10, 10_000, 15 * 60_000, d.now ?? Date.now);
  }

  get maxGroups(): number {
    return this.d.config.limits.max_groups_per_account;
  }

  private viewOf(account: Account, m: Membership): GroupView | null {
    const { site, config } = this.d;
    const team = site.team(m.team_slug);
    if (!team) return null;
    return {
      slug: team.slug,
      name: team.name,
      join_code: showJoinCode(team.join_code),
      role: m.role,
      members: site
        .members(team.slug)
        .map((x) => ({ id: x.id, name: x.name, role: x.role, joined_at: x.joined_at, you: x.id === account.id, crew_roles: crewRolesOf(x.crew_roles_json) })),
      max_members: config.limits.max_team_members,
      model_choice: { text: m.text_source ?? 'group', image: m.image_source ?? 'group' },
    };
  }

  /** Every group of the account, earliest joined first. */
  list(account: Account): GroupView[] {
    return this.d.site
      .memberships(account.id)
      .map((m) => this.viewOf(account, m))
      .filter((v): v is GroupView => v !== null);
  }

  view(account: Account, slug: string | null): GroupView | null {
    if (!slug) return null;
    const m = this.d.site.membership(account.id, slug);
    return m ? this.viewOf(account, m) : null;
  }

  /** The group a browser should work in: the one it chose if still a member, else the earliest joined. */
  resolveCurrent(account: Account, wanted: string | null): string | null {
    const all = this.d.site.memberships(account.id);
    if (wanted && all.some((m) => m.team_slug === wanted)) return wanted;
    return all[0]?.team_slug ?? null;
  }

  private mustView(account: Account, slug: string): GroupView {
    const v = this.view(account, slug);
    if (!v) throw new AppError('NOT_FOUND', '你不在这个小组里。', 404);
    return v;
  }

  private mustLead(account: Account, slug: string): GroupView {
    const v = this.mustView(account, slug);
    if (v.role !== 'leader') throw new AppError('FORBIDDEN', '只有组长可以这样做。', 403);
    return v;
  }

  private assertRoom(account: Account): void {
    if (this.d.site.memberships(account.id).length >= this.maxGroups) {
      throw new AppError('QUOTA_EXCEEDED', `每人最多同时在 ${this.maxGroups} 个小组里（包括自己建的）。先退出一个，再建新组或加入别的组。`, 409, {
        limit: this.maxGroups,
      });
    }
  }

  private newSlug(): string {
    for (;;) {
      let s = 'g';
      for (let i = 0; i < 7; i++) s += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
      if (!this.d.site.team(s)) return s;
    }
  }

  private newJoinCode(): string {
    for (;;) {
      const c = generateJoinCode();
      if (!this.d.site.teamByJoinCode(c)) return c;
    }
  }

  async create(account: Account, name: string): Promise<GroupView> {
    const { site, runtime, config } = this.d;
    this.assertRoom(account);
    if (site.listTeams().length >= config.limits.max_teams) {
      throw new AppError('QUOTA_EXCEEDED', `网站的小组数已经到上限（${config.limits.max_teams} 个），请加入已有的小组，或联系管理员。`, 409);
    }
    const team = site.createTeam({ slug: this.newSlug(), name, join_code: this.newJoinCode() });
    try {
      await runtime.open(team);
    } catch (err) {
      site.deleteTeam(team.slug);
      runtime.remove(team.slug);
      throw err;
    }
    site.addMembership(account.id, team.slug, 'leader');
    return this.mustView(account, team.slug);
  }

  private findByCode(account: Account, code: string) {
    const wait = this.wrongCodes.retryAfter(account.id);
    if (wait > 0) {
      throw new AppError('TOO_MANY_ATTEMPTS', `组码输错次数太多，请 ${Math.ceil(wait / 60)} 分钟后再试。`, 429, { retry_after_s: wait }, true);
    }
    const team = this.d.site.teamByJoinCode(normalizeJoinCode(code));
    if (!team) {
      this.wrongCodes.fail(account.id);
      throw new AppError('NOT_FOUND', '没有这个组码。请向组长确认，组码可能已经换过。', 404);
    }
    return team;
  }

  preview(account: Account, code: string): GroupPreview {
    const team = this.findByCode(account, code);
    const members = this.d.site.members(team.slug);
    return {
      slug: team.slug,
      name: team.name,
      members: members.length,
      full: members.length >= this.d.config.limits.max_team_members,
      joined: members.some((m) => m.id === account.id),
    };
  }

  /** Join by code (already a member: nothing changes). */
  join(account: Account, code: string): GroupView {
    const { site, config } = this.d;
    const team = this.findByCode(account, code);
    if (site.membership(account.id, team.slug)) return this.mustView(account, team.slug);
    this.assertRoom(account);
    if (site.members(team.slug).length >= config.limits.max_team_members) {
      throw new AppError('QUOTA_EXCEEDED', `「${team.name}」已经满员（${config.limits.max_team_members} 人）。`, 409);
    }
    site.addMembership(account.id, team.slug, 'member');
    return this.mustView(account, team.slug);
  }

  leave(account: Account, slug: string): void {
    const { site } = this.d;
    const v = this.mustView(account, slug);
    const others = site.members(slug).filter((m) => m.id !== account.id);
    if (others.length === 0) {
      throw new AppError('VALIDATION_ERROR', '你是这个小组的最后一个人。不再需要的话，请解散小组。', 409);
    }
    site.db.tx(() => {
      site.removeMembership(account.id, slug);
      if (v.role === 'leader') site.setRole(others[0]!.id, slug, 'leader');
    });
  }

  resetCode(account: Account, slug: string): GroupView {
    this.mustLead(account, slug);
    this.d.site.setJoinCode(slug, this.newJoinCode());
    return this.mustView(account, slug);
  }

  removeMember(account: Account, slug: string, memberId: string): GroupView {
    const { site } = this.d;
    this.mustLead(account, slug);
    if (memberId === account.id) throw new AppError('VALIDATION_ERROR', '不能移除自己；要离开请用"退出小组"。', 409);
    if (!site.membership(memberId, slug)) throw new AppError('NOT_FOUND', '这个人已经不在小组里了。', 404);
    site.removeMembership(memberId, slug);
    return this.mustView(account, slug);
  }

  /** S4: crew roles — the member themself or the leader */
  setCrewRoles(account: Account, slug: string, memberId: string, roles: readonly string[]): GroupView {
    const { site } = this.d;
    const me = this.mustView(account, slug);
    if (memberId !== account.id && me.role !== 'leader') throw new AppError('FORBIDDEN', '只能改自己的职务；组长可以改所有人的。', 403);
    if (!site.membership(memberId, slug)) throw new AppError('NOT_FOUND', '这个人已经不在小组里了。', 404);
    const clean: string[] = [];
    for (const r of roles) {
      const t = r.trim();
      if (t && !clean.includes(t)) clean.push(t);
    }
    site.setCrewRoles(memberId, slug, clean);
    return this.mustView(account, slug);
  }

  /** S4: in this group, use the group's model or one's own */
  setModelChoice(account: Account, slug: string, choice: { text?: 'group' | 'own'; image?: 'group' | 'own' }): GroupView {
    this.mustView(account, slug);
    this.d.site.setModelChoice(account.id, slug, choice);
    return this.mustView(account, slug);
  }

  disband(account: Account, slug: string): void {
    const { site, runtime } = this.d;
    const v = this.mustLead(account, slug);
    if (v.members.length > 1) throw new AppError('VALIDATION_ERROR', '小组里还有其他人，不能解散。先移除他们，或退出小组把组长交给别人。', 409);
    site.deleteTeam(slug);
    runtime.remove(slug);
  }
}

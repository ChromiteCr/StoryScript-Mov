import { randomInt } from 'node:crypto';
import type { GroupPreview, GroupView } from '@storyscript/contracts';
import { AppError } from '../http/errors.ts';
import { generateJoinCode, normalizeJoinCode, showJoinCode, type HostedConfig } from './config.ts';
import { LoginLimiter } from './limiter.ts';
import type { Account, SiteDb } from './site-db.ts';
import type { TeamRuntime } from './teams.ts';

/**
 * Groups on a hosted server. Anyone signed in can start one (and leads it)
 * or join one with its code; a group shares one project. Each account is in
 * at most one group. The leader removes members and replaces the code; when
 * the leader leaves, the earliest-joined member leads; a leader alone can
 * disband the group, which deletes its project.
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

  view(account: Account): GroupView | null {
    const { site, config } = this.d;
    if (!account.team_slug) return null;
    const team = site.team(account.team_slug);
    if (!team) return null;
    return {
      slug: team.slug,
      name: team.name,
      join_code: showJoinCode(team.join_code),
      role: account.team_role ?? 'member',
      members: site.members(team.slug).map((m) => ({
        id: m.id,
        name: m.name,
        role: m.team_role ?? 'member',
        joined_at: m.joined_at ?? m.created_at,
        you: m.id === account.id,
      })),
      max_members: config.limits.max_team_members,
    };
  }

  private fresh(account: Account): Account {
    return this.d.site.accountById(account.id) ?? account;
  }

  private mustView(account: Account): GroupView {
    const v = this.view(this.fresh(account));
    if (!v) throw new AppError('NO_TEAM', '你还没有加入小组。', 409);
    return v;
  }

  private mustLead(account: Account): GroupView {
    const v = this.mustView(account);
    if (v.role !== 'leader') throw new AppError('FORBIDDEN', '只有组长可以这样做。', 403);
    return v;
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
    if (this.fresh(account).team_slug) throw new AppError('VALIDATION_ERROR', '你已经在一个小组里了。要新建小组，先退出现在的小组。', 409);
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
    site.setMembership(account.id, team.slug, 'leader');
    return this.mustView(account);
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
    const members = this.d.site.members(team.slug).length;
    return { name: team.name, members, full: members >= this.d.config.limits.max_team_members };
  }

  /** Join by code; someone already in another group leaves it first. */
  join(account: Account, code: string): GroupView {
    const { site, config } = this.d;
    const team = this.findByCode(account, code);
    const me = this.fresh(account);
    if (me.team_slug === team.slug) return this.mustView(me);
    if (site.members(team.slug).length >= config.limits.max_team_members) {
      throw new AppError('QUOTA_EXCEEDED', `「${team.name}」已经满员（${config.limits.max_team_members} 人）。`, 409);
    }
    if (me.team_slug) this.leave(me);
    site.setMembership(me.id, team.slug, 'member');
    return this.mustView(me);
  }

  leave(account: Account): void {
    const { site } = this.d;
    const v = this.mustView(account);
    const others = site.members(v.slug).filter((m) => m.id !== account.id);
    if (others.length === 0) {
      throw new AppError('VALIDATION_ERROR', '你是这个小组的最后一个人。不再需要的话，请解散小组。', 409);
    }
    site.db.tx(() => {
      site.setMembership(account.id, null, null);
      if (v.role === 'leader') site.setRole(others[0]!.id, 'leader');
    });
  }

  resetCode(account: Account): GroupView {
    const v = this.mustLead(account);
    this.d.site.setJoinCode(v.slug, this.newJoinCode());
    return this.mustView(account);
  }

  removeMember(account: Account, memberId: string): GroupView {
    const { site } = this.d;
    const v = this.mustLead(account);
    if (memberId === account.id) throw new AppError('VALIDATION_ERROR', '不能移除自己；要离开请用"退出小组"。', 409);
    const m = site.accountById(memberId);
    if (!m || m.team_slug !== v.slug) throw new AppError('NOT_FOUND', '这个人已经不在小组里了。', 404);
    site.setMembership(m.id, null, null);
    return this.mustView(account);
  }

  disband(account: Account): void {
    const { site, runtime } = this.d;
    const v = this.mustLead(account);
    if (v.members.length > 1) throw new AppError('VALIDATION_ERROR', '小组里还有其他人，不能解散。先移除他们，或退出小组把组长交给别人。', 409);
    site.deleteTeam(v.slug);
    runtime.remove(v.slug);
  }
}

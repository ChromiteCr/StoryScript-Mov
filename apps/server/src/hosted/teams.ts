import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FOLDER_RECORDS_DIR } from '@storyscript/contracts';
import { createApp } from '../app.ts';
import { ensureStateDir } from '../config/paths.ts';
import { ProjectSession } from '../project/session.ts';
import { generateToken } from '../security/token.ts';
import { teamDir, type HostedConfig } from './config.ts';

/**
 * One app instance per group, each with its own project under
 * <data>/teams/<slug>/. Instances open at start and whenever a group is
 * created; a disbanded group's instance closes and its folder is deleted.
 */

export interface TeamInstance {
  name: string;
  fetch: (req: Request, env?: unknown) => Response | Promise<Response>;
}

export class TeamRuntime {
  private readonly instances = new Map<string, TeamInstance & { session: ProjectSession }>();

  constructor(
    private readonly o: { dataDir: string; webDir: string; config: HostedConfig },
  ) {}

  get(slug: string): TeamInstance | undefined {
    return this.instances.get(slug);
  }

  get size(): number {
    return this.instances.size;
  }

  /** Open (or create) a group's project and its app instance. */
  async open(team: { slug: string; name: string }): Promise<void> {
    if (this.instances.has(team.slug)) return;
    const { config } = this.o;
    const dir = teamDir(this.o.dataDir, team.slug);
    const projectDir = join(dir, 'project');
    const stateDir = ensureStateDir(join(dir, 'state'));
    const session = new ProjectSession(stateDir, { projectRoot: false });
    try {
      if (existsSync(join(projectDir, FOLDER_RECORDS_DIR, 'project.json')) || existsSync(join(projectDir, 'project.json'))) {
        await session.open(projectDir);
      } else {
        await session.create({ dir: projectDir, name: team.name, timezone: config.timezone, default_aspect: '2.39', target_duration_s: null });
      }
    } catch (err) {
      session.closeNow();
      throw err;
    }
    const { app } = createApp({
      mode: 'production',
      port: config.port,
      token: generateToken(),
      webDir: this.o.webDir,
      stateDir,
      projectSession: session,
      hosted: { slug: team.slug, name: team.name, limits: config.limits },
    });
    this.instances.set(team.slug, { name: team.name, fetch: (req, env) => app.fetch(req, env), session });
  }

  /** Close a group's instance and delete its folder (the group was disbanded). */
  remove(slug: string): void {
    const inst = this.instances.get(slug);
    this.instances.delete(slug);
    inst?.session.closeNow();
    rmSync(teamDir(this.o.dataDir, slug), { recursive: true, force: true });
  }

  closeAll(): void {
    for (const inst of this.instances.values()) inst.session.closeNow();
    this.instances.clear();
  }
}

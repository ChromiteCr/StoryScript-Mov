import type { ToolsInfo } from './diagnostics.ts';
import type { ProjectSession } from './project/session.ts';
import type { ServerMode } from './security/guards.ts';
import type { SessionStore } from './security/sessions.ts';

/** Hosted server mode: this app instance serves one team's fixed project. */
export interface HostedTeam {
  slug: string;
  name: string;
}

/** Everything route modules may depend on. Built once by createApp. */
export interface AppDeps {
  mode: ServerMode;
  port: number;
  stateDir: string;
  demo: boolean;
  env: NodeJS.ProcessEnv;
  sessions: SessionStore;
  projectSession: ProjectSession;
  tools: () => Promise<ToolsInfo>;
  chooseFolder: () => Promise<string | null>;
  /** null = the local single-user app */
  hosted: HostedTeam | null;
}

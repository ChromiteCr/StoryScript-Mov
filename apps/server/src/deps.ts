import type { ToolsInfo } from './diagnostics.ts';
import type { ProjectSession } from './project/session.ts';
import type { ServerMode } from './security/guards.ts';
import type { SessionStore } from './security/sessions.ts';

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
}

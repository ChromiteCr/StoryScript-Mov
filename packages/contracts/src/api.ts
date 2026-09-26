import { z } from 'zod';
import { CreateProjectInput, Project, RecentProject } from './project.ts';

/**
 * Local REST API (prefix /api/v1). Internal, not a stable public API.
 * Success: { data }, error: ApiError envelope (common.ts).
 * New routes are added here by the lead, milestone by milestone.
 */

export const SessionInput = z.object({ token: z.string().min(16) });
export type SessionInput = z.infer<typeof SessionInput>;

export const ToolStatus = z.object({
  path: z.string().nullable(),
  version: z.string().nullable(),
});
export type ToolStatus = z.infer<typeof ToolStatus>;

export const HealthInfo = z.object({
  app_version: z.string(),
  node: z.string(),
  sqlite: z.string(),
  ffmpeg: ToolStatus,
  ffprobe: ToolStatus,
  encoders: z.array(z.string()),
  project_open: z.boolean(),
  text_provider_configured: z.boolean(),
  image_provider_configured: z.boolean(),
  demo: z.boolean(),
});
export type HealthInfo = z.infer<typeof HealthInfo>;

export const OpenProjectInput = z.object({ dir: z.string().min(1) });
export type OpenProjectInput = z.infer<typeof OpenProjectInput>;

export const ChooseFolderResult = z.object({ path: z.string().nullable() });
export type ChooseFolderResult = z.infer<typeof ChooseFolderResult>;

export const Api = {
  session: { method: 'POST', path: '/api/v1/session', input: SessionInput },
  health: { method: 'GET', path: '/api/v1/health', output: HealthInfo },
  recentProjects: { method: 'GET', path: '/api/v1/projects/recent', output: z.array(RecentProject) },
  createProject: { method: 'POST', path: '/api/v1/projects', input: CreateProjectInput, output: Project },
  openProject: { method: 'POST', path: '/api/v1/projects/open', input: OpenProjectInput, output: Project },
  closeProject: { method: 'POST', path: '/api/v1/projects/close' },
  currentProject: { method: 'GET', path: '/api/v1/project', output: Project },
  chooseFolder: { method: 'POST', path: '/api/v1/platform/choose-folder', output: ChooseFolderResult },
} as const;

import { realpathSync } from 'node:fs';
import type { CreateProjectInput, Project } from '@storyscript/contracts';
import { touchRecentProject } from '../config/paths.ts';
import { AppError } from '../http/errors.ts';
import { normalizeProjectDir } from './layout.ts';
import { createProject, openProject, type OpenedProject, type ProjectOpOptions } from './project.ts';

/**
 * ProjectSession — the one project this server process has open (plus its DbPort).
 * Open/create/close are serialised so concurrent requests cannot race on locks.
 * Route modules reach the database through `require().db`.
 */
export class ProjectSession {
  private current: OpenedProject | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    private readonly opts: ProjectOpOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.current !== null;
  }

  get(): OpenedProject | null {
    return this.current;
  }

  /** Current project or 409 NO_PROJECT_OPEN. */
  require(): OpenedProject {
    if (!this.current) throw new AppError('NO_PROJECT_OPEN', '当前没有打开的项目', 409);
    return this.current;
  }

  create(input: CreateProjectInput): Promise<Project> {
    return this.serialize(async () => {
      const opened = await createProject(input.dir, input, this.opts);
      return this.swapIn(opened);
    });
  }

  open(dir: string): Promise<Project> {
    return this.serialize(async () => {
      if (this.current && this.current.dir === safeReal(dir)) {
        const project = this.current.project();
        this.remember(this.current.dir, project);
        return project;
      }
      const opened = await openProject(dir, this.opts);
      return this.swapIn(opened);
    });
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      this.closeNow();
    });
  }

  /** Synchronous close for shutdown paths (signal handlers, process exit). */
  closeNow(): void {
    const c = this.current;
    this.current = null;
    c?.close();
  }

  private swapIn(opened: OpenedProject): Project {
    let project: Project;
    try {
      project = opened.project();
    } catch (err) {
      opened.close();
      throw err;
    }
    this.closeNow();
    this.current = opened;
    this.remember(opened.dir, project);
    return project;
  }

  private remember(dir: string, project: Project): void {
    try {
      touchRecentProject(this.stateDir, { dir, name: project.name, opened_at: new Date().toISOString() });
    } catch (err) {
      console.warn('[storyscript-mov] 无法写入最近项目列表：', (err as Error).message);
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** realpath of a user-supplied dir, or null if it cannot be resolved. */
function safeReal(dir: string): string | null {
  try {
    return realpathSync(normalizeProjectDir(dir));
  } catch {
    return null;
  }
}

import path from 'node:path';

import type { EventStore } from '../store/event-store.js';
import type { AgentSession } from '../types/session.js';
import { activityOf, type Project, type ProjectActivity } from './project.js';
import {
  projectIdFor,
  resolveRepository,
  type RepositoryResolution,
} from './repository-identity.js';

export interface ProjectServiceOptions {
  store: EventStore;
  /**
   * Every session Vowe currently knows about.
   *
   * A callback rather than a registry, matching how `ContextNavigator` takes
   * `resolveCwd` and `ObserverRunner` takes `getSession` — so this service holds
   * no adapter, names no provider, and cannot reach a worker.
   */
  listSessions: () => AgentSession[];
  onError?: (scope: string, error: unknown) => void;
}

export interface ProjectAssignment {
  project: Project;
  worktree?: string;
  branch?: string;
}

/**
 * Groups sessions into the repositories they are working in.
 *
 * Projects are Vowe product state, not a coding-agent concept: this service
 * knows about directories and repositories, and nothing about Claude Code or
 * any other provider.
 *
 * The only thing persisted is identity. Membership lives on the sessions, and
 * counts and activity are recomputed on every read, so a project's view of its
 * work is incapable of disagreeing with the sessions themselves.
 */
export class ProjectService {
  private readonly store: EventStore;
  private readonly listSessions: () => AgentSession[];
  private readonly onError: (scope: string, error: unknown) => void;

  /**
   * Resolution results by directory.
   *
   * `undefined` means not yet looked at; a stored `null` means we looked and
   * found nothing usable, so an unreadable directory is not re-probed every
   * reconcile.
   */
  private readonly byCwd = new Map<string, RepositoryResolution | null>();
  /** Deduplicates concurrent lookups of the same directory. */
  private readonly inFlight = new Map<string, Promise<RepositoryResolution | null>>();

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.listSessions = options.listSessions;
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * Find or create the project a session belongs to.
   *
   * Callers are expected to skip this entirely for a session whose `cwd` has
   * not changed — see `needsResolution`. Within a run, each distinct directory
   * costs one `git` invocation regardless of how many sessions share it.
   */
  async resolveForSession(session: AgentSession): Promise<ProjectAssignment | null> {
    const cwd = session.cwd;
    if (!cwd) return null;

    const resolution = await this.resolveCwd(cwd);
    if (!resolution) return null;

    const project = await this.upsert(resolution);
    const assignment: ProjectAssignment = { project };
    // Only interesting when it differs from the project's own root; recording
    // it always would make every session look like it was in a worktree.
    if (!resolution.location.isPrimaryWorktree) {
      assignment.worktree = resolution.location.worktreePath;
    }
    if (resolution.location.branch) assignment.branch = resolution.location.branch;
    return assignment;
  }

  /**
   * Whether a session needs resolving at all.
   *
   * Reconciliation runs every few seconds for every session, and shelling out
   * to git on that cadence would be waste. A session that is already assigned
   * and has not moved is answered with a string comparison.
   */
  needsResolution(session: AgentSession, previous: AgentSession | null): boolean {
    if (!session.cwd) return false;
    if (!previous) return true;
    if (previous.projectId === null || previous.projectId === undefined) return true;
    return previous.cwd !== session.cwd;
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  getProject(projectId: string): Project | null {
    return this.store.getProject(projectId);
  }

  /** Derived, every time. Membership is recorded on the sessions. */
  getSessions(projectId: string): AgentSession[] {
    return this.listSessions().filter((session) => session.projectId === projectId);
  }

  /** Derived, every time. Nothing here is stored or cached. */
  activityFor(projectId: string): ProjectActivity {
    return activityOf(this.getSessions(projectId));
  }

  /**
   * Projects with their display names disambiguated.
   *
   * Two unrelated repositories can both be called `api`. Showing both as `api`
   * is confusing, but qualifying every project with its parent directory is
   * noise — so names are only expanded when they actually collide.
   */
  listProjectsForDisplay(): Project[] {
    const projects = this.listProjects();
    const counts = new Map<string, number>();
    for (const project of projects) {
      counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
    }
    return projects.map((project) =>
      (counts.get(project.name) ?? 0) > 1
        ? { ...project, name: qualify(project) }
        : project,
    );
  }

  // ----------------------------------------------------------------- private

  private async resolveCwd(cwd: string): Promise<RepositoryResolution | null> {
    const cached = this.byCwd.get(cwd);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(cwd);
    if (existing) return existing;

    const lookup = resolveRepository(cwd)
      .catch((error) => {
        this.onError('project:resolve', error);
        return null;
      })
      .then((resolution) => {
        // Negative results are cached too: a directory that cannot be read is
        // not going to become readable on the next five-second pass.
        this.byCwd.set(cwd, resolution);
        this.inFlight.delete(cwd);
        return resolution;
      });

    this.inFlight.set(cwd, lookup);
    return lookup;
  }

  private async upsert(resolution: RepositoryResolution): Promise<Project> {
    const id = projectIdFor(resolution.project);
    const existing = this.store.getProject(id);
    if (existing) return existing;

    const project: Project = {
      id,
      name: resolution.project.name,
      repoRoot: resolution.project.repoRoot,
      createdAt: new Date().toISOString(),
    };
    if (resolution.project.gitCommonDir) {
      project.gitCommonDir = resolution.project.gitCommonDir;
    }
    if (resolution.project.remoteUrl) project.remoteUrl = resolution.project.remoteUrl;

    await this.store.upsertProject(project);
    return this.store.getProject(id) ?? project;
  }
}

/** `…/services/api` → `services/api`. Enough to tell two `api`s apart. */
function qualify(project: Project): string {
  const parent = path.basename(path.dirname(project.repoRoot));
  return parent ? `${parent}/${project.name}` : project.name;
}

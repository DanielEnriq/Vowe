import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { EventStore } from '../store/event-store.js';
import type { AgentSession } from '../types/session.js';
import { isWithinFolder } from './folder-label.js';
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

export interface CreateProjectInput {
  name: string;
  /** Any folder in the repository; the project's default folder is its root. */
  folder: string;
  /** Folders beyond the default, added in the same act. */
  folders?: string[];
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
 * The only thing persisted is identity, plus what the developer chose on top
 * of it: a name, extra folders, whether it is removed. Membership lives on the
 * sessions, and counts and activity are recomputed on every read, so a
 * project's view of its work is incapable of disagreeing with the sessions
 * themselves.
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
  /**
   * Every added (non-default) folder of a project that is not removed. Read on
   * every reconcile, so kept here, and dropped whenever the store says a
   * project changed — by this service or by anything else.
   */
  private addedFolders: { path: string; projectId: string }[] | null = null;
  /** Directories placed by an added folder, and the project they went to. */
  private readonly placedByFolder = new Map<string, string>();
  /** A session's directory with symlinks resolved, as folders are stored. */
  private readonly realCwd = new Map<string, string>();

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.listSessions = options.listSessions;
    this.onError = options.onError ?? (() => undefined);
    this.store.onProjectsChanged(() => {
      this.addedFolders = null;
    });
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

    // A folder added to a project claims what is under it, ahead of whichever
    // repository the directory happens to be in.
    if (!this.realCwd.has(cwd)) this.realCwd.set(cwd, await canonical(cwd));
    const owner = this.ownerOf(cwd);
    const owned = owner ? this.store.getProject(owner) : null;
    if (owned) {
      this.placedByFolder.set(cwd, owned.id);
      return { project: owned };
    }
    this.placedByFolder.delete(cwd);

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
   * and has not moved is answered from memory.
   */
  needsResolution(session: AgentSession, previous: AgentSession | null): boolean {
    if (!session.cwd) return false;
    if (!previous) return true;
    if (previous.projectId === null || previous.projectId === undefined) return true;
    if (previous.cwd !== session.cwd) return true;
    // Folders are added and removed while a session sits still.
    const owner = this.ownerOf(session.cwd);
    if (owner) return owner !== previous.projectId;
    return this.placedByFolder.get(session.cwd) === previous.projectId;
  }

  /**
   * The project a directory belongs to, found or created.
   *
   * How a developer opens a project nobody has run a session in yet: the same
   * resolution sessions go through, so opening a subdirectory or a worktree
   * lands on the repository it is part of rather than on a project of its own.
   */
  async projectAt(directory: string): Promise<Project | null> {
    const resolution = await this.resolveCwd(directory);
    return resolution ? this.upsert(resolution) : null;
  }

  /** Every project, removed ones included. */
  listProjects(): Project[] {
    return this.store.listProjects();
  }

  getProject(projectId: string): Project | null {
    return this.store.getProject(projectId);
  }

  /**
   * Make a project: a folder, and a name for it.
   *
   * The identity is still derived from the folder's repository, so creating a
   * project at a folder Vowe already knows names that project rather than
   * making a second one — and brings it back if it was removed. Every folder
   * is checked before anything is written.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const folder = await canonical(input.folder);
    const project = await this.projectAt(folder);
    if (!project) throw new Error(`Could not open ${folder}`);

    const extras: string[] = [];
    for (const candidate of input.folders ?? []) {
      const extra = await canonical(candidate);
      if (project.folders.some((existing) => existing.path === extra)) continue;
      if (extras.includes(extra)) continue;
      this.checkFolder(project.id, extra);
      extras.push(extra);
    }

    await this.store.setProjectOpen(project.id, true);
    await this.store.setProjectName(project.id, nameOverride(input.name, project));
    for (const extra of extras) await this.store.addProjectFolder(project.id, extra);
    return this.require(project.id);
  }

  /** An empty name goes back to the one derived from the repository. */
  async renameProject(projectId: string, name: string): Promise<Project> {
    const project = this.require(projectId);
    await this.store.setProjectName(projectId, nameOverride(name, project));
    return this.require(projectId);
  }

  /**
   * Hide a project, and keep it hidden across restarts. Its sessions keep its
   * id; creating or opening it again brings it back.
   */
  async removeProject(projectId: string): Promise<void> {
    this.require(projectId);
    await this.store.setProjectRemoved(projectId, true);
  }

  /**
   * Add a folder to a project. Never automatic.
   *
   * Rejected when another project already has it, or when it overlaps a
   * folder another project added — either would leave a session under it
   * with two projects to belong to.
   */
  async addFolder(projectId: string, folder: string): Promise<Project> {
    const project = this.require(projectId);
    const absolute = await canonical(folder);
    if (project.folders.some((existing) => existing.path === absolute)) {
      throw new Error('That folder is already in this project.');
    }
    this.checkFolder(projectId, absolute);
    await this.store.addProjectFolder(projectId, absolute);
    return this.require(projectId);
  }

  /** Any folder but the default, which is where the identity comes from. */
  async removeFolder(projectId: string, folder: string): Promise<Project> {
    const project = this.require(projectId);
    const match = project.folders.find((existing) => existing.path === folder);
    if (!match) throw new Error('That folder is not in this project.');
    if (match.isDefault) throw new Error('The root folder cannot be removed.');
    await this.store.removeProjectFolder(projectId, folder);
    return this.require(projectId);
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
   * Projects with their display names disambiguated, removed ones left out.
   *
   * Two unrelated repositories can both be called `api`. Showing both as `api`
   * is confusing, but qualifying every project with its parent directory is
   * noise — so names are only expanded when they actually collide, and a
   * name the developer chose is shown as they wrote it.
   */
  listProjectsForDisplay(): Project[] {
    const projects = this.listProjects().filter((project) => !project.removedAt);
    const counts = new Map<string, number>();
    for (const project of projects) {
      counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
    }
    return projects.map((project) =>
      (counts.get(project.name) ?? 0) > 1 && !project.displayName
        ? { ...project, name: qualify(project) }
        : project,
    );
  }

  // ----------------------------------------------------------------- private

  private require(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`No project ${projectId}`);
    return project;
  }

  private ownerOf(cwd: string): string | null {
    const real = this.realCwd.get(cwd);
    return this.folderOwner(cwd) ?? (real && real !== cwd ? this.folderOwner(real) : null);
  }

  /** The project whose added folder holds a directory. The deepest wins. */
  private folderOwner(directory: string): string | null {
    this.addedFolders ??= this.store
      .listProjects()
      .filter((project) => !project.removedAt)
      .flatMap((project) =>
        project.folders
          .filter((folder) => !folder.isDefault)
          .map((folder) => ({ path: folder.path, projectId: project.id })),
      );
    let best: { path: string; projectId: string } | null = null;
    for (const folder of this.addedFolders) {
      if (!isWithinFolder(directory, folder.path)) continue;
      if (!best || folder.path.length > best.path.length) best = folder;
    }
    return best?.projectId ?? null;
  }

  /** Throws when a folder may not join `projectId`. See `addFolder`. */
  private checkFolder(projectId: string, folder: string): void {
    for (const other of this.store.listProjects()) {
      if (other.id === projectId || other.removedAt) continue;
      for (const existing of other.folders) {
        const taken =
          existing.path === folder ||
          (!existing.isDefault &&
            (isWithinFolder(folder, existing.path) || isWithinFolder(existing.path, folder)));
        if (taken) throw new Error(`That folder is already in ${other.name}.`);
      }
    }
  }

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
      folders: [],
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

/** Absolute and with symlinks resolved, so one folder has one spelling. */
async function canonical(folder: string): Promise<string> {
  const absolute = path.resolve(folder);
  return realpath(absolute).catch(() => absolute);
}

/** `null` — the derived name — when the name is empty or says nothing new. */
function nameOverride(name: string, project: Project): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!project.displayName && trimmed === project.name) return null;
  return trimmed;
}

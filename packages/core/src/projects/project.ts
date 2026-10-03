import type { AgentSession } from '../types/session.js';

/**
 * The durable parent of agent sessions.
 *
 * A Project is a repository. Several agents working in the same codebase belong
 * to the same Project, whichever worktree or subdirectory each one sits in.
 *
 * Note what is **not** here: no session list, no counts, no activity timestamp,
 * no status. This record holds identity and nothing else — the things that
 * change only when the repository itself moves or is renamed. Everything about
 * what is happening right now is derived from the sessions on every read, so
 * there is one source of truth and nothing that can go stale.
 */
export interface Project {
  /** Stable and opaque. Derived from the repository, not allocated. */
  id: string;
  /**
   * Display name. The developer's own when they gave one (see `displayName`),
   * otherwise the repository's, disambiguated only on collision.
   */
  name: string;
  /** The name the developer gave it. Absent means the derived name is shown. */
  displayName?: string;
  /** The main worktree. Metadata — the path is not the identity. */
  repoRoot: string;
  gitCommonDir?: string;
  remoteUrl?: string;
  createdAt: string;
  /**
   * When the developer opened it in the projects panel. Absent means closed,
   * which is where every discovered project starts. Attention, not identity.
   */
  openedAt?: string;
  /**
   * When the developer removed it. A removed project is hidden everywhere and
   * stays hidden across restarts; creating a project at the same folder
   * brings it back with what it had.
   */
  removedAt?: string;
  /**
   * The folders the project's work happens in. The first is the default — the
   * repository root, from which the identity is derived. Any other was added
   * by hand; none is ever added automatically.
   */
  folders: ProjectFolder[];
}

export interface ProjectFolder {
  /** Absolute. */
  path: string;
  /** The repository root. Exactly one per project, and it cannot be removed. */
  isDefault: boolean;
  addedAt: string;
}

/** What discovery knows about a project: identity, and nothing the developer chose. */
export type ProjectRecord = Omit<Project, 'displayName' | 'openedAt' | 'removedAt' | 'folders'>;

/**
 * What is happening in a project right now.
 *
 * Computed on demand, never written to disk. Counts cannot drift out of
 * agreement with the sessions because there is nothing to invalidate.
 */
export interface ProjectActivity {
  activeSessions: number;
  recentSessions: number;
  lastActivityAt: string | null;
}

/** A session counts as active while it is still doing something. */
export function isActiveSession(session: AgentSession): boolean {
  return (
    session.status === 'working' ||
    session.status === 'waiting' ||
    session.status === 'starting'
  );
}

export function activityOf(sessions: AgentSession[]): ProjectActivity {
  let lastActivityAt: string | null = null;
  let activeSessions = 0;

  for (const session of sessions) {
    if (isActiveSession(session)) activeSessions += 1;
    if (
      lastActivityAt === null ||
      Date.parse(session.lastActivityAt) > Date.parse(lastActivityAt)
    ) {
      lastActivityAt = session.lastActivityAt;
    }
  }

  return {
    activeSessions,
    recentSessions: sessions.length - activeSessions,
    lastActivityAt,
  };
}

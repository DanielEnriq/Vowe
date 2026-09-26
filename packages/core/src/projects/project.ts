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
  /** Display name, from the repository. Disambiguated only on collision. */
  name: string;
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
}

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

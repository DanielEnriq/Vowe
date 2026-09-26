import type { AgentSession, Project } from '@vowe/core';

/**
 * Which projects the panel shows.
 *
 * Projects are discovered, not chosen — every repository a worker has ever run
 * in becomes one — so being in the panel is opt-in. A project starts closed,
 * is opened from the `+` beside the panel's heading (a discovered one, or any
 * folder by path), and is closed again from its row. Nothing is deleted either
 * way.
 */
export function isOpenProject(project: Project): boolean {
  return Boolean(project.openedAt);
}

/**
 * The open projects, plus the one being looked at.
 *
 * The exception is the one the session list makes: a room you are in whose
 * project is missing from the panel beside it is the panel lying about where
 * you are.
 */
export function panelProjects(
  projects: readonly Project[],
  lookingAt: string | null,
): Project[] {
  return projects.filter((project) => isOpenProject(project) || project.id === lookingAt);
}

/**
 * What the `+` offers: every closed project, most recently active first.
 *
 * Matched on what a person can see — the name and where it lives.
 */
export function closedProjects(
  projects: readonly Project[],
  sessions: readonly AgentSession[],
  query = '',
): Project[] {
  const needle = query.trim().toLowerCase();
  const latest = lastActivityByProject(sessions);
  return projects
    .filter((project) => !isOpenProject(project))
    .filter(
      (project) =>
        !needle ||
        project.name.toLowerCase().includes(needle) ||
        project.repoRoot.toLowerCase().includes(needle),
    )
    .sort((a, b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0));
}

/** When each project's work last moved, for ordering and for the ages shown. */
export function lastActivityByProject(sessions: readonly AgentSession[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const session of sessions) {
    if (!session.projectId) continue;
    const at = Date.parse(session.lastActivityAt);
    if (Number.isNaN(at)) continue;
    if (at > (latest.get(session.projectId) ?? 0)) latest.set(session.projectId, at);
  }
  return latest;
}

/** Typed text that is a folder rather than a search: absolute, or from home. */
export function looksLikePath(query: string): boolean {
  const text = query.trim();
  return text.startsWith('/') || text === '~' || text.startsWith('~/');
}

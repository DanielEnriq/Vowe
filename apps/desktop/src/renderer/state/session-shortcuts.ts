import type { AgentSession, Project } from '@vowe/core';

import { currentSessions } from './session-visibility.js';
import { sessionsForProject } from './navigation.js';

export interface SessionShortcutOptions {
  projects: readonly Project[];
  sessions: readonly AgentSession[];
  expandedProjectIds: readonly string[];
  now: number;
  openSessionId?: string | null;
  limit?: number;
}

/**
 * Numbered session targets in the same order the projects panel draws them.
 *
 * The shortcut is spatial: holding Command should label the sessions already in
 * the panel, and pressing the number on that label should open that session.
 */
export function sessionShortcutTargets(options: SessionShortcutOptions): AgentSession[] {
  const limit = options.limit ?? 9;
  const targets: AgentSession[] = [];
  const add = (items: readonly AgentSession[]) => {
    for (const session of items) {
      if (targets.length >= limit) return;
      targets.push(session);
    }
  };

  for (const project of options.projects) {
    if (!options.expandedProjectIds.includes(project.id)) continue;
    add(
      currentSessions(sessionsForProject(project.id, options.sessions), {
        now: options.now,
        openSessionId: options.openSessionId,
      }),
    );
    if (targets.length >= limit) return targets;
  }

  add(
    currentSessions(
      options.sessions.filter((session) => session.projectId === null),
      { now: options.now, openSessionId: options.openSessionId },
    ),
  );

  return targets;
}

export function sessionShortcutNumbers(targets: readonly AgentSession[]): Map<string, number> {
  return new Map(targets.map((session, index) => [session.id, index + 1]));
}

import type { AgentSession } from '@vowe/core';

/**
 * Which sessions are part of what is going on now.
 *
 * A coding worker leaves a session behind every time it is run, and after a
 * few weeks the projects panel is a list of things nobody is doing. So the
 * panel shows recent work and puts the rest out of the way — not deleted, not
 * unobserved, just not in front of you. Everything else is still there and is
 * reached by looking for it, which is what the search on a project row is for.
 *
 * Two reasons a session is out of the way, and they are different: it has not
 * been touched in a week, or somebody put it away deliberately. The second
 * survives new activity; the first does not.
 */
export const RECENT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface VisibilityOptions {
  /** Now, injected so this stays a function of its arguments. */
  now: number;
  /**
   * The session the developer is looking at.
   *
   * Always listed, whatever its age or archive state. A session you have open
   * and cannot find in the panel beside it is the panel lying about where you
   * are — and it is also what "unless you look it up and open it" means: the
   * looking-up is the search, and opening is what brings it back.
   */
  openSessionId?: string | null;
}

/** Touched within the window, by the worker or by anybody. */
export function isRecent(session: AgentSession, now: number): boolean {
  const at = Date.parse(session.lastActivityAt);
  // An unparseable date is not evidence of age, so it does not hide anything.
  if (Number.isNaN(at)) return true;
  return now - at <= RECENT_DAYS * DAY_MS;
}

export function isArchived(session: AgentSession): boolean {
  return Boolean(session.archivedAt);
}

/** Worth showing among the things going on now. */
export function isCurrent(session: AgentSession, options: VisibilityOptions): boolean {
  if (options.openSessionId && session.id === options.openSessionId) return true;
  return !isArchived(session) && isRecent(session, options.now);
}

export function currentSessions(
  sessions: readonly AgentSession[],
  options: VisibilityOptions,
): AgentSession[] {
  return sessions.filter((session) => isCurrent(session, options));
}

/**
 * What the search offers: everything, newest first.
 *
 * Deliberately not filtered by the rule above — the search exists precisely to
 * reach what the rule put away, so hiding anything here would leave it with
 * nowhere to be found.
 */
export function searchSessions(
  sessions: readonly AgentSession[],
  query: string,
): AgentSession[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? sessions.filter((session) => sessionText(session).includes(needle))
    : [...sessions];
  return matched.sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
}

/** Matched on what a person can see, not on ids they have never read. */
function sessionText(session: AgentSession): string {
  return [session.generatedTitle, session.displayLabel, session.task, session.branch]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

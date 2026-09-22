/**
 * Which projects are showing their sessions.
 *
 * Disclosure is not selection, and this module exists to keep them apart. A
 * developer watching two repositories wants both open at once; expanding one
 * is not a statement that they have stopped caring about the other, and
 * clicking a session in one must not fold the one beside it. The sidebar used
 * to derive expansion from the route, which made those three acts the same act.
 *
 * A list rather than a `Set` because it is persisted verbatim, and because
 * every operation here is small: this is a handful of repository ids, not an
 * index.
 */

/** One key, one shape. Anything else that was there is treated as absent. */
const KEY = 'vowe.sidebar.expanded';

/** Already open, and still open. Adding twice is not an event. */
export function withExpanded(expanded: readonly string[], projectId: string): string[] {
  return expanded.includes(projectId) ? [...expanded] : [...expanded, projectId];
}

export function withoutExpanded(expanded: readonly string[], projectId: string): string[] {
  return expanded.filter((id) => id !== projectId);
}

export function toggleExpanded(expanded: readonly string[], projectId: string): string[] {
  return expanded.includes(projectId)
    ? withoutExpanded(expanded, projectId)
    : withExpanded(expanded, projectId);
}

/**
 * Forget projects that are no longer here.
 *
 * A repository Vowe no longer sees would otherwise keep its row in the stored
 * list forever, and a list that only grows is a leak with a friendly name.
 */
export function prune(expanded: readonly string[], projectIds: readonly string[]): string[] {
  return expanded.filter((id) => projectIds.includes(id));
}

/**
 * What survived the last session, if anything did.
 *
 * Every failure mode — no storage, blocked storage, a hand-edited value, a
 * value written by an older version — is the same outcome: nothing expanded.
 * A sidebar is not worth an exception.
 */
export function readExpanded(): string[] {
  try {
    const raw = window.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function writeExpanded(expanded: readonly string[]): void {
  try {
    window.localStorage?.setItem(KEY, JSON.stringify(expanded));
  } catch {
    // The list still stands for this run. Nothing on screen depends on it
    // having been written.
  }
}

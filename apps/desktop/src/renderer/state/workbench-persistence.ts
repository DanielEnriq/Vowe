import { formatRef, parseRef } from '@vowe/core/refs';
import type { PersistedWorkbench } from '@vowe/core';

import type { WorkbenchState, WorkbenchTab } from './workbench.js';

/**
 * What survives a restart, and nothing else.
 *
 * Addresses, the names they had, and which one was in front. No artifact
 * content ever crosses into this: a persisted desk is a list of places to
 * look, so a desk restored next week shows the file as it is then rather than
 * as a snapshot of what it said when somebody opened it.
 */
export function persistDesk(state: WorkbenchState): PersistedWorkbench {
  return {
    tabs: state.tabs.map((tab) => ({
      ref: tab.id,
      title: tab.title,
      status: tab.status,
    })),
    activeId: state.activeId,
  };
}

/**
 * A stored desk, back as tabs.
 *
 * Every tab comes back unresolved: the strip draws from the names it kept, and
 * the artifacts are read when somebody looks at them.
 *
 * An address that no longer *parses* is dropped, because nothing can be done
 * with one. An address that parses but no longer *resolves* is kept — a
 * deleted file becomes a tab that says so, which is the honest outcome. The
 * one thing a restore must never do is quietly lose a tab somebody left open.
 */
export function restoreTabs(desk: PersistedWorkbench | null): WorkbenchTab[] {
  if (!desk) return [];
  const tabs: WorkbenchTab[] = [];
  for (const stored of desk.tabs) {
    const ref = parseRef(stored.ref);
    if (!ref) continue;
    tabs.push({
      id: formatRef(ref),
      sourceRef: ref,
      title: stored.title,
      status: stored.status,
      artifact: null,
    });
  }
  return tabs;
}

/** The tab a restored desk should show, or null when it named nothing kept. */
export function restoredActiveId(
  desk: PersistedWorkbench | null,
  tabs: WorkbenchTab[],
): string | null {
  const activeId = desk?.activeId ?? null;
  return activeId && tabs.some((tab) => tab.id === activeId) ? activeId : null;
}

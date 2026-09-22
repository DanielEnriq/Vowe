import type { WorkbenchArtifact } from '@vowe/core';

/**
 * What Vowe and the developer are currently looking at.
 *
 * Renderer-local and session-scoped on purpose: the desk is where attention
 * is, not what happened, and nothing here is worth surviving a restart. It is
 * a reducer rather than a set of hooks so the rules below can be stated once
 * and tested without a window.
 */
export interface WorkbenchState {
  activeId: string | null;
  items: WorkbenchArtifact[];
  /** Pinned means Vowe may add, but may not take the view away. */
  pinnedId: string | null;
  open: boolean;
  /** Added since the developer last looked at them. Drives the dot. */
  newIds: string[];
  /**
   * The developer closed the desk, and Vowe has not been invited back.
   *
   * Surfacing keeps working while this is set — artifacts still arrive, and
   * still raise the unseen dot — but none of them may reopen the panel. A
   * panel that reappears the moment after it is closed is not a panel the
   * developer controls.
   */
  dismissed: boolean;
  /**
   * Why the current view is being shown, when that is actually known.
   *
   * Desk state rather than a property of the artifact: the same file can be on
   * the desk because an answer cited it, or because somebody clicked it in a
   * diff, and the artifact itself is identical in both cases. Absent whenever
   * there is no honest answer.
   */
  reason: string | null;
}

export const EMPTY_WORKBENCH: WorkbenchState = {
  activeId: null,
  items: [],
  pinnedId: null,
  open: false,
  newIds: [],
  dismissed: false,
  reason: null,
};

export type WorkbenchAction =
  /**
   * The developer asked for this. It always wins: they are looking at the
   * thing they just clicked, pin or no pin.
   */
  | { type: 'open'; artifact: WorkbenchArtifact; reason?: string }
  /**
   * Vowe put this on the desk because an answer was grounded in it.
   *
   * `show` takes the view unless something is pinned; `suggest` only ever adds
   * to the stack. Neither may evict a pinned artifact, because the developer
   * pinning something is them saying what they want to keep looking at.
   */
  | {
      type: 'surface';
      artifact: WorkbenchArtifact;
      level: 'show' | 'suggest';
      reason?: string;
    }
  | { type: 'activate'; id: string }
  | { type: 'togglePin' }
  | { type: 'setOpen'; open: boolean }
  | { type: 'close' }
  /** A different session has a different desk. */
  | { type: 'reset' };

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case 'open': {
      const items = withArtifact(state.items, action.artifact);
      return {
        ...state,
        items,
        activeId: action.artifact.id,
        open: true,
        // Asking for something is inviting the desk back.
        dismissed: false,
        reason: action.reason ?? null,
        newIds: state.newIds.filter((id) => id !== action.artifact.id),
      };
    }

    case 'surface': {
      const items = withArtifact(state.items, action.artifact);
      const held = state.pinnedId !== null && state.pinnedId !== action.artifact.id;
      const takesView = action.level === 'show' && !held;
      // A dismissed desk still collects; it simply does not reappear.
      const opens = takesView && !state.dismissed;

      return {
        ...state,
        items,
        activeId: takesView ? action.artifact.id : state.activeId,
        open: opens ? true : state.open,
        ...(takesView ? { reason: action.reason ?? null } : {}),
        newIds:
          takesView && state.open
            ? state.newIds.filter((id) => id !== action.artifact.id)
            : addOnce(state.newIds, action.artifact.id),
      };
    }

    case 'activate':
      if (!state.items.some((item) => item.id === action.id)) return state;
      return {
        ...state,
        activeId: action.id,
        open: true,
        dismissed: false,
        reason: null,
        newIds: state.newIds.filter((id) => id !== action.id),
      };

    case 'togglePin':
      if (!state.activeId) return state;
      return {
        ...state,
        pinnedId: state.pinnedId === state.activeId ? null : state.activeId,
      };

    case 'setOpen':
      return {
        ...state,
        open: action.open,
        dismissed: !action.open,
        // Opening the desk is looking at it: nothing on it is unseen after
        // that, which is what retires the dot on the rail.
        newIds: action.open ? [] : state.newIds,
      };

    /** Closing hides the desk; it does not clear it. */
    case 'close':
      return { ...state, open: false, dismissed: true };

    case 'reset':
      return EMPTY_WORKBENCH;
  }
}

/**
 * Artifact ids are `formatRef(sourceRef)`, so opening the same thing twice is
 * the same entry rather than a duplicate — the desk needs no handle table.
 * A re-opened artifact replaces the old copy, because its content may have
 * moved on since it was first read.
 */
function withArtifact(
  items: WorkbenchArtifact[],
  artifact: WorkbenchArtifact,
): WorkbenchArtifact[] {
  const index = items.findIndex((item) => item.id === artifact.id);
  if (index === -1) return [...items, artifact];
  const next = [...items];
  next[index] = artifact;
  return next;
}

function addOnce(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

export function activeArtifact(state: WorkbenchState): WorkbenchArtifact | null {
  return state.items.find((item) => item.id === state.activeId) ?? null;
}

/**
 * Is there something here the developer has not looked at?
 *
 * A boolean rather than a count, deliberately. How many artifacts are on the
 * desk is bookkeeping the desk does for itself; the only part of it worth
 * putting in the window's chrome is whether anything new arrived.
 */
export function deskHasUnseen(state: WorkbenchState): boolean {
  return state.newIds.length > 0;
}

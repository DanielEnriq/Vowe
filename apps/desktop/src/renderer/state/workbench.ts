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
}

export const EMPTY_WORKBENCH: WorkbenchState = {
  activeId: null,
  items: [],
  pinnedId: null,
  open: false,
  newIds: [],
};

export type WorkbenchAction =
  /**
   * The developer asked for this. It always wins: they are looking at the
   * thing they just clicked, pin or no pin.
   */
  | { type: 'open'; artifact: WorkbenchArtifact }
  /**
   * Vowe put this on the desk because an answer was grounded in it.
   *
   * `show` takes the view unless something is pinned; `suggest` only ever adds
   * to the stack. Neither may evict a pinned artifact, because the developer
   * pinning something is them saying what they want to keep looking at.
   */
  | { type: 'surface'; artifact: WorkbenchArtifact; level: 'show' | 'suggest' }
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
        newIds: state.newIds.filter((id) => id !== action.artifact.id),
      };
    }

    case 'surface': {
      const items = withArtifact(state.items, action.artifact);
      const held = state.pinnedId !== null && state.pinnedId !== action.artifact.id;
      const takesView = action.level === 'show' && !held;

      return {
        ...state,
        items,
        activeId: takesView ? action.artifact.id : state.activeId,
        open: takesView ? true : state.open,
        newIds: takesView
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
        newIds: state.newIds.filter((id) => id !== action.id),
      };

    case 'togglePin':
      if (!state.activeId) return state;
      return {
        ...state,
        pinnedId: state.pinnedId === state.activeId ? null : state.activeId,
      };

    case 'setOpen':
      return { ...state, open: action.open };

    /** Closing hides the desk; it does not clear it. */
    case 'close':
      return { ...state, open: false };

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

/** The workbench button only exists once there is something on the desk. */
export function deskCount(state: WorkbenchState): number {
  return state.items.length;
}

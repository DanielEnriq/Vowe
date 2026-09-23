import type { ContextRef, WorkbenchArtifact } from '@vowe/core';

/**
 * Whose tab this is.
 *
 * `preview` is Vowe's one scratch slot: it surfaced this while answering, and
 * the next thing it surfaces takes the slot back. `durable` is a tab somebody
 * opened or kept, and Vowe never recycles it.
 *
 * There is no third rung. "Vowe may not take the view away" used to be a pin;
 * it is now simply what happens when you are looking at a durable tab.
 */
export type TabStatus = 'preview' | 'durable';

export interface WorkbenchTab {
  /** `formatRef(sourceRef)`. The tab's identity and the artifact's, one string. */
  id: string;
  sourceRef: ContextRef;
  title: string;
  status: TabStatus;
  /**
   * Null until the ref has been resolved.
   *
   * A restored desk is a list of addresses and the names they had last time:
   * the strip draws before a single file has been read, and a tab nobody
   * clicks is never read at all.
   */
  artifact: WorkbenchArtifact | null;
}

/**
 * What Vowe and the developer are currently looking at.
 *
 * Tabs rather than one view with a stack beneath it: the things worth looking
 * at during a piece of work are several, they are returned to, and they are
 * the developer's to keep or close. It is a reducer rather than a set of hooks
 * so the rules below can be stated once and tested without a window.
 *
 * Order is the order things arrived, left to right. The one uniqueness
 * invariant is that at most one tab is a `preview`.
 */
export interface WorkbenchState {
  tabs: WorkbenchTab[];
  activeId: string | null;
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
  tabs: [],
  activeId: null,
  open: false,
  newIds: [],
  dismissed: false,
  reason: null,
};

export type WorkbenchAction =
  /**
   * The developer asked for this: from the launcher, from the trace, from the
   * empty state. It always wins — it takes the view, and it makes the tab
   * durable, because asking for something is keeping it.
   */
  | { type: 'open'; artifact: WorkbenchArtifact; reason?: string }
  /**
   * Vowe put this on the desk because an answer was grounded in it.
   *
   * At most one tab at a time is Vowe's, and the next thing it surfaces takes
   * that slot back. Whether it also takes the *view* is a separate question,
   * answered below: it does not, once the developer is reading their own tab.
   */
  | { type: 'surface'; artifact: WorkbenchArtifact; reason?: string }
  | { type: 'activate'; id: string }
  /** "I am keeping this one." Promotes Vowe's preview to the developer's tab. */
  | { type: 'keep'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'setOpen'; open: boolean }
  | { type: 'close' }
  /** The desk this session was left on, restored. Addresses, not content. */
  | { type: 'hydrate'; tabs: WorkbenchTab[]; activeId: string | null }
  /** A tab's address has been resolved into something to look at. */
  | { type: 'resolved'; id: string; artifact: WorkbenchArtifact }
  /** A different session has a different desk. */
  | { type: 'reset' };

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case 'open': {
      return {
        ...state,
        tabs: place(state.tabs, action.artifact, 'durable'),
        activeId: action.artifact.id,
        open: true,
        // Asking for something is inviting the desk back.
        dismissed: false,
        reason: action.reason ?? null,
        newIds: state.newIds.filter((id) => id !== action.artifact.id),
      };
    }

    case 'surface': {
      const replaced = replacedPreview(state, action.artifact.id);
      /*
       * Vowe moves the view when the developer is looking at nothing, or at
       * Vowe's own scratch slot. The moment they are reading a tab they opened,
       * it does not: an answer that yanked the desk out from under somebody
       * mid-read would be worse than one that said nothing.
       */
      const takesView = state.activeId === null || state.activeId === replaced?.id;
      // A dismissed desk still collects; it simply does not reappear.
      const opens = takesView && !state.dismissed;

      return {
        ...state,
        tabs: place(state.tabs, action.artifact, 'preview'),
        activeId: takesView ? action.artifact.id : state.activeId,
        open: opens ? true : state.open,
        ...(takesView ? { reason: action.reason ?? null } : {}),
        newIds: nextNewIds(state, action.artifact.id, takesView, replaced?.id ?? null),
      };
    }

    case 'activate':
      if (!state.tabs.some((tab) => tab.id === action.id)) return state;
      return {
        ...state,
        activeId: action.id,
        open: true,
        dismissed: false,
        reason: null,
        newIds: state.newIds.filter((id) => id !== action.id),
      };

    case 'keep': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index === -1 || state.tabs[index]!.status === 'durable') return state;
      const tabs = [...state.tabs];
      tabs[index] = { ...tabs[index]!, status: 'durable' };
      return { ...state, tabs };
    }

    case 'closeTab': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      const wasActive = state.activeId === action.id;
      return {
        ...state,
        tabs,
        /*
         * The neighbour to the right, else the left, else nothing. Closing a
         * tab is not closing the desk: `open` and `dismissed` are untouched,
         * and closing the last one lands on the empty state, which is a state
         * this panel already has words for.
         */
        activeId: wasActive ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.activeId,
        // The reason belonged to the view that just went.
        ...(wasActive ? { reason: null } : {}),
        newIds: state.newIds.filter((id) => id !== action.id),
      };
    }

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

    /*
     * Only onto an empty desk. A restore that arrived after the developer had
     * already opened something would blow their work away, and the read is
     * asynchronous, so that race is real rather than theoretical.
     *
     * `open`, `dismissed`, `newIds` and `reason` are left alone: restored tabs
     * are not new, and whether the panel is open is about the window in front
     * of you rather than about last week.
     */
    case 'hydrate':
      if (state.tabs.length > 0 || action.tabs.length === 0) return state;
      return { ...state, tabs: action.tabs, activeId: action.activeId };

    case 'resolved': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      // Resolved after it was closed. Nothing to attach it to, and nothing wrong.
      if (index === -1) return state;
      const tabs = [...state.tabs];
      tabs[index] = { ...tabs[index]!, title: action.artifact.title, artifact: action.artifact };
      return { ...state, tabs };
    }

    case 'reset':
      return EMPTY_WORKBENCH;
  }
}

/**
 * Where an arriving artifact goes.
 *
 * Tab ids are `formatRef(sourceRef)`, so opening the same thing twice is the
 * same tab rather than a duplicate — the desk needs no handle table. An
 * existing tab is refreshed in place, because its content may have moved on
 * since it was first read, and its status is never downgraded: something Vowe
 * cites again does not stop being the developer's.
 *
 * A new `preview` takes the preview slot *at its index*, so Vowe replacing its
 * own scratch tab does not shuffle everything to its right.
 */
function place(
  tabs: WorkbenchTab[],
  artifact: WorkbenchArtifact,
  status: TabStatus,
): WorkbenchTab[] {
  const arriving: WorkbenchTab = {
    id: artifact.id,
    sourceRef: artifact.sourceRef,
    title: artifact.title,
    status,
    artifact,
  };

  const existing = tabs.findIndex((tab) => tab.id === artifact.id);
  if (existing !== -1) {
    const next = [...tabs];
    next[existing] = { ...arriving, status: keptStatus(tabs[existing]!.status, status) };
    return next;
  }

  if (status === 'durable') return [...tabs, arriving];

  const preview = tabs.findIndex((tab) => tab.status === 'preview');
  if (preview === -1) return [...tabs, arriving];
  const next = [...tabs];
  next[preview] = arriving;
  return next;
}

/** Durable is a claim; nothing Vowe does takes it back. */
function keptStatus(current: TabStatus, arriving: TabStatus): TabStatus {
  return current === 'durable' ? 'durable' : arriving;
}

function replacedPreview(state: WorkbenchState, arrivingId: string): WorkbenchTab | null {
  if (state.tabs.some((tab) => tab.id === arrivingId)) return null;
  return state.tabs.find((tab) => tab.status === 'preview') ?? null;
}

function nextNewIds(
  state: WorkbenchState,
  arrivingId: string,
  takesView: boolean,
  replacedId: string | null,
): string[] {
  // The tab that was in the slot is gone; its unseen mark goes with it.
  const kept = replacedId ? state.newIds.filter((id) => id !== replacedId) : state.newIds;
  return takesView && state.open
    ? kept.filter((id) => id !== arrivingId)
    : addOnce(kept, arrivingId);
}

function addOnce(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

export function activeTab(state: WorkbenchState): WorkbenchTab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

export function activeArtifact(state: WorkbenchState): WorkbenchArtifact | null {
  return activeTab(state)?.artifact ?? null;
}

export function previewTab(state: WorkbenchState): WorkbenchTab | null {
  return state.tabs.find((tab) => tab.status === 'preview') ?? null;
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

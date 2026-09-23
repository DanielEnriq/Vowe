import { describe, expect, it } from 'vitest';

import type { WorkbenchArtifact } from '@vowe/core';
import {
  EMPTY_WORKBENCH,
  activeArtifact,
  previewTab,
  workbenchReducer,
  type TabStatus,
  type WorkbenchAction,
  type WorkbenchState,
  type WorkbenchTab,
} from '../src/renderer/state/workbench.js';

function artifact(id: string, text = 'x'): WorkbenchArtifact {
  return {
    id,
    kind: 'source',
    title: id,
    sourceRef: { kind: 'repo', path: `/repo/${id}` },
    content: { type: 'source', path: `/repo/${id}`, text, startLine: 1, endLine: 1, truncated: false },
  };
}

/** A restored tab: an address and the name it had, with nothing read yet. */
function tab(id: string, status: TabStatus = 'durable'): WorkbenchTab {
  return {
    id,
    sourceRef: { kind: 'repo', path: `/repo/${id}` },
    title: id,
    status,
    artifact: null,
  };
}

function run(actions: WorkbenchAction[], from: WorkbenchState = EMPTY_WORKBENCH): WorkbenchState {
  return actions.reduce(workbenchReducer, from);
}

const ids = (state: WorkbenchState): string[] => state.tabs.map((item) => item.id);
const statusOf = (state: WorkbenchState, id: string): TabStatus | undefined =>
  state.tabs.find((item) => item.id === id)?.status;

describe('Workbench — the desk', () => {
  it('opens what the developer asked for and shows it', () => {
    const state = run([{ type: 'open', artifact: artifact('a') }]);
    expect(state.activeId).toBe('a');
    expect(state.open).toBe(true);
    expect(state.tabs).toHaveLength(1);
    // Asking for something is keeping it.
    expect(statusOf(state, 'a')).toBe('durable');
  });

  it('closing hides the desk but keeps what is on it', () => {
    const state = run([{ type: 'open', artifact: artifact('a') }, { type: 'close' }]);
    expect(state.open).toBe(false);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe('a');
  });

  it('treats the same address as the same artifact, refreshed', () => {
    const state = run([
      { type: 'open', artifact: artifact('a', 'first') },
      { type: 'open', artifact: artifact('a', 'second') },
    ]);
    expect(state.tabs).toHaveLength(1);
    expect(activeArtifact(state)?.content).toMatchObject({ text: 'second' });
  });

  it('surfaces into one preview tab, and takes the view when nothing is active', () => {
    const state = run([{ type: 'surface', artifact: artifact('a') }]);
    expect(state.activeId).toBe('a');
    expect(statusOf(state, 'a')).toBe('preview');
  });

  /**
   * The rule that replaced pinning. Vowe surfaces beside what the developer is
   * reading; it does not yank the desk out from under them mid-read.
   */
  it('does not take the view off a tab the developer opened', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b') },
    ]);
    expect(state.activeId).toBe('a');
    expect(ids(state)).toEqual(['a', 'b']);
    expect(statusOf(state, 'b')).toBe('preview');
    expect(state.newIds).toEqual(['b']);
  });

  it('takes the view off its own preview, and replaces it in place', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'activate', id: 'a' },
      { type: 'surface', artifact: artifact('b') },
      { type: 'activate', id: 'b' },
      { type: 'surface', artifact: artifact('c') },
    ]);
    expect(state.activeId).toBe('c');
    // One preview, and it did not shuffle to the end of the strip.
    expect(ids(state)).toEqual(['a', 'c']);
    expect(previewTab(state)?.id).toBe('c');
    // The tab that was in the slot is gone; its unseen mark went with it.
    expect(state.newIds).not.toContain('b');
  });

  it('an explicit open always wins, and promotes the preview it lands on', () => {
    const state = run([
      { type: 'surface', artifact: artifact('a') },
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b') },
    ]);
    // `a` was kept by being opened, so `b` had to append rather than replace.
    expect(statusOf(state, 'a')).toBe('durable');
    expect(ids(state)).toEqual(['a', 'b']);
  });

  it('keeping a preview stops the next surface recycling it', () => {
    const state = run([
      { type: 'surface', artifact: artifact('a') },
      { type: 'keep', id: 'a' },
      { type: 'surface', artifact: artifact('b') },
    ]);
    expect(statusOf(state, 'a')).toBe('durable');
    expect(ids(state)).toEqual(['a', 'b']);
  });

  it('keeping something already kept, or not there, changes nothing', () => {
    const before = run([{ type: 'open', artifact: artifact('a') }]);
    expect(workbenchReducer(before, { type: 'keep', id: 'a' })).toBe(before);
    expect(workbenchReducer(before, { type: 'keep', id: 'nope' })).toBe(before);
  });

  it('looking at a preview is not keeping it', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b') },
      { type: 'activate', id: 'b' },
    ]);
    expect(statusOf(state, 'b')).toBe('preview');
  });

  it('something Vowe cites again does not stop being the developer’s', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('a') },
    ]);
    expect(statusOf(state, 'a')).toBe('durable');
    expect(state.open).toBe(true);
  });

  it('activating clears the unread mark', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b') },
      { type: 'activate', id: 'b' },
    ]);
    expect(state.activeId).toBe('b');
    expect(state.newIds).toEqual([]);
  });

  it('ignores activating something that is not on the desk', () => {
    const before = run([{ type: 'open', artifact: artifact('a') }]);
    expect(workbenchReducer(before, { type: 'activate', id: 'nope' })).toBe(before);
  });

  it('the desk is session-scoped', () => {
    const state = run([{ type: 'open', artifact: artifact('a') }, { type: 'reset' }]);
    expect(state).toEqual(EMPTY_WORKBENCH);
  });
});

describe('Workbench — closing a tab', () => {
  const three = (): WorkbenchState =>
    run([
      { type: 'open', artifact: artifact('a') },
      { type: 'open', artifact: artifact('b') },
      { type: 'open', artifact: artifact('c') },
    ]);

  it('closing a tab that is not in front leaves the view alone', () => {
    const state = workbenchReducer(three(), { type: 'closeTab', id: 'a' });
    expect(state.activeId).toBe('c');
    expect(ids(state)).toEqual(['b', 'c']);
  });

  it('the view falls to the neighbour on the right', () => {
    const state = run([{ type: 'activate', id: 'b' }, { type: 'closeTab', id: 'b' }], three());
    expect(state.activeId).toBe('c');
  });

  it('and to the left when there is nothing on the right', () => {
    const state = workbenchReducer(three(), { type: 'closeTab', id: 'c' });
    expect(state.activeId).toBe('b');
  });

  /** Closing a tab is not closing the desk. */
  it('the last tab leaves the panel open on nothing', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'closeTab', id: 'a' },
    ]);
    expect(state.activeId).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.open).toBe(true);
    expect(state.dismissed).toBe(false);
  });

  it('drops the unseen mark, and the reason when the view went with it', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b'), reason: 'Used to answer your question' },
      { type: 'closeTab', id: 'b' },
    ]);
    expect(state.newIds).toEqual([]);
    // `b` was never in front, so the reason it carried was never shown.
    expect(state.activeId).toBe('a');
  });

  it('clears the reason when the tab in front is the one that closed', () => {
    const state = run([
      { type: 'surface', artifact: artifact('a'), reason: 'Used to answer your question' },
      { type: 'closeTab', id: 'a' },
    ]);
    expect(state.reason).toBeNull();
  });

  it('ignores closing something that is not on the desk', () => {
    const before = run([{ type: 'open', artifact: artifact('a') }]);
    expect(workbenchReducer(before, { type: 'closeTab', id: 'nope' })).toBe(before);
  });
});

describe('Workbench — restored', () => {
  it('comes back as addresses, with nothing read and nothing new', () => {
    const state = workbenchReducer(EMPTY_WORKBENCH, {
      type: 'hydrate',
      tabs: [tab('a'), tab('b', 'preview')],
      activeId: 'b',
    });
    expect(ids(state)).toEqual(['a', 'b']);
    expect(state.activeId).toBe('b');
    expect(activeArtifact(state)).toBeNull();
    expect(state.newIds).toEqual([]);
    // Restoring a desk is not a reason to put the panel in front of anybody.
    expect(state.open).toBe(false);
  });

  /** A restore that lands late must not blow away what was opened meanwhile. */
  it('is ignored once there is anything on the desk', () => {
    const before = run([{ type: 'open', artifact: artifact('a') }]);
    const after = workbenchReducer(before, {
      type: 'hydrate',
      tabs: [tab('x'), tab('y')],
      activeId: 'x',
    });
    expect(after).toBe(before);
  });

  it('attaches a resolved artifact without moving anything', () => {
    const restored = workbenchReducer(EMPTY_WORKBENCH, {
      type: 'hydrate',
      tabs: [tab('a', 'preview'), tab('b')],
      activeId: 'b',
    });
    const state = workbenchReducer(restored, { type: 'resolved', id: 'a', artifact: artifact('a') });
    expect(ids(state)).toEqual(['a', 'b']);
    expect(state.activeId).toBe('b');
    expect(statusOf(state, 'a')).toBe('preview');
    expect(state.tabs[0]?.artifact).not.toBeNull();
  });

  it('ignores an artifact that resolved after its tab was closed', () => {
    const before = run([{ type: 'open', artifact: artifact('a') }]);
    expect(workbenchReducer(before, { type: 'resolved', id: 'gone', artifact: artifact('gone') })).toBe(
      before,
    );
  });
});

describe('Workbench — the developer closed it', () => {
  /**
   * The rule the desk exists to respect: closing something means it stays
   * closed. Surfacing keeps collecting; it simply stops being able to reopen
   * the panel over somebody who just put it away.
   */
  it('does not reopen itself after a manual close', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'close' },
      { type: 'surface', artifact: artifact('b') },
    ]);

    expect(state.open).toBe(false);
    // Still collected, and still marked as unseen, so the rail can say so.
    expect(ids(state)).toEqual(['a', 'b']);
    expect(state.newIds).toContain('b');
  });

  it('comes back the moment it is asked for', () => {
    const closed = run([{ type: 'open', artifact: artifact('a') }, { type: 'close' }]);
    expect(closed.dismissed).toBe(true);

    const reopened = workbenchReducer(closed, { type: 'setOpen', open: true });
    expect(reopened.open).toBe(true);
    expect(reopened.dismissed).toBe(false);
    // Opening the desk is looking at it.
    expect(reopened.newIds).toEqual([]);
  });

  it('opens empty, because "what are we looking at?" is a fair question', () => {
    const state = run([{ type: 'setOpen', open: true }]);
    expect(state.open).toBe(true);
    expect(activeArtifact(state)).toBeNull();
  });

  /**
   * Why a view is being shown belongs to the desk, not to the artifact: the
   * same file is the same file whether Vowe cited it or somebody opened it.
   */
  it('remembers why the current view was surfaced, and forgets on a manual open', () => {
    const surfaced = run([
      { type: 'surface', artifact: artifact('a'), reason: 'Used to answer your question' },
    ]);
    expect(surfaced.reason).toBe('Used to answer your question');

    const opened = workbenchReducer(surfaced, { type: 'open', artifact: artifact('b') });
    expect(opened.reason).toBeNull();
  });
});

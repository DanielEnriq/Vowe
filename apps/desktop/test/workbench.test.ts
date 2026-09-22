import { describe, expect, it } from 'vitest';

import type { WorkbenchArtifact } from '@vowe/core';
import {
  EMPTY_WORKBENCH,
  activeArtifact,
  workbenchReducer,
  type WorkbenchAction,
  type WorkbenchState,
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

function run(actions: WorkbenchAction[], from: WorkbenchState = EMPTY_WORKBENCH): WorkbenchState {
  return actions.reduce(workbenchReducer, from);
}

describe('Workbench — the desk', () => {
  it('opens what the developer asked for and shows it', () => {
    const state = run([{ type: 'open', artifact: artifact('a') }]);
    expect(state.activeId).toBe('a');
    expect(state.open).toBe(true);
    expect(state.items).toHaveLength(1);
  });

  it('closing hides the desk but keeps what is on it', () => {
    const state = run([{ type: 'open', artifact: artifact('a') }, { type: 'close' }]);
    expect(state.open).toBe(false);
    expect(state.items).toHaveLength(1);
    expect(state.activeId).toBe('a');
  });

  it('treats the same address as the same artifact, refreshed', () => {
    const state = run([
      { type: 'open', artifact: artifact('a', 'first') },
      { type: 'open', artifact: artifact('a', 'second') },
    ]);
    expect(state.items).toHaveLength(1);
    expect(activeArtifact(state)?.content).toMatchObject({ text: 'second' });
  });

  it('surfaces with show: Vowe takes the view', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b'), level: 'show' },
    ]);
    expect(state.activeId).toBe('b');
    expect(state.newIds).toEqual([]);
  });

  it('surfaces with suggest: the desk grows, the view does not move', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b'), level: 'suggest' },
    ]);
    expect(state.activeId).toBe('a');
    expect(state.items).toHaveLength(2);
    expect(state.newIds).toEqual(['b']);
  });

  /**
   * Pinning is the developer saying what they want to keep looking at. Vowe
   * may still add to the desk; it may not take the view away.
   */
  it('a pin stops Vowe replacing the active artifact', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'togglePin' },
      { type: 'surface', artifact: artifact('b'), level: 'show' },
    ]);
    expect(state.activeId).toBe('a');
    expect(state.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.newIds).toEqual(['b']);
  });

  it('a pin never stops the developer opening something', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'togglePin' },
      { type: 'open', artifact: artifact('b') },
    ]);
    expect(state.activeId).toBe('b');
  });

  it('re-surfacing the pinned artifact itself is not blocked', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'togglePin' },
      { type: 'surface', artifact: artifact('a'), level: 'show' },
    ]);
    expect(state.activeId).toBe('a');
    expect(state.open).toBe(true);
  });

  it('unpins by toggling the same artifact again', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'togglePin' },
      { type: 'togglePin' },
      { type: 'surface', artifact: artifact('b'), level: 'show' },
    ]);
    expect(state.pinnedId).toBeNull();
    expect(state.activeId).toBe('b');
  });

  it('activating clears the unread mark', () => {
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'surface', artifact: artifact('b'), level: 'suggest' },
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
    const state = run([
      { type: 'open', artifact: artifact('a') },
      { type: 'togglePin' },
      { type: 'reset' },
    ]);
    expect(state).toEqual(EMPTY_WORKBENCH);
  });
});

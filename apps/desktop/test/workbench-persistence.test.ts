import { describe, expect, it } from 'vitest';

import type { PersistedWorkbench, WorkbenchArtifact } from '@vowe/core';

import {
  persistDesk,
  restoreTabs,
  restoredActiveId,
} from '../src/renderer/state/workbench-persistence.js';
import {
  EMPTY_WORKBENCH,
  workbenchReducer,
  type WorkbenchState,
} from '../src/renderer/state/workbench.js';

function source(path: string, text: string): WorkbenchArtifact {
  return {
    id: `repo:${path}`,
    kind: 'source',
    title: path.split('/').pop()!,
    sourceRef: { kind: 'repo', path },
    content: { type: 'source', path, text, startLine: 1, endLine: 1, truncated: false },
  };
}

function desk(): WorkbenchState {
  return [
    { type: 'open' as const, artifact: source('/repo/live.ts', 'const secret = 1;') },
    { type: 'surface' as const, artifact: source('/repo/checkpoint.ts', 'export const x = 2;') },
  ].reduce(workbenchReducer, EMPTY_WORKBENCH);
}

describe('Workbench persistence — addresses, not material', () => {
  it('keeps order, names and who each tab belongs to', () => {
    const stored = persistDesk(desk());
    expect(stored.tabs).toEqual([
      { ref: 'repo:/repo/live.ts', title: 'live.ts', status: 'durable' },
      { ref: 'repo:/repo/checkpoint.ts', title: 'checkpoint.ts', status: 'preview' },
    ]);
    expect(stored.activeId).toBe('repo:/repo/live.ts');
  });

  /**
   * The invariant the whole design rests on. A desk is a list of places to
   * look; if a file's contents ever reached this document, Vowe would be
   * keeping a stale copy of somebody's repository in its UI state.
   */
  it('writes no file contents at all', () => {
    const json = JSON.stringify(persistDesk(desk()));
    expect(json).not.toContain('const secret');
    expect(json).not.toContain('export const x');
    expect(json).not.toContain('text');
    expect(json).not.toContain('patch');
  });

  it('round-trips into tabs that have not been read yet', () => {
    const before = desk();
    const tabs = restoreTabs(persistDesk(before));
    expect(tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id));
    expect(tabs.map((tab) => tab.status)).toEqual(['durable', 'preview']);
    expect(tabs.every((tab) => tab.artifact === null)).toBe(true);
  });

  /** Forty tabs is a working day, not a bug. Nothing is quietly dropped. */
  it('restores as many tabs as were left open', () => {
    const many: PersistedWorkbench = {
      tabs: Array.from({ length: 40 }, (_, index) => ({
        ref: `repo:/repo/f${index}.ts`,
        title: `f${index}.ts`,
        status: 'durable' as const,
      })),
      activeId: 'repo:/repo/f39.ts',
    };
    const tabs = restoreTabs(many);
    expect(tabs).toHaveLength(40);
    expect(restoredActiveId(many, tabs)).toBe('repo:/repo/f39.ts');
  });

  it('drops an address nothing can be done with, and keeps the rest', () => {
    const tabs = restoreTabs({
      tabs: [
        { ref: 'not-an-address', title: 'mystery', status: 'durable' },
        { ref: 'repo:/repo/live.ts', title: 'live.ts', status: 'durable' },
      ],
      activeId: 'not-an-address',
    });
    expect(tabs.map((tab) => tab.id)).toEqual(['repo:/repo/live.ts']);
  });

  it('forgets an active tab that did not survive', () => {
    const stored: PersistedWorkbench = {
      tabs: [{ ref: 'gibberish', title: 'gone', status: 'durable' }],
      activeId: 'gibberish',
    };
    expect(restoredActiveId(stored, restoreTabs(stored))).toBeNull();
  });

  it('has nothing to restore from nothing', () => {
    expect(restoreTabs(null)).toEqual([]);
    expect(restoredActiveId(null, [])).toBeNull();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import type { PersistedWorkbench } from '../src/workbench/persisted.js';
import { temporaryStore } from './helpers.js';

const SESSION = 'claude-code:s1';

const tab = (ref: string, title: string, status: 'preview' | 'durable' = 'durable') => ({
  ref,
  title,
  status,
});

const desk = (
  tabs: PersistedWorkbench['tabs'],
  activeId: string | null = null,
): PersistedWorkbench => ({ tabs, activeId });

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

async function fixture() {
  const created = await temporaryStore();
  cleanups.push(created.cleanup);
  return created;
}

/** Write a document the app would never produce, to prove reading is total. */
function writeRaw(root: string, json: string): void {
  const db = new DatabaseSync(path.join(root, 'vowe.sqlite'));
  db.prepare(
    `INSERT INTO workbench_state (session_id, state_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET state_json = excluded.state_json`,
  ).run(SESSION, json, new Date().toISOString());
  db.close();
}

describe('The desk, across a restart', () => {
  it('has nothing to say about a session nobody opened anything in', async () => {
    const { store } = await fixture();
    expect(store.getWorkbenchState(SESSION)).toBeNull();
  });

  it('comes back in order, with each tab still whose it was', async () => {
    const { store, reopen } = await fixture();
    await store.setWorkbenchState(
      SESSION,
      desk(
        [
          tab('repo:src/live.ts', 'live.ts'),
          tab('diff:claude-code:s1', 'Current diff', 'preview'),
          tab('lesson:p1#r1', 'Why two inserts?'),
        ],
        'repo:src/live.ts',
      ),
    );

    const restarted = await reopen();
    expect(restarted.getWorkbenchState(SESSION)).toEqual({
      tabs: [
        tab('repo:src/live.ts', 'live.ts'),
        tab('diff:claude-code:s1', 'Current diff', 'preview'),
        tab('lesson:p1#r1', 'Why two inserts?'),
      ],
      activeId: 'repo:src/live.ts',
    });
  });

  /** Forty tabs is a working day. Nothing is silently discarded. */
  it('keeps every tab, however many were left open', async () => {
    const { store, reopen } = await fixture();
    const many = Array.from({ length: 40 }, (_, index) =>
      tab(`repo:src/f${index}.ts`, `f${index}.ts`),
    );
    await store.setWorkbenchState(SESSION, desk(many, 'repo:src/f39.ts'));

    const restarted = await reopen();
    expect(restarted.getWorkbenchState(SESSION)?.tabs).toHaveLength(40);
  });

  /** "Nothing open" is where every session starts; a row saying so says nothing. */
  it('forgets a desk that was emptied', async () => {
    const { store } = await fixture();
    await store.setWorkbenchState(SESSION, desk([tab('repo:a.ts', 'a.ts')]));
    await store.setWorkbenchState(SESSION, desk([]));
    expect(store.getWorkbenchState(SESSION)).toBeNull();
  });

  it('keeps one session’s desk out of another’s', async () => {
    const { store } = await fixture();
    await store.setWorkbenchState(SESSION, desk([tab('repo:a.ts', 'a.ts')]));
    await store.setWorkbenchState('claude-code:s2', desk([tab('repo:b.ts', 'b.ts')]));
    expect(store.getWorkbenchState(SESSION)?.tabs.map((t) => t.ref)).toEqual(['repo:a.ts']);
    expect(store.getWorkbenchState('claude-code:s2')?.tabs.map((t) => t.ref)).toEqual(['repo:b.ts']);
  });
});

describe('The desk, read defensively', () => {
  it('drops an address nothing can be done with, and keeps the rest', async () => {
    const { store, root } = await fixture();
    writeRaw(
      root,
      JSON.stringify(
        desk([tab('not-an-address', 'mystery'), tab('repo:src/live.ts', 'live.ts')], 'not-an-address'),
      ),
    );
    expect(store.getWorkbenchState(SESSION)).toEqual({
      tabs: [tab('repo:src/live.ts', 'live.ts')],
      activeId: null,
    });
  });

  it('holds the one-preview invariant against a document that broke it', async () => {
    const { store, root } = await fixture();
    writeRaw(
      root,
      JSON.stringify(
        desk([
          tab('repo:a.ts', 'a.ts', 'preview'),
          tab('repo:b.ts', 'b.ts', 'preview'),
          tab('repo:c.ts', 'c.ts', 'preview'),
        ]),
      ),
    );
    expect(store.getWorkbenchState(SESSION)?.tabs.map((t) => t.status)).toEqual([
      'preview',
      'durable',
      'durable',
    ]);
  });

  /** An unclassifiable tab is one the developer keeps: the safe direction. */
  it('treats a status it does not recognise as kept', async () => {
    const { store, root } = await fixture();
    writeRaw(root, JSON.stringify({ tabs: [{ ref: 'repo:a.ts', title: 'a.ts', status: 'pinned' }] }));
    expect(store.getWorkbenchState(SESSION)?.tabs[0]?.status).toBe('durable');
  });

  it('re-keys a tab to the canonical spelling of its address, and dedupes', async () => {
    const { store, root } = await fixture();
    writeRaw(
      root,
      JSON.stringify(desk([tab('repo:src/a.ts#12', 'a.ts'), tab('repo:src/a.ts#12', 'a.ts again')])),
    );
    const stored = store.getWorkbenchState(SESSION);
    expect(stored?.tabs).toHaveLength(1);
    expect(stored?.tabs[0]).toEqual(tab('repo:src/a.ts#12', 'a.ts'));
  });

  it('falls back to the address when a tab lost its name', async () => {
    const { store, root } = await fixture();
    writeRaw(root, JSON.stringify({ tabs: [{ ref: 'repo:a.ts', title: '   ' }] }));
    expect(store.getWorkbenchState(SESSION)?.tabs[0]?.title).toBe('repo:a.ts');
  });

  /**
   * A desk is not history. A document that no longer makes sense costs one
   * arrangement of tabs, and must never be an exception on the way into a room.
   */
  it('answers with nothing rather than throwing on a ruined document', async () => {
    const { store, root } = await fixture();
    for (const junk of ['{ not json', '[]', 'null', '{"tabs":"nope"}', '{"tabs":[]}']) {
      writeRaw(root, junk);
      expect(store.getWorkbenchState(SESSION)).toBeNull();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { temporaryStore } from './helpers.js';

const SESSION = 'claude-code:s1';

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

describe('A session put away', () => {
  it('is remembered across a restart, and comes back when asked', async () => {
    const { store, reopen } = await fixture();
    await store.upsertProject({
      id: 'p1',
      name: 'Vowe',
      repoRoot: '/repo',
      createdAt: new Date().toISOString(),
    });
    await store.upsertSession({
      id: SESSION,
      provider: 'claude-code',
      providerSessionId: 's1',
      attachMode: 'observe',
      task: null,
      displayLabel: 's1',
      cwd: '/repo',
      projectId: 'p1',
      status: 'idle',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      capabilities: {},
      semanticState: null,
    } as Parameters<typeof store.upsertSession>[0]);

    expect(store.getSession(SESSION)?.archivedAt).toBeUndefined();

    await store.setSessionArchived(SESSION, true);
    const restarted = await reopen();
    expect(restarted.getSession(SESSION)?.archivedAt).toEqual(expect.any(String));

    await restarted.setSessionArchived(SESSION, false);
    expect(restarted.getSession(SESSION)?.archivedAt).toBeUndefined();
  });
});

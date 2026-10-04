import { afterEach, describe, expect, it } from 'vitest';

import type { CaptainExchange } from '../src/fleet/types.js';
import { MIGRATIONS } from '../src/store/sqlite/migrations.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import { temporaryStore } from './helpers.js';

const PROJECT = 'git:fleet';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function fixture() {
  const opened = await temporaryStore();
  cleanup = opened.cleanup;
  await opened.store.upsertProject({
    id: PROJECT,
    name: 'Fleet',
    repoRoot: '/repo/fleet',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  return opened;
}

function exchange(overrides: Partial<CaptainExchange> = {}): CaptainExchange {
  return {
    id: 'x1',
    projectId: PROJECT,
    askerSessionId: 'claude-code:a',
    questionId: 'toolu_1',
    captainSessionId: null,
    question: 'Keep the old header?',
    captainAnswer: null,
    route: 'you',
    userAnswer: null,
    status: 'pending',
    delivery: null,
    askedAt: '2026-10-01T10:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

describe('captain exchange persistence', () => {
  it('notifies after commit and updates in place', async () => {
    const { store } = await fixture();
    const seen: Array<string | undefined> = [];
    store.onCaptainExchangeChanged((change) => {
      expect(change.projectId).toBe(PROJECT);
      seen.push(store.getCaptainExchange(change.exchangeId)?.status);
    });

    await store.saveCaptainExchange(exchange());
    await store.saveCaptainExchange(
      exchange({ status: 'answered', userAnswer: 'Cut it', delivery: 'in-place', answeredAt: '2026-10-01T10:01:00.000Z' }),
    );
    expect(seen).toEqual(['pending', 'answered']);
    expect(store.listCaptainExchanges(PROJECT)).toHaveLength(1);
  });

  it('keeps optional keys absent and nullable keys present across a reopen', async () => {
    const opened = await fixture();
    await opened.store.saveCaptainExchange(exchange());
    await opened.store.saveCaptainExchange(
      exchange({
        id: 'x2',
        questionId: 'toolu_2',
        toolUseId: 'toolu_2',
        options: ['Keep', 'Cut'],
        captainSessionId: 'claude-code:captain',
        captainAnswer: 'Depends.\nPASS: your call',
        route: 'you',
        status: 'passed',
        passedToYouReason: 'your call',
        askedAt: '2026-10-01T10:05:00.000Z',
      }),
    );

    const store = await opened.reopen();
    const [newest, oldest] = store.listCaptainExchanges(PROJECT);
    expect(newest).toEqual(
      exchange({
        id: 'x2',
        questionId: 'toolu_2',
        toolUseId: 'toolu_2',
        options: ['Keep', 'Cut'],
        captainSessionId: 'claude-code:captain',
        captainAnswer: 'Depends.\nPASS: your call',
        route: 'you',
        status: 'passed',
        passedToYouReason: 'your call',
        askedAt: '2026-10-01T10:05:00.000Z',
      }),
    );
    expect(Object.keys(oldest!).sort()).toEqual(Object.keys(exchange()).sort());
    expect(store.getCaptainExchange('missing')).toBeNull();
  });

  it('refuses an exchange outside a known project, and an invalid status, without notifying', async () => {
    const { store } = await fixture();
    let notified = 0;
    store.onCaptainExchangeChanged(() => notified++);
    await expect(store.saveCaptainExchange(exchange({ projectId: 'git:nowhere' }))).rejects.toThrow();
    await expect(
      store.saveCaptainExchange(exchange({ status: 'lost' as CaptainExchange['status'] })),
    ).rejects.toThrow();
    expect(notified).toBe(0);
    expect(store.listCaptainExchanges(PROJECT)).toEqual([]);
  });

  it('records one exchange per held question', async () => {
    const { store } = await fixture();
    await store.saveCaptainExchange(exchange());
    await expect(store.saveCaptainExchange(exchange({ id: 'x-dup' }))).rejects.toThrow();
  });

  it('migrates an existing store forward to the exchanges table', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    await opened.store.close();
    const old = new SqliteEventStore(opened.root, { migrations: MIGRATIONS.filter((m) => m.version < 20) });
    await old.init();
    await old.upsertProject({ id: PROJECT, name: 'Fleet', repoRoot: '/repo/fleet', createdAt: '2026-10-01T00:00:00.000Z' });
    await old.close();

    const store = await opened.reopen();
    await store.saveCaptainExchange(exchange());
    expect(store.listCaptainExchanges(PROJECT).map((e) => e.id)).toEqual(['x1']);
  });
});

import { afterEach, expect, it } from 'vitest';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { EvidenceBatch, EvidenceSource, EvidenceSubscription } from '../src/evidence/types.js';
import type { AgentAdapter } from '../src/types/adapter.js';
import type { AgentSession } from '../src/types/session.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let registry: SessionRegistry | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await registry?.stop();
  registry = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

let deliveries = 0;
function delivery(sessionId: string, text: string): EvidenceBatch {
  const location = { source: 'remote', byteOffset: 0, line: 1 };
  const key = `${text}-${deliveries++}`;
  return {
    sourceId: 'stream',
    captureId: key,
    observedAt: '2026-01-01T00:00:00Z',
    mode: 'delta',
    coverage: { scope: 'stream', status: 'partial', reason: 'fixture' },
    records: [
      {
        key,
        raw: { text },
        location,
        events: [
          {
            slot: '0',
            event: { sessionId, at: '2026-01-01T00:00:00Z', kind: 'agent_message', summary: text, raw: { text }, rawRef: location },
          },
        ],
      },
    ],
  };
}
function adapter(sessions: AgentSession[], source: (session: AgentSession) => EvidenceSource): AgentAdapter {
  return {
    provider: sessions[0]!.provider,
    discoverSessions: async () => sessions,
    getSession: async (id) => sessions.find((s) => s.providerSessionId === id) ?? null,
    evidenceSources: (id) => [source(sessions.find((s) => s.providerSessionId === id)!)],
    subscribeToEvents: () => {
      throw new Error('legacy path');
    },
    sendInstruction: async () => {
      throw new Error('no control');
    },
  };
}
const freshness = () => registry!.get(TEST_SESSION)!.evidenceFreshness!.status;

it('shows stored understanding before catch-up, then reports it behind, then current', async () => {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  const session = testSession();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const source = (text: string, gated: boolean): EvidenceSource => ({
    id: 'stream',
    continuity: 'delivery-cursor',
    subscribe: (accept, subscription) => {
      void (async () => {
        if (gated) await gate;
        await accept(delivery(TEST_SESSION, text));
        subscription?.idle?.();
      })();
      return () => undefined;
    },
  });
  registry = new SessionRegistry({ store: f.store, reconcileIntervalMs: 60_000 });
  registry.registerAdapter(adapter([session], () => source('first', false)));
  await registry.start();
  await expect.poll(() => freshness()).toBe('behind');
  // The Session Observer derives through everything admitted so far.
  await f.store.setObservationState({
    sessionId: TEST_SESSION,
    lastClosedWindowIndex: 0,
    lastProcessedWindowId: null,
    processedThroughSeq: f.store.lastSeq(TEST_SESSION),
    communicationPreference: null,
    updatedAt: '2026-01-01T00:00:00Z',
  });
  expect(freshness()).toBe('current');
  await registry.stop();

  // Evidence advanced while Vowe was closed; nothing knows that yet.
  const store = await f.reopen();
  registry = new SessionRegistry({ store, reconcileIntervalMs: 60_000 });
  registry.registerAdapter(adapter([session], () => source('while closed', true)));
  await registry.start();
  expect(registry.list().map((s) => s.id)).toEqual([TEST_SESSION]);
  expect(freshness()).toBe('catching-up');
  release();
  await expect.poll(() => freshness()).toBe('behind');
  expect(registry.get(TEST_SESSION)!.evidenceFreshness!.evidenceRevision).toBeGreaterThan(
    registry.get(TEST_SESSION)!.evidenceFreshness!.derivedThroughRevision,
  );
  await store.setObservationState({
    ...store.getObservationState(TEST_SESSION)!,
    processedThroughSeq: store.lastSeq(TEST_SESSION),
  });
  expect(freshness()).toBe('current');
});

it('starts without waiting for any source, and subscribes only after discovery', async () => {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  await f.store.upsertSession(testSession());
  const order: string[] = [];
  const session = testSession();
  registry = new SessionRegistry({ store: f.store, reconcileIntervalMs: 60_000 });
  registry.registerAdapter({
    ...adapter([session], () => ({
      id: 'stream',
      continuity: 'append-log',
      subscribe: () => {
        order.push('subscribe');
        return () => undefined; // never delivers: an enormous backlog
      },
    })),
    discoverSessions: async () => {
      order.push('discover');
      return [session];
    },
  });
  await registry.start();
  expect(order).toEqual(['discover', 'subscribe']);
  expect(freshness()).toBe('catching-up');
});

it('bounds acquired work and never starves background catch-up behind a busy session', async () => {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  const busy = testSession({ id: 'claude-code:busy', providerSessionId: 'busy', status: 'working', lastActivityAt: new Date().toISOString() });
  const old = testSession({ id: 'claude-code:old', providerSessionId: 'old', lastActivityAt: '2020-01-01T00:00:00Z' });
  let held = 0,
    most = 0,
    stopped = false,
    busyAdmissions = 0,
    busyAtFinish = -1;
  const loop = (session: AgentSession, count: number, subscription: EvidenceSubscription, accept: (b: EvidenceBatch) => Promise<void>) => {
    void (async () => {
      for (let i = 0; i < count && !stopped; i++) {
        const release = await subscription.turn!();
        held++;
        most = Math.max(most, held);
        try {
          await accept(delivery(session.id, `${session.providerSessionId} ${i}`));
          if (session === busy) busyAdmissions++;
        } finally {
          held--;
          release();
        }
      }
      if (session === old) busyAtFinish = busyAdmissions;
      subscription.idle?.();
    })();
    return () => {
      stopped = true;
    };
  };
  registry = new SessionRegistry({ store: f.store, reconcileIntervalMs: 60_000 });
  registry.registerAdapter(
    adapter([busy, old], (session) => ({
      id: 'stream',
      continuity: 'delivery-cursor',
      subscribe: (accept, subscription) => loop(session, session === busy ? Infinity : 20, subscription!, accept),
    })),
  );
  await registry.start();
  await expect.poll(() => busyAtFinish, { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
  // The busy session kept producing throughout, yet history got its share.
  expect(busyAtFinish).toBeGreaterThan(0);
  expect(busyAtFinish).toBeLessThanOrEqual(20 * 3 + 3);
  expect(most).toBeLessThanOrEqual(2);
  expect(f.store.getEvents('claude-code:old')).toHaveLength(20);
  stopped = true;
});

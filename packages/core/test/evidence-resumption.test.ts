import { afterEach, expect, it } from 'vitest';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { EvidenceBatch, EvidenceSource } from '../src/evidence/types.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';
let registry: SessionRegistry, cleanup: () => Promise<void>;
afterEach(async () => {
  await registry?.stop();
  await cleanup?.();
});
it('resumes an opaque remote cursor after durable admission, tolerates replay, and records expiry as a gap', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  const session = testSession();
  let accept!: (batch: EvidenceBatch) => Promise<void>;
  const resumed: string[] = [];
  const source: EvidenceSource = {
    id: 'remote-run',
    subscribe: (fn) => {
      accept = fn;
      return () => {};
    },
    resumeAfter: (cursor, fn) => {
      resumed.push(cursor);
      accept = fn;
      return () => {};
    },
  };
  const start = async (store: typeof f.store) => {
    registry = new SessionRegistry({ store });
    registry.registerAdapter({
      provider: session.provider,
      discoverSessions: async () => [session],
      getSession: async () => session,
      evidenceSources: () => [source],
      subscribeToEvents: () => {
        throw new Error('legacy path');
      },
      sendInstruction: async () => {
        throw new Error('no control');
      },
    });
    await registry.start();
  };
  await start(f.store);
  const b: EvidenceBatch = {
    sourceId: source.id,
    captureId: 'delivery',
    observedAt: '2026-01-01T00:00:00Z',
    mode: 'delta',
    checkpoint: 'opaque:cursor/7\nnot-a-timestamp',
    coverage: { scope: 'run stream', status: 'partial', reason: 'earlier interval unavailable' },
    records: [
      {
        key: 'record:1',
        raw: { text: 'hello' },
        location: { source: 'https://fixture.invalid/run/events', byteOffset: 0, line: 1 },
        events: [
          {
            slot: 'message',
            event: {
              sessionId: TEST_SESSION,
              at: '2026-01-01T00:00:00Z',
              kind: 'agent_message',
              summary: 'hello',
              raw: { text: 'hello' },
              rawRef: { source: 'remote', byteOffset: 0, line: 1 },
            },
          },
        ],
      },
    ],
  };
  await accept(b);
  await registry.stop();
  const store = await f.reopen();
  await start(store);
  expect(resumed).toEqual([b.checkpoint]);
  await accept(b);
  expect(store.getEvents(TEST_SESSION)).toHaveLength(1);
  await accept({
    ...b,
    captureId: 'expired',
    records: [],
    coverage: {
      scope: 'run stream',
      status: 'unavailable',
      reason: 'Resume token expired; missed interval cannot be reconstructed',
    },
  });
  expect(store.evidenceStatus(TEST_SESSION).sources[0]!.coverage.reason).toContain(
    'cannot be reconstructed',
  );
  expect(store.getEvents(TEST_SESSION)).toHaveLength(1);
});

it('does not erase known coverage interruptions when later deliveries resume', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  const unavailable: EvidenceBatch = {
    sourceId: 'live',
    captureId: 'gap',
    observedAt: '2026-01-01T00:00:00Z',
    mode: 'delta',
    records: [],
    coverage: {
      scope: 'live interval',
      status: 'unavailable',
      reason: 'no historical replay exists',
    },
  };
  await f.store.ingestEvidence(TEST_SESSION, unavailable);
  await f.store.ingestEvidence(TEST_SESSION, {
    ...unavailable,
    captureId: 'back',
    coverage: { scope: 'live interval', status: 'complete', reason: 'new delivery' },
  });
  expect(
    f.store
      .getSession(TEST_SESSION)!
      .observationCoverage!.some(
        (c) => c.status === 'partial' && c.reason.includes('no historical replay'),
      ),
  ).toBe(true);
});

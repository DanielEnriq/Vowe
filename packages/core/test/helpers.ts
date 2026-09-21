import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type { AdapterEvent, NormalizedEvent } from '../src/types/events.js';
import type { AgentSession } from '../src/types/session.js';

/**
 * A real store on a real temp directory — persistence is under test.
 *
 * Every store-backed test in the suite comes through here, which is what makes
 * this the parity gate: the whole suite exercises the real database, on a real
 * file, rather than a fake that would prove nothing about durability.
 */
export async function temporaryStore(): Promise<{
  store: SqliteEventStore;
  root: string;
  reopen: () => Promise<SqliteEventStore>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-test-'));
  const opened: SqliteEventStore[] = [];

  const open = async (): Promise<SqliteEventStore> => {
    const next = new SqliteEventStore(root);
    await next.init();
    opened.push(next);
    return next;
  };

  const store = await open();
  return {
    store,
    root,
    /**
     * A second store over the same directory — i.e. "restart Vowe".
     *
     * The previous handle is closed first. Two open writers on one file is not
     * what a restart looks like, and leaving handles open would leak them and
     * the WAL sidecars across the suite.
     */
    reopen: async () => {
      for (const previous of opened.splice(0)) await previous.close();
      return open();
    },
    cleanup: async () => {
      for (const previous of opened.splice(0)) await previous.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const TEST_SESSION = 'claude-code:test-session';

export function testSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: TEST_SESSION,
    provider: 'claude-code',
    providerSessionId: 'test-session',
    attachMode: 'external-idle',
    task: 'Fix the reconnect regression',
    displayLabel: 'test-session',
    cwd: null,
    projectId: null,
    status: 'working',
    createdAt: '2026-02-11T09:00:00.000Z',
    lastActivityAt: '2026-02-11T09:00:00.000Z',
    capabilities: {
      observe: true,
      sendInstruction: false,
      interrupt: false,
      resume: false,
    },
    semanticState: null,
    ...overrides,
  };
}

export interface EventSpec {
  kind: NormalizedEvent['kind'];
  summary?: string;
  /** Seconds after the trace start. */
  atSeconds?: number;
  detail?: Record<string, unknown>;
}

const TRACE_START = Date.parse('2026-02-11T09:00:00.000Z');

/**
 * Build adapter events with explicit timestamps.
 *
 * Timestamps are supplied rather than taken from the clock because every
 * time-based window bound is measured against trace time — that is what makes
 * windowing reproducible, and a test that used wall-clock time would not be
 * testing the same thing twice.
 */
export function makeEvents(
  specs: EventSpec[],
  sessionId = TEST_SESSION,
  source = '/fixtures/test.jsonl',
): AdapterEvent[] {
  let offset = 0;
  return specs.map((spec, index) => {
    const byteOffset = offset;
    offset += 120;
    const event: AdapterEvent = {
      sessionId,
      at: new Date(TRACE_START + (spec.atSeconds ?? index) * 1000).toISOString(),
      kind: spec.kind,
      summary: spec.summary ?? `${spec.kind} #${index}`,
      raw: { index, kind: spec.kind },
      rawRef: { source, byteOffset, line: index + 1 },
    };
    if (spec.detail) event.detail = spec.detail;
    return event;
  });
}

/** A run of ordinary events, one second apart. */
export function steadyEvents(count: number, sessionId = TEST_SESSION): AdapterEvent[] {
  return makeEvents(
    Array.from({ length: count }, (_, index) => ({
      kind: 'tool_started' as const,
      summary: `step ${index}`,
      atSeconds: index,
    })),
    sessionId,
  );
}

export async function storeEvents(
  store: SqliteEventStore,
  events: AdapterEvent[],
  sessionId = TEST_SESSION,
): Promise<NormalizedEvent[]> {
  const stored: NormalizedEvent[] = [];
  for (const event of events) {
    const result = await store.appendEvent(sessionId, event);
    if (result) stored.push(result);
  }
  return stored;
}

/** A promise you resolve by hand, for pinning something open in a test. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

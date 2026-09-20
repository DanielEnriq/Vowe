import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NdjsonEventStore } from '../src/store/ndjson-event-store.js';
import type { AdapterEvent, NormalizedEvent } from '../src/types/events.js';
import type { AgentSession } from '../src/types/session.js';

/** A real store on a real temp directory — persistence is under test. */
export async function temporaryStore(): Promise<{
  store: NdjsonEventStore;
  root: string;
  reopen: () => Promise<NdjsonEventStore>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-test-'));
  const store = new NdjsonEventStore(root);
  await store.init();
  return {
    store,
    root,
    /** A second store over the same directory — i.e. "restart Vowe". */
    reopen: async () => {
      const next = new NdjsonEventStore(root);
      await next.init();
      return next;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
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
  store: NdjsonEventStore,
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

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { TranscriptNormalizer } from '@vowe/adapter-claude-code';
import type { AgentSession, EventStore } from '@vowe/core';

export interface IngestOptions {
  /** Path to a `.jsonl` transcript fixture. */
  file: string;
  /** Vowe session id to file the events under. */
  sessionId: string;
  store: EventStore;
  /** Stop after this many records, for bisecting a fixture. */
  maxRecords?: number;
}

export interface IngestResult {
  sessionId: string;
  recordsRead: number;
  eventsStored: number;
}

/**
 * Read a transcript fixture into a store, through the real normalizer.
 *
 * Deliberately uses `TranscriptNormalizer` from the production adapter rather
 * than constructing events directly. A replay that built its own events would
 * test the observer against a shape the observer never actually sees; this way
 * the fixture exercises the same path a live session does, including the
 * deny-list, the tool-call/result pairing and the `unknown` fallthrough.
 *
 * Byte offsets are computed as the file is read, so `rawRef` addresses the
 * fixture exactly as it would address a live transcript — which is what makes
 * `open_context` at raw depth work in replay too.
 */
export async function ingestTranscript(
  options: IngestOptions,
): Promise<IngestResult> {
  const source = path.resolve(options.file);
  const normalizer = new TranscriptNormalizer({
    sessionId: options.sessionId,
    source,
  });

  let byteOffset = 0;
  let lineNumber = 0;
  let recordsRead = 0;
  let eventsStored = 0;

  const reader = createInterface({
    input: createReadStream(source, 'utf8'),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const byteLength = Buffer.byteLength(line, 'utf8');
    const lineStart = byteOffset;
    byteOffset += byteLength + 1; // the newline the reader consumed
    lineNumber += 1;

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (options.maxRecords !== undefined && recordsRead >= options.maxRecords) break;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // Same tolerance the live reader has.
    }
    recordsRead += 1;

    for (const event of normalizer.normalize({
      record: record as never,
      byteOffset: lineStart,
      line: lineNumber,
    })) {
      const stored = await options.store.appendEvent(options.sessionId, event);
      if (stored) eventsStored += 1;
    }
  }

  return { sessionId: options.sessionId, recordsRead, eventsStored };
}

/** A minimal session record so the store and navigator have something to read. */
export function fixtureSession(
  sessionId: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: sessionId,
    provider: 'claude-code',
    providerSessionId: sessionId.split(':').pop() ?? sessionId,
    attachMode: 'external-idle',
    task: null,
    displayLabel: sessionId,
    cwd: null,
    projectId: null,
    status: 'finished',
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    /*
     * A replayed session is a recording. It can be read and nothing else:
     * there is no worker on the other end of it to instruct, interrupt or
     * resume, and its reasoning is whatever the recording happened to keep.
     */
    capabilities: {
      observe: true,
      sendInstruction: false,
      interrupt: false,
      resume: false,
      launch: false,
      reasoning: false,
    },
    semanticState: null,
    ...overrides,
  };
}

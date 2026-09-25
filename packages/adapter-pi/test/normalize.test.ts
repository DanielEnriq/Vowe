import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AdapterEvent } from '@vowe/core';
import { IncrementalPiSessionReader, PiSessionNormalizer } from '@vowe/adapter-pi';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'session.jsonl',
);

/**
 * The fixture mirrors the record shapes in the pi CLI's own
 * `docs/session-format.md` (session version 3). It is hand-written rather than
 * copied from a real transcript, so no worker's work ends up in the repo.
 */
async function normalizeFixture(): Promise<AdapterEvent[]> {
  const reader = new IncrementalPiSessionReader(FIXTURE);
  const normalizer = new PiSessionNormalizer({
    sessionId: 'pi:01a0d05c-0406-766c-a54e-8f03fa31c76f',
    source: FIXTURE,
  });
  const { lines } = await reader.read();
  return lines.flatMap((line) => normalizer.normalize(line));
}

describe('pi session normalization', () => {
  it('opens with the session header and the developer’s first words', async () => {
    const events = await normalizeFixture();

    expect(events[0]?.kind).toBe('session_started');
    expect(events[0]?.detail?.cwd).toBe('/tmp/demo-repo');

    const opening = events.find((event) => event.kind === 'user_instruction');
    expect(opening?.summary).toBe('Task: Add keyboard navigation between session threads.');
    expect(opening?.detail?.opening).toBe(true);
  });

  it('carries the worker’s reasoning, which pi records as plain text', async () => {
    const events = await normalizeFixture();
    const reasoning = events.filter((event) => event.kind === 'agent_reasoning');

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.detail?.text).toContain('how shortcuts are registered');
  });

  it('tells a command, a test run and a file edit apart', async () => {
    const events = await normalizeFixture();
    const kinds = events.map((event) => event.kind);

    expect(kinds).toContain('command_started');
    expect(kinds).toContain('test_started');
    expect(kinds).toContain('file_changed');

    const test = events.find((event) => event.kind === 'test_started');
    expect(test?.summary).toBe('Running tests: pnpm test');
  });

  it('reports a failed tool result as a failure of the thing that started', async () => {
    const events = await normalizeFixture();
    const finished = events.find((event) => event.kind === 'test_finished');

    expect(finished?.detail?.failed).toBe(true);
    expect(finished?.summary).toBe('Tests failed');
  });

  it('marks a command the developer ran, so it is not read as worker action', async () => {
    const events = await normalizeFixture();
    const byDeveloper = events.find((event) => event.detail?.byDeveloper === true);

    expect(byDeveloper?.kind).toBe('command_finished');
    expect(byDeveloper?.summary).toContain('The developer ran: git diff --stat');
    expect(byDeveloper?.detail?.exitCode).toBe(0);
  });

  /**
   * The one signal that puts a session in front of a person. A `session_waiting`
   * event alone is ordinary idleness; only the adapter knows this particular
   * stop was a question, and it has to say so without naming its provider.
   */
  it('flags asking the developer a question as awaiting a human', async () => {
    const events = await normalizeFixture();
    const waiting = events.filter((event) => event.kind === 'session_waiting');

    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.detail?.awaitingHuman).toBe(true);
    expect(waiting[0]?.summary).toBe('Asked the developer a question');
  });

  it('keeps every event addressable in the file and in the session tree', async () => {
    const events = await normalizeFixture();

    for (const event of events) {
      expect(event.rawRef.source).toBe(FIXTURE);
      expect(event.rawRef.line).toBeGreaterThan(0);
      expect(event.rawRef.byteOffset).toBeGreaterThanOrEqual(0);
      expect(event.raw).toBeTypeOf('object');
    }

    // Offsets must be strictly increasing, or a raw descent lands on the
    // wrong record.
    const offsets = events.map((event) => event.rawRef.byteOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

    const edit = events.find((event) => event.kind === 'file_changed');
    expect(edit?.detail?.entryId).toBe('b2c3d4e5');
    expect(edit?.detail?.parentId).toBe('a1b2c3d4');
  });

  it('keeps a record it does not understand rather than dropping it', async () => {
    const events = await normalizeFixture();
    const modelChange = events.find((event) =>
      event.summary.startsWith('Switched to'),
    );

    expect(modelChange?.kind).toBe('unknown');
    expect(modelChange?.raw).toMatchObject({ type: 'model_change' });
  });
});

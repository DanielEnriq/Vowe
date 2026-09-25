import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AdapterEvent } from '@vowe/core';
import {
  CodexRolloutNormalizer,
  IncrementalRolloutReader,
  stripHarnessContext,
} from '@vowe/adapter-codex';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'rollout-2026-09-24T12-54-21-01a0d456-eb96-7642-88e2-3308d95a1849.jsonl',
);

/**
 * Codex publishes no format specification, so this fixture reproduces the
 * record shapes observed across real rollout files rather than quoting one.
 * It is hand-written, so no real session content is committed.
 */
async function normalizeFixture(): Promise<AdapterEvent[]> {
  const reader = new IncrementalRolloutReader(FIXTURE);
  const normalizer = new CodexRolloutNormalizer({
    sessionId: 'codex:01a0d456-eb96-7642-88e2-3308d95a1849',
    source: FIXTURE,
  });
  const { lines } = await reader.read();
  return lines.flatMap((line) => normalizer.normalize(line));
}

describe('codex rollout normalization', () => {
  it('opens with the session and its origin', async () => {
    const events = await normalizeFixture();

    expect(events[0]?.kind).toBe('session_started');
    expect(events[0]?.detail?.cwd).toBe('/tmp/demo-repo');
    expect(events[0]?.detail?.originator).toBe('codex_work_desktop');
  });

  /**
   * Codex opens every session with a long `developer` preamble describing its
   * own harness. Treated as an instruction it would become the session's task,
   * which is the Codex version of the mistake Claude Code's `isMeta` avoids.
   */
  it('ignores the harness preamble and takes the developer’s words as the task', async () => {
    const events = await normalizeFixture();
    const instructions = events.filter((event) => event.kind === 'user_instruction');

    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.summary).toBe('Task: Fix the failing build on main.');
    expect(JSON.stringify(events)).not.toContain('Harness preamble');
  });

  /**
   * The role is not enough. Codex injects harness context into `user`
   * messages too, and the first one is normally a plugin catalogue — which is
   * how a real session came out of discovery titled "<recommended_plugins>".
   */
  it('does not mistake injected harness context for the developer speaking', async () => {
    const events = await normalizeFixture();

    expect(JSON.stringify(events)).not.toContain('recommended_plugins');
    expect(
      events.find((event) => event.kind === 'user_instruction')?.summary,
    ).toBe('Task: Fix the failing build on main.');
  });

  it('reads the turn lifecycle Codex records, rather than guessing at it', async () => {
    const events = await normalizeFixture();

    const closing = events.filter((event) => event.kind === 'agent_message');
    expect(closing.at(-1)?.detail?.text).toBe(
      'Pinned the dependency and the build is green.',
    );
    // The closing message and the stop are two separate facts.
    expect(events.at(-1)?.kind).toBe('session_waiting');
    expect(events.at(-1)?.summary).toBe('Finished a turn');
  });

  it('tells a plain command from a test run across both calling conventions', async () => {
    const events = await normalizeFixture();

    const command = events.find((event) => event.kind === 'command_started');
    expect(command?.summary).toBe('Ran: pnpm build');

    const test = events.find((event) => event.kind === 'test_started');
    expect(test?.summary).toBe('Running tests: pnpm test');
  });

  it('reads a non-zero exit as a failure', async () => {
    const events = await normalizeFixture();

    expect(events.find((event) => event.kind === 'command_finished')?.detail?.failed).toBe(
      false,
    );
    expect(events.find((event) => event.kind === 'test_finished')?.detail?.failed).toBe(
      true,
    );
  });

  /** The signal that lets a Codex session reach a person at all. */
  it('does not flag nonblocking optional input as waiting on a human', async () => {
    const events = await normalizeFixture();
    const asking = events.filter((event) => event.detail?.awaitingHuman === true);

    expect(asking).toHaveLength(0);
  });

  /**
   * The point of the whole capability model. Codex reasoning exists and is
   * unreadable, so it is kept as raw evidence and is deliberately *not* an
   * `agent_reasoning` event — there is no reasoning in it to show.
   */
  /**
   * Codex mixes both kinds within one session, so this is decided per record
   * rather than per provider: a readable summary becomes reasoning, and an
   * encrypted one is kept as evidence without being dressed up as reasoning.
   */
  it('reads the reasoning it can and keeps the rest as evidence', async () => {
    const events = await normalizeFixture();

    const readable = events.filter((event) => event.kind === 'agent_reasoning');
    expect(readable).toHaveLength(1);
    expect(readable[0]?.detail?.text).toBe('**Testing request mutation**');

    const kept = events.find((event) => event.detail?.readable === false);
    expect(kept?.kind).toBe('unknown');
    expect(kept?.detail?.encrypted).toBe(true);
    // The raw record survives, so a later Codex that fills `summary` loses
    // nothing that happened before.
    expect(kept?.raw).toMatchObject({ payload: { type: 'reasoning' } });
  });

  it('drops bookkeeping but keeps every record it merely does not understand', async () => {
    const events = await normalizeFixture();

    expect(JSON.stringify(events)).not.toContain('token_count');
    expect(events.every((event) => event.rawRef.source === FIXTURE)).toBe(true);

    const offsets = events.map((event) => event.rawRef.byteOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });
});

/**
 * Codex writes a great deal in the `user` role that no person typed, and the
 * set of wrappers grows: `<recommended_plugins>`, `<environment_context>`,
 * `<ide_opened_file>`, `<codex_delegation>`, an injected AGENTS.md. Each one
 * that gets through becomes a session's title, so this is checked directly
 * rather than only through a fixture.
 */
describe('telling the Codex application’s voice from the developer’s', () => {
  it('drops a message that is nothing but injected context', () => {
    expect(stripHarnessContext('<recommended_plugins>\n- Box\n</recommended_plugins>')).toBe('');
    expect(
      stripHarnessContext(
        '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nBe careful.\n</INSTRUCTIONS>',
      ),
    ).toBe('');
    expect(
      stripHarnessContext('# Files mentioned by the user:\n\n## a.txt: /tmp/a.txt\n'),
    ).toBe('');
    // Named nowhere above, and still recognised as the application talking.
    expect(stripHarnessContext('<some_future_wrapper>\nanything\n</some_future_wrapper>')).toBe('');
  });

  it('keeps the developer’s own ask out of an attachment listing', () => {
    expect(
      stripHarnessContext(
        '\n# Files mentioned by the user:\n\n## notes: /tmp/notes.txt\n\n## My request for Codex:\nRead the prompt\n',
      ),
    ).toBe('Read the prompt');
  });

  it('never eats a message that has real words in it', () => {
    expect(stripHarnessContext('is the agent not sitting in a loop?')).toBe(
      'is the agent not sitting in a loop?',
    );
    // Markup beside real words is a person quoting code, not the harness.
    expect(stripHarnessContext('why does <div>x</div> render twice?')).toBe(
      'why does <div>x</div> render twice?',
    );
    expect(
      stripHarnessContext('<environment_context>\n<cwd>/repo</cwd>\n</environment_context>\nFix the build.'),
    ).toBe('Fix the build.');
  });
});

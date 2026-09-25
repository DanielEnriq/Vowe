import { describe, expect, it } from 'vitest';

import { workerActivity } from '../src/product/worker-activity.js';
import type { NormalizedEvent } from '../src/types/events.js';
import { makeEvents, TEST_SESSION, type EventSpec } from './helpers.js';

/** The store assigns ids and sequences; this test needs them without a store. */
function events(specs: EventSpec[]): NormalizedEvent[] {
  return makeEvents(specs).map((event, index) => ({
    ...event,
    id: `e${index}`,
    seq: index + 1,
  }));
}

describe('workerActivity — what a worker is doing, without a model', () => {
  it('moves as the worker moves', () => {
    const inspecting = events([
      { kind: 'tool_started', summary: 'Read session-registry.ts' },
    ]);
    const editing = events([
      { kind: 'tool_started', summary: 'Read session-registry.ts' },
      {
        kind: 'file_changed',
        summary: 'Edited normalize.ts',
        detail: { input: { file_path: 'packages/adapter-pi/src/normalize.ts' } },
      },
    ]);
    const testing = events([
      { kind: 'tool_started', summary: 'Read session-registry.ts' },
      {
        kind: 'file_changed',
        summary: 'Edited normalize.ts',
        detail: { input: { file_path: 'packages/adapter-pi/src/normalize.ts' } },
      },
      {
        kind: 'test_started',
        summary: 'Running tests: pnpm exec vitest run packages/adapter-pi/test/normalize.test.ts',
        detail: {
          input: {
            command: 'pnpm exec vitest run packages/adapter-pi/test/normalize.test.ts',
          },
        },
      },
    ]);

    expect(workerActivity(inspecting)?.label).toBe('Reading session-registry.ts');
    expect(workerActivity(editing)?.label).toBe('Updating normalize.ts in adapter-pi');
    expect(workerActivity(testing)?.label).toBe('Running normalize tests');
  });

  it('holds the command on screen while it finishes, and says so when it fails', () => {
    const ran = [
      {
        kind: 'command_started' as const,
        summary: 'Ran: cd /repo && pnpm exec tsc --noEmit -p packages/core | head -30',
        detail: {
          toolUseId: 't1',
          input: { command: 'cd /repo && pnpm exec tsc --noEmit -p packages/core | head -30' },
        },
      },
    ];

    const running = workerActivity(events(ran));
    const finished = workerActivity(
      events([
        ...ran,
        {
          kind: 'command_finished',
          summary: 'Command finished: cd /repo && pnpm exec tsc --noEmit -p packages/core | head -30',
          detail: { toolUseId: 't1', failed: false },
        },
      ]),
    );
    const failed = workerActivity(
      events([
        ...ran,
        {
          kind: 'command_finished',
          summary: 'Command failed: cd /repo && pnpm exec tsc --noEmit -p packages/core | head -30',
          detail: { toolUseId: 't1', failed: true },
        },
      ]),
    );

    // The `cd` says where, not what; the pipe is a second command. Neither is
    // the thing the worker is doing.
    expect(running?.label).toBe('Checking types');
    // Finishing is not a new thing to be doing, so the line does not flicker.
    expect(finished?.label).toBe(running?.label);
    // Failing is.
    expect(failed?.label).toBe('Failed: Checking types');
  });

  it('names a test run by its target, not by the runner', () => {
    const suite = events([
      {
        kind: 'test_started',
        summary: 'Running tests: pnpm test',
        detail: { input: { command: 'pnpm test' } },
      },
    ]);
    const scoped = events([
      {
        kind: 'test_started',
        summary: 'Running tests: pnpm exec vitest run packages/core/test/multi-provider.test.ts',
        detail: {
          input: {
            command: 'pnpm exec vitest run packages/core/test/multi-provider.test.ts',
          },
        },
      },
    ]);

    expect(workerActivity(suite)?.label).toBe('Running the test suite');
    expect(workerActivity(scoped)?.label).toBe('Running multi-provider tests');
  });

  it('passes over a generic summary and keeps walking back', () => {
    const activity = workerActivity(
      events([
        { kind: 'tool_started', summary: 'Searched for applySemanticState' },
        { kind: 'tool_started', summary: 'Used WebFetch' },
        { kind: 'tool_finished', summary: 'WebFetch finished' },
      ]),
    );

    // Neither "Used WebFetch" nor "WebFetch finished" tells anybody anything,
    // so the last line that did is the one shown.
    expect(activity?.label).toBe('Searching for applySemanticState');
  });

  it('returns nothing rather than something generic', () => {
    expect(workerActivity([])).toBeNull();
    expect(
      workerActivity(
        events([
          { kind: 'tool_started', summary: 'Used Foo' },
          { kind: 'unknown', summary: 'Unrecognized bar record' },
        ]),
      ),
    ).toBeNull();
  });

  it('keeps shell payloads and worker prose in evidence, not primary activity', () => {
    expect(workerActivity(events([
      { kind: 'command_started', summary: 'Running P=$(find ~/.pi/agent/sessions)', detail: { input: { command: 'P=$(find ~/.pi/agent/sessions)' } } },
      { kind: 'agent_message', summary: 'For the **session text-chat path**, this is the exact base system prompt.' },
    ]))).toBeNull();
  });

  it('collapses a run of edits into one line naming the package', () => {
    const activity = workerActivity(
      events([
        { kind: 'agent_message', summary: 'Starting on the adapter.' },
        {
          kind: 'file_changed',
          summary: 'Edited normalize.ts',
          detail: { input: { file_path: 'packages/adapter-pi/src/normalize.ts' } },
        },
        {
          kind: 'file_changed',
          summary: 'Edited adapter.ts',
          detail: { input: { file_path: 'packages/adapter-pi/src/adapter.ts' } },
        },
        {
          kind: 'file_changed',
          summary: 'Edited paths.ts',
          detail: { input: { file_path: 'packages/adapter-pi/src/paths.ts' } },
        },
      ]),
    );

    expect(activity?.label).toBe('Updating 3 files in adapter-pi');
    // Every event the line stands for, so nothing becomes unreachable.
    expect(activity?.eventIds).toEqual(['e1', 'e2', 'e3']);
    expect(activity?.refs).toContainEqual({ kind: 'diff', sessionId: TEST_SESSION });
  });

  it('reports what a test run actually printed', () => {
    const passed = workerActivity(
      events([
        {
          kind: 'test_finished',
          summary: 'Tests passed or completed',
          detail: { output: 'Test Files 38 passed\n Tests 357 passed (357)' },
        },
      ]),
    );
    const failed = workerActivity(
      events([
        {
          kind: 'test_finished',
          summary: 'Tests failed',
          detail: { failed: true, output: 'Tests 2 failed | 355 passed' },
        },
      ]),
    );

    expect(passed?.label).toBe('Test suite passed 357 / 357');
    expect(failed?.label).toBe('Test suite failed · 355 passed, 2 failed');
  });

  it('settles when the session finishes', () => {
    const activity = workerActivity(
      events([
        { kind: 'file_changed', summary: 'Edited x.ts' },
        { kind: 'session_finished', summary: 'Session ended' },
      ]),
    );

    expect(activity?.label).toBe('Finished');
    expect(activity?.phase).toBe('finished');
  });

  it('ignores reasoning, so a talkative provider gets no advantage', () => {
    const withReasoning = workerActivity(
      events([
        { kind: 'tool_started', summary: 'Read session-registry.ts' },
        { kind: 'agent_reasoning', summary: 'Let me think about liveness…' },
      ]),
    );
    const without = workerActivity(
      events([{ kind: 'tool_started', summary: 'Read session-registry.ts' }]),
    );

    expect(withReasoning?.label).toBe(without?.label);
    expect(without?.label).toBe('Reading session-registry.ts');
  });
});

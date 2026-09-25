import { describe, expect, it } from 'vitest';

import { attentionFor } from '../src/product/attention.js';
import type { NormalizedEvent } from '../src/types/events.js';
import { makeEvents, testSession, type EventSpec } from './helpers.js';

const PROJECT = 'project:repo';

/** Normalized in memory: nothing here needs a store or a disk. */
function trace(specs: EventSpec[]): NormalizedEvent[] {
  return makeEvents(specs).map((event, index) => ({
    ...event,
    id: `e${index}`,
    seq: index + 1,
  }));
}

const asked: EventSpec = {
  kind: 'session_waiting',
  summary: 'Asked the developer a question',
  detail: { tool: 'AskUserQuestion', toolUseId: 'tu-1', awaitingHuman: true },
};

describe('Needs You — admission', () => {
  it.each(['toolUseId', 'toolCallId', 'callId'])('clears answered requests correlated by %s', (key) => {
    const items = attentionFor(testSession(), PROJECT, trace([
      { kind: 'session_waiting', detail: { [key]: 'request', awaitingHuman: true } },
      { kind: 'tool_finished', detail: { [key]: 'request' } },
    ]));
    expect(items).toEqual([]);
  });
  it('admits a permission request', () => {
    const items = attentionFor(
      testSession({ status: 'working' }),
      PROJECT,
      trace([{ kind: 'permission_requested', summary: 'Wants to run a command' }]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('permission');
    expect(items[0]!.summary).toBe('Wants to run a command');
    expect(items[0]!.refs).toEqual([
      { kind: 'event', sessionId: 'claude-code:test-session', eventId: 'e0' },
    ]);
  });

  it('admits a wait the adapter marked as waiting on a human', () => {
    const items = attentionFor(testSession({ status: 'working' }), PROJECT, trace([asked]));

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('decision');
  });

  /**
   * The load-bearing case. Without the flag the event says only that the
   * worker stopped, which is not evidence that a person can help.
   */
  it('ignores a wait with no human-decision marker', () => {
    const items = attentionFor(
      testSession({ status: 'working' }),
      PROJECT,
      trace([
        {
          kind: 'session_waiting',
          summary: 'Paused',
          detail: { tool: 'Something', toolUseId: 'tu-9' },
        },
      ]),
    );

    expect(items).toEqual([]);
  });

  /** Session *status* `waiting` is idleness between turns, not a question. */
  it('does not turn an ordinary waiting session into attention', () => {
    const items = attentionFor(
      testSession({ status: 'waiting' }),
      PROJECT,
      trace([
        { kind: 'tool_started', summary: 'Read config.ts' },
        { kind: 'file_changed', summary: 'Edited config.ts' },
      ]),
    );

    expect(items).toEqual([]);
  });

  it('does not treat progress or completion as attention', () => {
    const items = attentionFor(
      testSession({ status: 'working' }),
      PROJECT,
      trace([
        { kind: 'test_started', summary: 'Running tests' },
        { kind: 'test_finished', summary: 'Tests passed or completed' },
        { kind: 'agent_message', summary: 'Refactored the reconnect path' },
        { kind: 'session_finished', summary: 'Session finished' },
      ]),
    );

    expect(items).toEqual([]);
  });

  it('gives the same item the same id every time', () => {
    const events = trace([asked]);
    const session = testSession({ status: 'working' });

    expect(attentionFor(session, PROJECT, events)).toEqual(
      attentionFor(session, PROJECT, events),
    );
    expect(attentionFor(session, PROJECT, events)[0]!.id).toBe(
      'claude-code:test-session#e0',
    );
  });
});

describe('Needs You — resolution', () => {
  it('drops a question once its own result comes back', () => {
    const items = attentionFor(
      testSession({ status: 'working' }),
      PROJECT,
      trace([
        asked,
        {
          kind: 'tool_finished',
          summary: 'AskUserQuestion finished',
          detail: { tool: 'AskUserQuestion', toolUseId: 'tu-1' },
        },
      ]),
    );

    expect(items).toEqual([]);
  });

  it('keeps a question when some other tool finished', () => {
    const items = attentionFor(
      testSession({ status: 'working' }),
      PROJECT,
      trace([
        asked,
        {
          kind: 'tool_finished',
          summary: 'Read finished',
          detail: { tool: 'Read', toolUseId: 'tu-2' },
        },
      ]),
    );

    expect(items).toHaveLength(1);
  });

  /**
   * Typing something unrelated is not approving the plan you were shown.
   * Resolution takes matching evidence or nothing.
   */
  it('does not treat a later instruction as an answer', () => {
    const items = attentionFor(
      testSession({ status: 'working' }),
      PROJECT,
      trace([asked, { kind: 'user_instruction', summary: 'also fix the lint error' }]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('decision');
  });

  it.each(['finished', 'idle', 'unknown'] as const)(
    'projects nothing for a %s session',
    (status) => {
      expect(attentionFor(testSession({ status }), PROJECT, trace([asked]))).toEqual([]);
    },
  );
});

import { describe, expect, it } from 'vitest';

import { fleetStatusOf } from '../src/fleet/status.js';
import type { CaptainExchange } from '../src/fleet/types.js';
import { attentionFor } from '../src/product/attention.js';
import type { NormalizedEvent } from '../src/types/events.js';
import { testSession } from './helpers.js';

const PROJECT = 'git:fleet';
const session = testSession({ projectId: PROJECT, status: 'working' });
const AT = '2026-10-01T10:00:00.000Z';

function event(seq: number, kind: NormalizedEvent['kind'], detail: Record<string, unknown> = {}): NormalizedEvent {
  return {
    id: `e${seq}`,
    sessionId: session.id,
    seq,
    at: AT,
    kind,
    summary: kind,
    detail,
    raw: {},
    rawRef: { source: 't.jsonl', byteOffset: seq, line: seq },
  };
}

const asked = event(2, 'session_waiting', { tool: 'AskUserQuestion', toolUseId: 'q1', awaitingHuman: true });

function exchange(overrides: Partial<CaptainExchange>): CaptainExchange {
  return {
    id: 'x1',
    projectId: PROJECT,
    askerSessionId: session.id,
    questionId: 'q1',
    toolUseId: 'q1',
    captainSessionId: 'claude-code:captain',
    question: 'Q?',
    captainAnswer: null,
    route: 'captain',
    userAnswer: null,
    status: 'pending',
    delivery: null,
    askedAt: AT,
    answeredAt: null,
    ...overrides,
  };
}

function status(
  events: NormalizedEvent[],
  extra: Partial<Parameters<typeof fleetStatusOf>[0]> = {},
  s = session,
) {
  return fleetStatusOf({ session: s, attention: attentionFor(s, PROJECT, events), events, ...extra });
}

describe('fleetStatusOf', () => {
  it('is needs-you for an unanswered question nobody else has', () => {
    expect(status([event(1, 'session_started'), asked])).toBe('needs-you');
  });

  it('is not needs-you while a wired captain has the question', () => {
    expect(status([event(1, 'session_started'), asked], { exchanges: [exchange({})] })).toBe('running');
  });

  it('is needs-you when the captain passed it, until the developer answers', () => {
    const passed = exchange({ route: 'you', status: 'passed', passedToYouReason: 'your call' });
    expect(status([asked], { exchanges: [passed] })).toBe('needs-you');
    const answered = exchange({ route: 'you', status: 'answered', userAnswer: 'x' });
    expect(status([asked], { exchanges: [answered] })).toBe('running');
  });

  it('follows the provider outcome over the session status', () => {
    const events = [event(1, 'session_started'), event(2, 'agent_message')];
    expect(status(events, { outcome: { sessionId: session.id, state: 'working', at: AT } })).toBe('running');
    expect(status(events, { outcome: { sessionId: session.id, state: 'completed', at: AT } })).toBe('done');
    expect(status(events, { outcome: { sessionId: session.id, state: 'ended', at: AT } })).toBe('done');
    expect(status(events, { outcome: { sessionId: session.id, state: 'failed', at: AT, error: 'x' } })).toBe('failed');
  });

  it('reads done and failed from a finish event where there is no outcome', () => {
    const idle = testSession({ projectId: PROJECT, status: 'idle' });
    expect(status([event(1, 'session_started'), event(2, 'session_finished')], {}, idle)).toBe('done');
    expect(status([event(1, 'session_finished', { failed: true })], {}, idle)).toBe('failed');
    expect(status([event(1, 'session_started')], {}, idle)).toBe('idle');
  });

  it('puts a pending question ahead of a failure', () => {
    const passed = exchange({ route: 'you', status: 'pending', captainSessionId: null });
    expect(
      status([asked], { exchanges: [passed], outcome: { sessionId: session.id, state: 'failed', at: AT } }),
    ).toBe('needs-you');
  });
});

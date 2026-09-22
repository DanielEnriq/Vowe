import { describe, expect, it } from 'vitest';

import type { AgentSession } from '@vowe/core';
import {
  looksLikeInstruction,
  resolveDestination,
  shouldOfferWorker,
  workerUnavailableReason,
} from '../src/renderer/state/composer.js';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'claude-code:s1',
    provider: 'claude-code',
    providerSessionId: 's1',
    attachMode: 'managed',
    task: null,
    displayLabel: 'Unified Ask',
    cwd: '/repo',
    projectId: 'git:abc',
    status: 'working',
    createdAt: '2026-09-22T09:00:00.000Z',
    lastActivityAt: '2026-09-22T09:00:00.000Z',
    capabilities: {
      observe: true,
      sendInstruction: true,
      interrupt: true,
      resume: true,
    },
    semanticState: null,
    ...overrides,
  };
}

const NO_CONTROL = {
  observe: true,
  sendInstruction: false,
  interrupt: false,
  resume: false,
};

describe('Composer destination — talking about is not talking to', () => {
  it('routes to Vowe by default', () => {
    expect(resolveDestination('vowe', session()).effective).toBe('vowe');
  });

  it('routes to the worker when the session can be instructed', () => {
    const state = resolveDestination('worker', session());
    expect(state.effective).toBe('worker');
    expect(state.workerAvailable).toBe(true);
    expect(state.workerUnavailableReason).toBeNull();
  });

  /**
   * The load-bearing case: a destination that cannot be reached must never
   * stay armed, or send would quietly do something other than what the chip
   * says.
   */
  it('never stays armed at a worker it cannot reach', () => {
    const state = resolveDestination(
      'worker',
      session({ attachMode: 'external-live', capabilities: NO_CONTROL }),
    );
    expect(state.requested).toBe('worker');
    expect(state.effective).toBe('vowe');
    expect(state.workerAvailable).toBe(false);
  });

  it('explains why, in words worth showing', () => {
    expect(
      workerUnavailableReason(
        session({ attachMode: 'external-live', capabilities: NO_CONTROL }),
      ),
    ).toMatch(/terminal Vowe does not own/);

    expect(
      workerUnavailableReason(session({ status: 'finished', capabilities: NO_CONTROL })),
    ).toMatch(/finished/);

    expect(workerUnavailableReason(null)).toMatch(/No session/);
  });

  it('is available exactly when the capability says so', () => {
    expect(workerUnavailableReason(session())).toBeNull();
    expect(workerUnavailableReason(session({ capabilities: NO_CONTROL }))).not.toBeNull();
  });
});

describe('Composer — an imperative earns an offer, never a forward', () => {
  it('recognises an instruction-shaped draft', () => {
    for (const draft of [
      "Don't change the public API. Find another approach.",
      'Stop and revert that.',
      'Tell it to use the other helper.',
      'refactor the reconnect path',
    ]) {
      expect(looksLikeInstruction(draft), draft).toBe(true);
    }
  });

  it('leaves ordinary questions alone', () => {
    for (const draft of [
      'What is it doing?',
      'Does that break the CLI path?',
      'Why is it changing ContextNavigator?',
      '',
    ]) {
      expect(looksLikeInstruction(draft), draft).toBe(false);
    }
  });

  it('offers only when the worker could actually receive it', () => {
    const reachable = resolveDestination('vowe', session());
    expect(shouldOfferWorker("Don't change the public API.", reachable)).toBe(true);

    const unreachable = resolveDestination(
      'vowe',
      session({ attachMode: 'external-live', capabilities: NO_CONTROL }),
    );
    expect(shouldOfferWorker("Don't change the public API.", unreachable)).toBe(false);
  });

  it('does not offer when the developer is already talking to the worker', () => {
    const armed = resolveDestination('worker', session());
    expect(shouldOfferWorker("Don't change the public API.", armed)).toBe(false);
  });
});

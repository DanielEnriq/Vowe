import { describe, expect, it } from 'vitest';

import {
  CommunicationPolicy,
  defaultDecision,
} from '../src/communication/communication-policy.js';
import { HeuristicDecisionRouter } from '../src/decision/decision-router.js';
import type { DecisionRouter } from '../src/decision/decision-router.js';
import type { LlmClient } from '../src/llm/llm-client.js';
import type {
  CommunicationAction,
  SurfaceUpdate,
} from '../src/observation/trace-window.js';
import { TEST_SESSION } from './helpers.js';

const WEIRD: SurfaceUpdate = {
  id: 'candidate-weird',
  sessionId: TEST_SESSION,
  windowId: 'w-1',
  message:
    'It has tried four variations of the same fix and keeps hitting the same failing assertion.',
  whyNow: 'Four runs of the same test have failed identically, each after another edit.',
  refs: [],
  urgency: 'high',
  createdAt: '2026-02-11T09:10:00.000Z',
};

const ROUTINE: SurfaceUpdate = {
  ...WEIRD,
  id: 'candidate-routine',
  message: 'Targeted tests pass and it is now running the full suite.',
  whyNow: 'Steady progress.',
  urgency: 'low',
};

/** A decision model that answers with whatever the test wants. */
function routerAnswering(
  answer: CommunicationAction,
  extras: { confidence?: number; probabilities?: Record<string, number> } = {},
): DecisionRouter {
  return {
    name: 'stub',
    available: true,
    async choose() {
      return { choice: answer as never, ...extras };
    },
    async score() {
      return null;
    },
    async noul() {
      return null;
    },
  };
}

function llmAnswering(text: string): LlmClient {
  return {
    async summarizeSession() {
      throw new Error('not used here');
    },
    async answerQuestion() {
      return text;
    },
  };
}

describe('CommunicationPolicy — acceptance 4: proactive surfacing', () => {
  it('approves a weird development under "only tell me if something looks weird"', async () => {
    const policy = new CommunicationPolicy({ router: routerAnswering('speak_now') });
    const decision = await policy.evaluate(WEIRD, 'Only tell me if something looks weird.');

    expect(decision.action).toBe('speak_now');
    expect(decision.source).toBe('jev');
    expect(decision.reason).toContain('weird');
  });

  it('ignores routine progress under the same preference', async () => {
    const policy = new CommunicationPolicy({ router: routerAnswering('ignore') });
    const decision = await policy.evaluate(ROUTINE, 'Only tell me if something looks weird.');
    expect(decision.action).toBe('ignore');
  });

  it('uses the decision model’s choice directly, with no threshold logic', async () => {
    // Low confidence must not silently override the answer. Confidence is
    // recorded for later tuning; nothing branches on it, and a test is the
    // only thing that keeps it that way.
    const policy = new CommunicationPolicy({
      router: routerAnswering('speak_now', {
        confidence: 0.11,
        probabilities: { speak_now: 0.3, ignore: 0.28, queue: 0.22, quiet_context: 0.2 },
      }),
    });
    const decision = await policy.evaluate(ROUTINE, 'Keep me closely updated.');

    expect(decision.action).toBe('speak_now');
    expect(decision.metadata?.confidence).toBe(0.11);
    expect(decision.metadata?.probabilities?.['speak_now']).toBe(0.3);
  });

  it('falls back to a model call when no decision router answers', async () => {
    const policy = new CommunicationPolicy({
      router: new HeuristicDecisionRouter(),
      llm: llmAnswering('quiet_context'),
    });
    const decision = await policy.evaluate(ROUTINE, 'Only interrupt me if I need to do something.');
    expect(decision.action).toBe('quiet_context');
    expect(decision.source).toBe('llm');
  });

  it('falls back again, deterministically, when nothing is configured', async () => {
    const policy = new CommunicationPolicy();
    expect((await policy.evaluate(WEIRD, null)).action).toBe('speak_now');
    expect((await policy.evaluate(ROUTINE, null)).action).toBe('quiet_context');
    expect((await policy.evaluate(WEIRD, null)).source).toBe('default');
  });

  it('survives a decision model that throws', async () => {
    const exploding: DecisionRouter = {
      name: 'exploding',
      available: true,
      async choose() {
        throw new Error('network down');
      },
      async score() {
        return null;
      },
      async noul() {
        return null;
      },
    };
    const errors: string[] = [];
    const policy = new CommunicationPolicy({
      router: exploding,
      onError: (scope) => errors.push(scope),
    });

    const decision = await policy.evaluate(WEIRD, 'Only tell me if something looks weird.');
    expect(decision.action).toBe('speak_now'); // via the deterministic floor
    expect(decision.source).toBe('default');
    expect(errors).toContain('policy:router');
  });

  it('ignores an option the decision model was never offered', async () => {
    const policy = new CommunicationPolicy({
      router: routerAnswering('shout_about_it' as CommunicationAction),
    });
    // Falls through to the default rather than passing an invalid action on.
    const decision = await policy.evaluate(ROUTINE, 'Keep me updated.');
    expect(['ignore', 'quiet_context', 'speak_now', 'queue']).toContain(decision.action);
    expect(decision.source).toBe('default');
  });

  it('errs quiet by default, because a wrong interruption is worse than silence', () => {
    expect(defaultDecision(ROUTINE, null).action).toBe('quiet_context');
    expect(defaultDecision({ ...ROUTINE, urgency: 'normal' }, 'tell me things').action).toBe(
      'queue',
    );
  });
});

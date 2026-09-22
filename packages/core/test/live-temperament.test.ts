import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { CommunicationPolicy } from '../src/communication/communication-policy.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { LiveBridge } from '../src/live/live-bridge.js';
import { VO_SYSTEM_PROMPT } from '../src/live/vo-prompt.js';
import { ObservationService } from '../src/observation/observation-service.js';
import {
  DEFAULT_TEMPERAMENT,
  temperamentGuidance,
  type TemperamentProfile,
} from '../src/index.js';
import type { ObservationLlm } from '../src/llm/observation-llm.js';
import { FakeLiveTransport } from './fake-live-transport.js';
import { TEST_SESSION, temporaryStore, testSession } from './helpers.js';

const observer: ObservationLlm = {
  async observeWindow() {
    return { summary: 'not used here' };
  },
  async investigate() {
    return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
  },
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function bridgeWith(options: {
  temperament?: TemperamentProfile;
  voice?: string | null;
}): Promise<{ bridge: LiveBridge; transport: FakeLiveTransport }> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());

  const navigator = new ContextNavigator({ store });
  const transport = new FakeLiveTransport();
  const bridge = new LiveBridge({
    transport,
    observation: new ObservationService({
      store,
      observer,
      navigator,
      policy: new CommunicationPolicy(),
    }),
    delegated: new DelegatedQuestionRunner({ store, navigator, investigator: observer }),
    ...(options.temperament ? { temperament: () => options.temperament } : {}),
    ...(options.voice !== undefined ? { voice: () => options.voice ?? null } : {}),
  });
  return { bridge, transport };
}

describe('Live voice — temperament and voice reach the call', () => {
  it('leaves the shipped prompt untouched when no temperament is set', async () => {
    const { bridge, transport } = await bridgeWith({});
    await bridge.start(TEST_SESSION, 'offer');
    expect(transport.lastInstructions).toBe(VO_SYSTEM_PROMPT);
    expect(bridge.systemPrompt).toBe(VO_SYSTEM_PROMPT);
  });

  it('appends the developer’s temperament to Vo’s standing instructions', async () => {
    const temperament: TemperamentProfile = {
      ...DEFAULT_TEMPERAMENT,
      casual: 1,
      personalInstruction: 'Never guess at timings.',
    };
    const { bridge, transport } = await bridgeWith({ temperament });
    await bridge.start(TEST_SESSION, 'offer');

    expect(transport.lastInstructions).toBe(
      `${VO_SYSTEM_PROMPT}\n\n${temperamentGuidance(temperament)}`,
    );
    expect(transport.lastInstructions).toContain('"Never guess at timings."');
  });

  /**
   * What Vo was told and what was recorded as having told it come from one
   * builder, so they cannot drift.
   */
  it('records the same instructions it sent', async () => {
    const { bridge, transport } = await bridgeWith({ temperament: DEFAULT_TEMPERAMENT });
    await bridge.start(TEST_SESSION, 'offer');
    expect(transport.lastInstructions).toBe(bridge.systemPrompt);
  });

  it('passes a chosen voice through to the transport', async () => {
    const { bridge, transport } = await bridgeWith({ voice: 'fake-two' });
    await bridge.start(TEST_SESSION, 'offer');
    expect(transport.lastVoice).toBe('fake-two');
  });

  it('sends no voice at all when the developer has not chosen one', async () => {
    const { bridge, transport } = await bridgeWith({ voice: null });
    await bridge.start(TEST_SESSION, 'offer');
    expect(transport.lastVoice).toBeUndefined();
  });

  it('offers only the voices the transport declares', async () => {
    const { transport } = await bridgeWith({});
    expect(transport.voices.map((voice) => voice.id)).toEqual(['fake-one', 'fake-two']);
  });
});

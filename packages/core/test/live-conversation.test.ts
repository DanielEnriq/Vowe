import { afterEach, describe, expect, it } from 'vitest';

import { CommunicationPolicy } from '../src/communication/communication-policy.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { VoweRunRecorder } from '../src/execution/run-recorder.js';
import { LiveBridge } from '../src/live/live-bridge.js';
import { ObservationService } from '../src/observation/observation-service.js';
import {
  asModelContext,
  recentConversation,
} from '../src/product/conversation-context.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { SessionRegistry } from '../src/registry/session-registry.js';
import { FakeLiveSideband, FakeLiveTransport } from './fake-live-transport.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** Turns close on silence; the tests use a short one and wait for it. */
const TURN_SILENCE_MS = 20;
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRegistry(store: { getSession: (id: string) => unknown }): SessionRegistry {
  return {
    get: (id: string) => store.getSession(id),
    on: () => undefined,
  } as unknown as SessionRegistry;
}

function investigator(
  run: (input: InvestigationInput, tools: ReadOnlyToolset) => Promise<DelegatedAnswer>,
): ObservationLlm {
  return {
    async observeWindow(): Promise<WindowObservation> {
      return { summary: 'not used here' };
    },
    investigate: run,
  };
}

interface Fixture {
  store: SqliteEventStore;
  bridge: LiveBridge;
  sideband: FakeLiveSideband;
  reopen: () => Promise<SqliteEventStore>;
}

async function onCall(
  options: {
    answer?: (input: InvestigationInput, tools: ReadOnlyToolset) => Promise<DelegatedAnswer>;
  } = {},
): Promise<Fixture> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());

  const navigator = new ContextNavigator({ store });
  const model = investigator(
    options.answer ??
      (async () => ({
        spokenAnswer: 'The reconnect test expects one replayed message.',
        fullAnswer:
          'The reconnect test is failing because both paths now enter the same insertion function.',
        refs: [],
      })),
  );

  const observation = new ObservationService({
    store,
    registry: fakeRegistry(store),
    observer: model,
    navigator,
    policy: new CommunicationPolicy(),
  });

  const transport = new FakeLiveTransport();
  const bridge = new LiveBridge({
    transport,
    observation,
    delegated: new DelegatedQuestionRunner({ store, navigator, investigator: model }),
    store,
    runs: new VoweRunRecorder({ store }),
    turnSilenceMs: TURN_SILENCE_MS,
  });

  await bridge.start(TEST_SESSION, 'offer');
  return { store, bridge, sideband: transport.sideband!, reopen: fixture.reopen };
}

describe('ordinary live conversation becomes durable history', () => {
  it('persists what the user said and what Vowe said back', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.userSays('How is the reconnect work going?');
    sideband.voSays('Slowly, but the tests are closer.');
    await settle();
    await bridge.stop();

    const conversation = store.getConversation(TEST_SESSION);
    expect(conversation.map((entry) => [entry.role, entry.text])).toEqual([
      ['user_message', 'How is the reconnect work going?'],
      ['companion_message', 'Slowly, but the tests are closer.'],
    ]);
  });

  it('keeps a filler, because a conversation is not only its important parts', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.userSays('Have a look at the failing test.');
    sideband.voSays('On it.');
    await settle();
    await bridge.stop();

    const said = store.getConversation(TEST_SESSION).map((entry) => entry.text);
    expect(said).toContain('On it.');
  });

  it('survives leaving voice and restarting Vowe', async () => {
    const { sideband, bridge, reopen } = await onCall();

    sideband.userSays('Anything surprising?');
    sideband.voSays('Not yet.');
    await settle();
    await bridge.stop();

    const restarted = await reopen();
    expect(restarted.getConversation(TEST_SESSION)).toHaveLength(2);
  });

  it('records one spoken response as one execution, linked to the turn it produced', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.userSays('Still going?');
    sideband.voSays('Still going.');
    await settle();
    await bridge.stop();

    const spoken = store
      .getConversation(TEST_SESSION)
      .find((entry) => entry.role === 'companion_message')!;
    const run = store.getRunForEntry(spoken.id);
    expect(run).not.toBeNull();
    expect(run!.kind).toBe('live_response');
    expect(run!.status).toBe('completed');
    expect(run!.provider).toBe('fake');

    // Normalized conversation and the standing instructions. Never audio.
    const input = store
      .getTraceItems(run!.id)
      .find((item) => item.kind === 'model_input');
    expect(input).toBeDefined();
    expect(JSON.stringify(input!.payload)).toContain('instructions');

    // One spoken turn, one execution. Not one per fragment.
    expect(
      store.getRuns(TEST_SESSION).filter((each) => each.kind === 'live_response'),
    ).toHaveLength(1);

    // The provider exposes no reasoning for a live response, so none is stored.
    expect(
      store
        .getTraceItems(run!.id)
        .filter((item) => item.kind.startsWith('reasoning')),
    ).toEqual([]);
  });
});

describe('a turn is stored exactly once, whatever the provider does', () => {
  it('ignores a redelivered turn rather than storing it twice', async () => {
    const { store, sideband, bridge } = await onCall();

    const spoken = {
      type: 'transcript.assistant' as const,
      delta: 'The suite is green again.',
      startMs: 4000,
      endMs: 5000,
    };
    sideband.replay(spoken);
    await settle();
    // The same fragments arriving again — a retry, or a reconnect replaying
    // what it had already sent.
    sideband.replay(spoken);
    await settle();
    await bridge.stop();

    const conversation = store.getConversation(TEST_SESSION);
    expect(conversation).toHaveLength(1);
    expect(store.getDeliveries(conversation[0]!.id)).toHaveLength(1);
  });
});

describe('interruption', () => {
  it('keeps the whole answer and records how far the audio got', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.voSays(
      'The reconnect path is broken because X, Y and Z, and the replay path is next.',
      { startMs: 1000, endMs: 6000 },
    );
    bridge.reportPlayback({ kind: 'started', at: '2026-02-11T10:00:00.000Z' });
    // The user begins speaking before Vo's audio had finished. Both offsets
    // are the provider's own, on one timeline.
    sideband.userSays('Wait — what about the replay path?', {
      startMs: 2840,
      endMs: 4000,
    });
    await settle();
    // The renderer's measurement lands afterwards, as it does in practice.
    bridge.reportPlayback({
      kind: 'stopped',
      at: '2026-02-11T10:00:02.000Z',
      audioMs: 1840,
    });
    await settle();
    await bridge.stop();

    const conversation = store.getConversation(TEST_SESSION);
    const answer = conversation.find((entry) => entry.role === 'companion_message')!;
    // The entry is the whole of what Vowe said, not the part that was heard.
    expect(answer.text).toContain('the replay path is next');

    const [delivery] = store.getDeliveries(answer.id);
    expect(delivery!.status).toBe('interrupted');
    expect(delivery!.audioEndMs).toBe(1840);
    // Nobody can say where the words were cut, so nothing claims to.
    expect('deliveredText' in delivery!).toBe(false);

    // The turn that cut it off, attached once it had been transcribed.
    const interrupting = conversation.find((entry) => entry.role === 'user_message')!;
    expect(store.getDeliveries(answer.id)[0]!.interruptedByEntryId).toBe(
      interrupting.id,
    );

    // The response stopped when the user talked over it; the run says so
    // rather than claiming the model finished.
    expect(store.getRunForEntry(answer.id)!.status).toBe('cancelled');
  });

  it('keeps every fragment the model actually produced, and invents no more', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.voSays('The failure is in the insertion branch', {
      startMs: 0,
      endMs: 2000,
    });
    sideband.voSays(' and the replay', { startMs: 2000, endMs: 3000 });
    bridge.reportPlayback({ kind: 'started', at: '2026-02-11T10:00:00.000Z' });
    sideband.userSays('Stop there.', { startMs: 2600, endMs: 3400 });
    await settle();
    await bridge.stop();

    const answer = store
      .getConversation(TEST_SESSION)
      .find((entry) => entry.role === 'companion_message')!;
    expect(answer.text).toBe('The failure is in the insertion branch and the replay');
    expect(store.getDeliveries(answer.id)[0]!.status).toBe('interrupted');
  });

  it('says a delivery was cancelled when the connection went away mid-answer', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.voSays('The suite is still running', { startMs: 0, endMs: 3000 });
    bridge.reportPlayback({ kind: 'started', at: '2026-02-11T10:00:00.000Z' });
    bridge.reportPlayback({ kind: 'lost', at: '2026-02-11T10:00:01.000Z' });
    await settle();
    await bridge.stop();

    const answer = store
      .getConversation(TEST_SESSION)
      .find((entry) => entry.role === 'companion_message')!;
    expect(store.getDeliveries(answer.id)[0]!.status).toBe('cancelled');
  });
});

describe('what a later model is told', () => {
  it('carries both the full answer and the fact that it was cut off', async () => {
    const { store, sideband, bridge } = await onCall();

    sideband.voSays('The reconnect path is broken because X, Y and Z.', {
      startMs: 0,
      endMs: 5000,
    });
    bridge.reportPlayback({ kind: 'started', at: '2026-02-11T10:00:00.000Z' });
    sideband.userSays('Hang on.', { startMs: 1800, endMs: 2400 });
    await settle();
    bridge.reportPlayback({
      kind: 'stopped',
      at: '2026-02-11T10:00:02.000Z',
      audioMs: 1800,
    });
    await settle();
    await bridge.stop();

    const context = asModelContext(recentConversation(store, TEST_SESSION));
    const spoken = context.find((turn) => turn.speaker === 'vo')!;
    expect(spoken.text).toContain('X, Y and Z');
    expect(spoken.text).toContain('Interrupted');
    expect(spoken.text).toContain('1.8s');
    expect(spoken.text).toContain('did not hear all of this');
  });
});

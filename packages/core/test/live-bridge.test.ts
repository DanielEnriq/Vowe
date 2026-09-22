import { afterEach, describe, expect, it } from 'vitest';

import { CommunicationPolicy } from '../src/communication/communication-policy.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { LiveBridge, toLiveText } from '../src/live/live-bridge.js';
import { LIVE_APPEND_TOKEN_LIMIT, VO_SYSTEM_PROMPT } from '../src/live/vo-prompt.js';
import { ObservationService } from '../src/observation/observation-service.js';
import type { DecisionRouter } from '../src/decision/decision-router.js';
import type { ObservationLlm } from '../src/llm/observation-llm.js';
import type { SessionRegistry } from '../src/registry/session-registry.js';
import { FakeLiveTransport } from './fake-live-transport.js';
import {
  makeEvents,
  storeEvents,
  temporaryStore,
  testSession,
  TEST_SESSION,
} from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** A registry stand-in: the service only ever reads sessions and listens. */
function fakeRegistry(store: { getSession: (id: string) => unknown }): SessionRegistry {
  return {
    get: (id: string) => store.getSession(id),
    on: () => undefined,
  } as unknown as SessionRegistry;
}

function routerAnswering(choice: string): DecisionRouter {
  return {
    name: 'stub',
    available: true,
    async choose() {
      return { choice: choice as never };
    },
    async score() {
      return null;
    },
    async noul() {
      return null;
    },
  };
}

async function build(options: { router?: DecisionRouter; allowSideband?: boolean } = {}) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());
  await storeEvents(
    store,
    makeEvents([
      { kind: 'session_started', summary: 'Task: fix the reconnect test', atSeconds: 0 },
      {
        kind: 'test_finished',
        summary: 'Tests failed',
        atSeconds: 1,
        detail: { failed: true, output: 'reconnect.test.ts: expected 2 to be 1' },
      },
    ]),
  );

  const observer: ObservationLlm = {
    async observeWindow(input, tools) {
      await tools.surfaceUpdate({
        message: 'It keeps failing the same assertion.',
        whyNow: 'Third identical failure.',
        urgency: 'high',
      });
      return {
        summary: `window ${input.window.windowIndex}: it ran the reconnect test`,
        currentActivity: 'running the reconnect test',
      };
    },
    async investigate(_input, tools) {
      const hits = await tools.searchContext({ query: 'reconnect', limit: 3 });
      return {
        spokenAnswer: 'The reconnect regression test — it expects one replayed message but the store has two.',
        fullAnswer: `Long grounded account. ${'detail '.repeat(400)}`,
        refs: hits.map((hit) => hit.ref),
      };
    },
  };

  const navigator = new ContextNavigator({ store });
  const observation = new ObservationService({
    store,
    registry: fakeRegistry(store),
    observer,
    navigator,
    policy: new CommunicationPolicy(
      options.router ? { router: options.router } : {},
    ),
    windowPolicy: { maxEvents: 2 },
  });

  const transport = new FakeLiveTransport(true, options.allowSideband ?? true);
  const bridge = new LiveBridge({
    transport,
    observation,
    delegated: new DelegatedQuestionRunner({
      store,
      navigator,
      investigator: observer,
    }),
  });

  return { store, observation, bridge, transport };
}

/** Let queued microtasks and the fire-and-forget paths settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('LiveBridge — acceptance 5: observer updates reach a running session', () => {
  it('sends a new window note as silent context, never as speech', async () => {
    const { observation, bridge, transport } = await build({
      router: routerAnswering('ignore'),
    });
    await bridge.start(TEST_SESSION, 'offer-sdp');

    await observation.start(TEST_SESSION);
    await settle();

    const sideband = transport.sideband!;
    const quiet = sideband.silent();
    expect(quiet.some((text) => text.includes('it ran the reconnect test'))).toBe(true);
    // Quiet progress stays quiet: nothing was spoken.
    expect(sideband.spoken()).toHaveLength(0);
  });

  it('speaks an approved update without reconnecting the session', async () => {
    const { observation, bridge, transport } = await build({
      router: routerAnswering('speak_now'),
    });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    const sideband = transport.sideband!;

    await observation.start(TEST_SESSION);
    await settle();

    expect(sideband.spoken().some((text) => text.includes('same assertion'))).toBe(true);
    // Same connection throughout — updates arrive on the live session.
    expect(transport.sideband).toBe(sideband);
    expect(sideband.closed).toBe(false);
  });

  it('holds a queued update until the user next speaks', async () => {
    const { observation, bridge, transport } = await build({
      router: routerAnswering('queue'),
    });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    const sideband = transport.sideband!;

    await observation.start(TEST_SESSION);
    await settle();
    expect(sideband.spoken()).toHaveLength(0);

    // The user says something; the held thought arrives in conversation.
    sideband.userSays('how is it going?');
    sideband.emit({ type: 'transcript.assistant', delta: 'Going well', startMs: 2, endMs: 3 });
    await settle();

    expect(sideband.spoken().some((text) => text.includes('same assertion'))).toBe(true);
  });

  it('records a decision to speak separately from having spoken', async () => {
    const { store, observation, bridge } = await build({
      router: routerAnswering('speak_now'),
    });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    await observation.start(TEST_SESSION);
    await settle();

    const [candidate] = store.getSurfaceUpdates(TEST_SESSION);
    expect(candidate?.decision?.action).toBe('speak_now');
    expect(candidate?.deliveredAt).toBeTruthy();
  });
});

describe('LiveBridge — acceptance 6: delegated questions', () => {
  it('reconstructs the question from the transcript and speaks only the short answer', async () => {
    const { store, bridge, transport } = await build({
      router: routerAnswering('ignore'),
    });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    const sideband = transport.sideband!;

    // The provider does not tell us what was asked — the transcript does.
    sideband.userSays('What exact test is failing?');
    sideband.emit({ type: 'delegation.created', delegationId: 'delegation-1' });
    await settle();

    const spokenEntries = sideband.appended.filter(
      (entry) => entry.channel === 'commentary',
    );
    expect(spokenEntries).toHaveLength(1);
    expect(spokenEntries[0]!.content).toContain('reconnect regression test');
    // Tied to the delegation it answers.
    expect(spokenEntries[0]!.delegationId).toBe('delegation-1');

    // The spoken form is short. The full account is not read aloud — it is
    // persisted and rendered where it can be read.
    expect(spokenEntries[0]!.content.length).toBeLessThan(400);
    const conversation = store.getConversation(TEST_SESSION);
    const answer = conversation.find((entry) => entry.role === 'companion_answer');
    expect(answer?.text.length).toBeGreaterThan(1000);
    expect(conversation.some((entry) => entry.role === 'user_question')).toBe(true);
  });

  it('never splits a long answer across several spoken appends', async () => {
    const { bridge, transport } = await build({ router: routerAnswering('ignore') });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    const sideband = transport.sideband!;

    sideband.userSays('Why did it abandon the first approach?');
    sideband.emit({ type: 'delegation.created', delegationId: 'delegation-2' });
    await settle();

    expect(sideband.spoken()).toHaveLength(1);
  });

  it('asks the user to repeat when it cannot tell what was asked', async () => {
    const { bridge, transport } = await build({ router: routerAnswering('ignore') });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    const sideband = transport.sideband!;

    sideband.emit({ type: 'delegation.created', delegationId: 'delegation-3' });
    await settle();

    expect(sideband.spoken()).toHaveLength(0);
    expect(sideband.silent().some((text) => text.includes('could not tell what was asked'))).toBe(
      true,
    );
  });
});

describe('LiveBridge — what leaves Vowe', () => {
  it('bounds every appended block below the provider’s ceiling', () => {
    const long = 'word '.repeat(5000);
    const bounded = toLiveText(long);
    expect(bounded.length).toBeLessThan(LIVE_APPEND_TOKEN_LIMIT * 4);
    expect(bounded.endsWith('…')).toBe(true);
    // Collapses whitespace so a trace-shaped blob cannot be smuggled through.
    expect(toLiveText('a\n\n\tb')).toBe('a b');
  });

  it('gives the provider Vo’s prompt and nothing about traces', async () => {
    const { bridge, transport } = await build();
    await bridge.start(TEST_SESSION, 'offer-sdp');

    expect(transport.lastInstructions).toBe(VO_SYSTEM_PROMPT);
    expect(transport.lastInstructions).not.toMatch(/window|rawRef|jsonl|transcript file/i);
  });

  it('sends only interpreted prose, never raw trace material', async () => {
    const { observation, bridge, transport } = await build({
      router: routerAnswering('speak_now'),
    });
    await bridge.start(TEST_SESSION, 'offer-sdp');
    await observation.start(TEST_SESSION);
    await settle();

    for (const entry of transport.sideband!.appended) {
      expect(entry.content).not.toContain('rawRef');
      expect(entry.content).not.toContain('byteOffset');
      expect(entry.content).not.toContain('.jsonl');
    }
  });
});

describe('LiveBridge — acceptance 8: degraded modes', () => {
  it('refuses to start, in words, when no voice credential is configured', async () => {
    const { bridge } = await build();
    const unavailable = new FakeLiveTransport(false);
    expect(unavailable.available).toBe(false);
    expect(unavailable.unavailableReason).toContain('credential');
    // The bridge under test is configured; this asserts the transport contract
    // the UI reads to explain itself.
    expect(bridge.status.available).toBe(true);
  });

  it('keeps the conversation usable when the backend cannot attach', async () => {
    const { observation, bridge } = await build({ allowSideband: false });
    const { sdpAnswer, status } = await bridge.start(TEST_SESSION, 'offer-sdp');

    // The user can still talk to Vo; observation just cannot reach it.
    expect(sdpAnswer).toContain('offer-sdp');
    expect(status.connected).toBe(true);
    expect(status.sidebandAttached).toBe(false);

    // And observation carries on regardless.
    await observation.start(TEST_SESSION);
    await settle();
    expect(observation.status(TEST_SESSION).windowsProcessed).toBeGreaterThan(0);
  });
});

describe('LiveBridge — who is speaking', () => {
  /**
   * The provider declares no speaking lifecycle at all, so the only honest
   * account of Vowe speaking is the audio the renderer measured itself
   * playing. It already crosses the boundary for the conversation record;
   * publishing it on the status is what lets the rest of the application see
   * it without measuring anything a second time.
   */
  it('publishes playback on the status, and only during a call', async () => {
    const { bridge } = await build();
    const seen: boolean[] = [];
    bridge.on('status', (status) => seen.push(status.playbackActive));

    expect(bridge.status.playbackActive).toBe(false);

    await bridge.start(TEST_SESSION, 'offer');
    expect(bridge.status.playbackActive).toBe(false);

    bridge.reportPlayback({ kind: 'started', at: new Date().toISOString() });
    expect(bridge.status.playbackActive).toBe(true);

    bridge.reportPlayback({ kind: 'stopped', at: new Date().toISOString(), audioMs: 900 });
    expect(bridge.status.playbackActive).toBe(false);

    bridge.reportPlayback({ kind: 'started', at: new Date().toISOString() });
    await bridge.stop();
    // A call that ended while audio was playing is not a presence still
    // speaking: there is nothing left to hear.
    expect(bridge.status.playbackActive).toBe(false);

    expect(seen).toContain(true);
  });

  it('says nothing when a report changes nothing', async () => {
    const { bridge } = await build();
    await bridge.start(TEST_SESSION, 'offer');

    let announcements = 0;
    bridge.on('status', () => announcements++);

    bridge.reportPlayback({ kind: 'started', at: new Date().toISOString() });
    bridge.reportPlayback({ kind: 'started', at: new Date().toISOString() });
    expect(announcements).toBe(1);
  });
});

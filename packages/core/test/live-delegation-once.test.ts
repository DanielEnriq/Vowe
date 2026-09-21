import { afterEach, describe, expect, it } from 'vitest';

import { CommunicationPolicy } from '../src/communication/communication-policy.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { VoweRunRecorder } from '../src/execution/run-recorder.js';
import { LiveBridge } from '../src/live/live-bridge.js';
import { ObservationService } from '../src/observation/observation-service.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { SessionRegistry } from '../src/registry/session-registry.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import { FakeLiveSideband, FakeLiveTransport } from './fake-live-transport.js';
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

const SPOKEN = 'Both paths hit the same insertion function.';
const FULL =
  'The reconnect test is failing because both paths now enter the same insertion function. Claude is changing the replay path next.';

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRegistry(store: { getSession: (id: string) => unknown }): SessionRegistry {
  return {
    get: (id: string) => store.getSession(id),
    on: () => undefined,
  } as unknown as SessionRegistry;
}

async function askedOutLoud(): Promise<{
  store: SqliteEventStore;
  bridge: LiveBridge;
  sideband: FakeLiveSideband;
  reopen: () => Promise<SqliteEventStore>;
}> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());
  await storeEvents(
    store,
    makeEvents([
      { kind: 'session_started', summary: 'Task: fix the reconnect test', atSeconds: 0 },
      { kind: 'test_finished', summary: 'Tests failed', atSeconds: 1 },
    ]),
  );

  const navigator = new ContextNavigator({ store });
  const model: ObservationLlm = {
    async observeWindow(): Promise<WindowObservation> {
      return { summary: 'not used here' };
    },
    async investigate(
      _input: InvestigationInput,
      tools: ReadOnlyToolset,
    ): Promise<DelegatedAnswer> {
      const hits = await tools.searchContext({ query: 'reconnect', limit: 2 });
      return { spokenAnswer: SPOKEN, fullAnswer: FULL, refs: hits.map((h) => h.ref) };
    },
  };

  const runs = new VoweRunRecorder({ store });
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
    delegated: new DelegatedQuestionRunner({
      store,
      navigator,
      investigator: model,
      runs,
    }),
    store,
    runs,
    turnSilenceMs: 20,
  });
  await bridge.start(TEST_SESSION, 'offer');
  return { store, bridge, sideband: transport.sideband!, reopen: fixture.reopen };
}

describe('a question asked out loud is stored exactly once', () => {
  it('writes one user turn, one grounded answer, and one delivery of it', async () => {
    const { store, sideband, bridge } = await askedOutLoud();

    sideband.userSays('Why is the reconnect test failing?');
    await settle();
    sideband.emit({ type: 'delegation.created', delegationId: 'del_1' });
    await settle();

    // Vo speaks the short form of the answer it was handed.
    sideband.voSays(SPOKEN, { startMs: 5000, endMs: 7000 });
    await settle();
    await bridge.stop();

    const conversation = store.getConversation(TEST_SESSION);
    expect(conversation.map((entry) => entry.role)).toEqual([
      'user_message',
      'companion_answer',
    ]);

    // The full grounded account, written once by the investigator. Vo speaking
    // it did not write a second copy, and did not shorten this one.
    const answer = conversation[1]!;
    expect(answer.text).toBe(FULL);

    const [delivery] = store.getDeliveries(answer.id);
    expect(delivery!.modality).toBe('voice');
    expect(delivery!.status).toBe('completed');
    // What was audible was the short form — a record of this answer being
    // delivered, not a second answer.
    expect(delivery!.deliveredText).toBe(SPOKEN);
  });

  it('asks the question once, however it arrived', async () => {
    const { store, sideband, bridge } = await askedOutLoud();

    sideband.userSays('Why is the reconnect test failing?');
    await settle();
    sideband.emit({ type: 'delegation.created', delegationId: 'del_1' });
    await settle();
    await bridge.stop();

    const asked = store
      .getConversation(TEST_SESSION)
      .filter((entry) => entry.text === 'Why is the reconnect test failing?');
    expect(asked).toHaveLength(1);
  });

  it('links the answer to the investigation that produced it', async () => {
    const { store, sideband, bridge } = await askedOutLoud();

    sideband.userSays('Why is the reconnect test failing?');
    await settle();
    sideband.emit({ type: 'delegation.created', delegationId: 'del_1' });
    await settle();
    await bridge.stop();

    const conversation = store.getConversation(TEST_SESSION);
    const answer = conversation[1]!;
    const run = store.getRunForEntry(answer.id)!;
    expect(run.kind).toBe('investigation');
    expect(run.status).toBe('completed');
    // And back the other way: which turn caused the execution.
    expect(run.triggerEntryId).toBe(conversation[0]!.id);

    // What it actually looked up, in the order it looked.
    const kinds = store.getTraceItems(run.id).map((item) => item.kind);
    expect(kinds).toContain('tool_call');
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('tool_result'));
  });

  it('attaches an interruption to the same answer rather than a new one', async () => {
    const { store, sideband, bridge } = await askedOutLoud();

    sideband.userSays('Why is the reconnect test failing?');
    await settle();
    sideband.emit({ type: 'delegation.created', delegationId: 'del_1' });
    await settle();

    sideband.voSays(SPOKEN, { startMs: 5000, endMs: 9000 });
    bridge.reportPlayback({ kind: 'started', at: '2026-02-11T10:00:00.000Z' });
    sideband.userSays('Never mind.', { startMs: 6200, endMs: 7000 });
    await settle();
    await bridge.stop();

    const answers = store
      .getConversation(TEST_SESSION)
      .filter((entry) => entry.role === 'companion_answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.text).toBe(FULL);

    const [delivery] = store.getDeliveries(answers[0]!.id);
    expect(delivery!.status).toBe('interrupted');
  });

  it('is still one answer after a restart', async () => {
    const { sideband, bridge, reopen } = await askedOutLoud();

    sideband.userSays('Why is the reconnect test failing?');
    await settle();
    sideband.emit({ type: 'delegation.created', delegationId: 'del_1' });
    await settle();
    sideband.voSays(SPOKEN, { startMs: 5000, endMs: 7000 });
    await settle();
    await bridge.stop();

    const restarted = await reopen();
    const conversation = restarted.getConversation(TEST_SESSION);
    expect(conversation.map((entry) => entry.role)).toEqual([
      'user_message',
      'companion_answer',
    ]);
  });
});

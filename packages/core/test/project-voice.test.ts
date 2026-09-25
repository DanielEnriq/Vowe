import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommunicationPolicy } from '../src/communication/communication-policy.js';
import { formatRef } from '../src/context/refs.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner, type InvestigationProgress } from '../src/delegation/delegated-question-runner.js';
import { VoweRunRecorder } from '../src/execution/run-recorder.js';
import { LiveBridge } from '../src/live/live-bridge.js';
import { ObservationService } from '../src/observation/observation-service.js';
import { ProjectBriefService } from '../src/product/project-brief.js';
import type { InvestigationInput, ObservationLlm } from '../src/llm/observation-llm.js';
import type { SessionRegistry } from '../src/registry/session-registry.js';
import { FakeLiveTransport } from './fake-live-transport.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const PROJECT = 'git:voice-project';
const SPOKEN = 'The observer now uses the same project understanding.';
const FULL = 'The observer reads the shared project understanding. The source is observer.ts.';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function harness(options: { sideband?: boolean; wait?: Promise<void> } = {}) {
  const fixture = await temporaryStore();
  cleanups.push(fixture.cleanup);
  const { store, root } = fixture;
  await store.upsertProject({ id: PROJECT, name: 'Vowe', repoRoot: root, createdAt: new Date().toISOString() });
  await store.upsertSession(testSession({ projectId: PROJECT, cwd: root, displayLabel: 'Observer work' }));
  await writeFile(join(root, 'observer.ts'), 'export const source = "shared project understanding";\n');
  const inputs: InvestigationInput[] = [];
  const progress: InvestigationProgress[] = [];
  const errors: unknown[] = [];
  const model: ObservationLlm = {
    async observeWindow() { return { summary: 'Not used' }; },
    async investigate(input, tools) {
      inputs.push(input);
      await options.wait;
      const ref = { kind: 'repo' as const, path: join(root, 'observer.ts') };
      const opened = await tools.openContext({ ref: formatRef(ref) });
      expect(opened.notFound).toBeUndefined();
      expect(opened.content).toContain('shared project understanding');
      expect(Object.keys(tools)).not.toContain('sendInstruction');
      return { spokenAnswer: SPOKEN, fullAnswer: FULL, refs: [ref] };
    },
  };
  const navigator = new ContextNavigator({ store });
  const runs = new VoweRunRecorder({ store });
  const runner = new DelegatedQuestionRunner({ store, navigator, investigator: model, runs,
    onProgress: (event) => progress.push(event) });
  const observation = new ObservationService({ store, navigator, observer: model, policy: new CommunicationPolicy(),
    registry: { get: (id: string) => store.getSession(id), on: () => undefined } as unknown as SessionRegistry });
  const brief = new ProjectBriefService({ store, sessionsFor: () => [store.getSession(TEST_SESSION)!] });
  const transport = new FakeLiveTransport(true, options.sideband ?? true);
  const bridge = new LiveBridge({ transport, observation, delegated: runner, store, runs,
    projectBrief: (id) => brief.get(id), turnSilenceMs: 10000,
    onError: (_scope, error) => errors.push(error) });
  cleanups.push(() => bridge.stop());
  return { ...fixture, bridge, transport, inputs, runner, progress, errors };
}

describe('Project voice uses the shared conversation and investigator', () => {
  it('seeds current Home understanding and typed history, and records quick speech without investigation', async () => {
    const { bridge, transport, store, inputs } = await harness();
    await store.appendProjectConversationEntry({ id: 'typed', projectId: PROJECT, role: 'user_question', text: 'Keep the API?', at: new Date().toISOString() });
    await bridge.start({ projectId: PROJECT }, 'offer');
    const sideband = transport.sideband!;
    expect(bridge.status).toMatchObject({ projectId: PROJECT, sessionId: null, connected: true });
    expect(sideband.silent().join(' ')).toContain('1 workers running');
    expect(sideband.silent().join(' ')).toContain('Keep the API?');
    expect(sideband.spoken()).toEqual([]);
    sideband.userSays("What's going on?");
    sideband.voSays('One worker is running.');
    await bridge.stop();
    expect(inputs).toHaveLength(0);
    expect(store.getProjectConversation(PROJECT).map((entry) => entry.text)).toEqual(['Keep the API?', "What's going on?", 'One worker is running.']);
    expect(store.getConversation(TEST_SESSION)).toEqual([]);
    const entries = store.getProjectConversation(PROJECT);
    expect(store.getDeliveries(entries[2]!.id)[0]).toMatchObject({ projectId: PROJECT, modality: 'voice', status: 'completed' });
  });

  it('investigates once, emits project progress, preserves full text, and records the interrupted short delivery', async () => {
    const { bridge, transport, store, inputs, progress, reopen, errors } = await harness();
    await bridge.start({ projectId: PROJECT }, 'offer');
    const sideband = transport.sideband!;
    sideband.userSays('What changed in the observer work?');
    sideband.emit({ type: 'delegation.created', delegationId: 'd1' });
    sideband.emit({ type: 'delegation.created', delegationId: 'd1' });
    await settle();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ projectId: PROJECT });
    expect(progress.some((event) => event.phase === 'check')).toBe(true);
    expect(progress.every((event) => 'projectId' in event.scope && event.scope.projectId === PROJECT)).toBe(true);
    expect(sideband.spoken()).toEqual([SPOKEN]);
    let entries = store.getProjectConversation(PROJECT);
    expect(entries.map((entry) => entry.role)).toEqual(['user_message', 'companion_answer']);
    const answer = entries[1]!;
    expect(answer.text).toBe(FULL);
    expect(answer.investigation?.checks[0]?.kind).toBe('open');
    expect(store.getRunForEntry(answer.id)?.triggerEntryId).toBe(entries[0]!.id);
    expect(store.getDeliveries(answer.id)[0]?.status).toBe('started');
    bridge.reportPlayback({ kind: 'started', at: new Date().toISOString() });
    sideband.voSays(SPOKEN, { startMs: 2000, endMs: 8000 });
    sideband.userSays('Why?', { startMs: 3000, endMs: 3500 });
    bridge.reportPlayback({ kind: 'stopped', at: new Date().toISOString(), audioMs: 1000 });
    sideband.emit({ type: 'delegation.created', delegationId: 'd2' });
    await settle();
    expect(inputs[1]?.question).toBe('Why?');
    expect(inputs[1]?.liveConversation?.some((turn) => turn.text.includes('[Interrupted'))).toBe(true);
    expect(inputs[1]?.liveConversation?.some((turn) => turn.text.includes('observer work?'))).toBe(true);
    expect(store.getDeliveries(answer.id)).toHaveLength(1);
    expect(store.getDeliveries(answer.id)[0]).toMatchObject({ status: 'interrupted', audioEndMs: 1000 });
    await bridge.stop();
    const restarted = await reopen();
    entries = restarted.getProjectConversation(PROJECT);
    expect(entries.map((entry) => entry.role)).toEqual(['user_message', 'companion_answer', 'user_message', 'companion_answer']);
    expect(restarted.getDeliveries(answer.id)[0]?.interruptedByEntryId).toBe(entries[2]!.id);
    expect(restarted.getDeliveries(entries[3]!.id)[0]?.status).toBe('cancelled');
    expect(errors).toEqual([]);
  });

  it('updates orientation from the existing projection and clears earlier transcript captions at speaker changes', async () => {
    const { bridge, transport, store } = await harness();
    const captions: string[] = [];
    bridge.on('transcript', (delta) => captions.push(delta.text));
    await bridge.start({ projectId: PROJECT }, 'offer');
    const sideband = transport.sideband!;
    sideband.userSays('Anything running?');
    sideband.voSays('One worker.');
    sideband.userSays('Which?');
    sideband.voSays('Observer work.');
    expect(captions).toEqual(['Anything running?', 'One worker.', 'Which?', 'Observer work.']);
    await store.upsertSession(testSession({ projectId: PROJECT, status: 'finished' }));
    await bridge.refreshProjectContext();
    expect(sideband.silent().join(' ')).toContain('0 workers running');
    await bridge.stop();
  });

  it('does not speak a late investigation result into an ended or replaced call', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { bridge, transport, store } = await harness({ wait });
    await bridge.start({ projectId: PROJECT }, 'offer');
    const previous = transport.sideband!;
    previous.userSays('What changed?');
    previous.emit({ type: 'delegation.created', delegationId: 'slow' });
    await settle();
    await bridge.stop();
    await bridge.start({ projectId: PROJECT }, 'new-offer');
    release();
    await settle();
    expect(previous.spoken()).toEqual([]);
    expect(transport.sideband!.spoken()).toEqual([]);
    expect(store.getProjectConversation(PROJECT).at(-1)?.text).toBe(FULL);
  });

  it('refuses project voice without a sideband rather than losing conversation history', async () => {
    const { bridge } = await harness({ sideband: false });
    await expect(bridge.start({ projectId: PROJECT }, 'offer')).rejects.toThrow('project conversation');
    expect(bridge.status.connected).toBe(false);
  });

  it('rolls back failed project delivery writes and deduplicates provider turns across reload', async () => {
    const { store, reopen } = await harness();
    const entry = { id: 'spoken', projectId: PROJECT, at: new Date().toISOString(), role: 'companion_message' as const,
      text: 'Hello', origin: { provider: 'fake', kind: 'live_turn', id: 'call:vo:10' } };
    const delivery = { modality: 'voice' as const, status: 'completed' as const, startedAt: entry.at };
    let notifications = 0;
    store.onProjectConversationChanged(() => notifications++);
    await expect(store.appendProjectConversationEntry(entry, { ...delivery, audioEndMs: 'broken' as unknown as number })).rejects.toThrow();
    expect(store.getProjectConversation(PROJECT)).toEqual([]);
    expect(notifications).toBe(0);
    await store.appendProjectConversationEntry(entry, delivery);
    expect(notifications).toBe(1);
    const restarted = await reopen();
    expect(await restarted.appendProjectConversationEntry({ ...entry, id: 'duplicate' }, delivery)).toBeNull();
    expect(restarted.getProjectConversation(PROJECT)).toHaveLength(1);
    expect(restarted.getDeliveries(entry.id)).toHaveLength(1);
    expect(restarted.getDeliveriesForSession(TEST_SESSION)).toEqual([]);
  });
  it('shares a typed exchange with the existing live connection silently and only in its project', async () => {
    const { bridge, transport } = await harness();
    await bridge.start({ projectId: PROJECT }, 'offer');
    await bridge.projectAsked('another-project', 'Secret question', 'Secret answer');
    await bridge.projectAsked(PROJECT, 'Which API?', 'The observer API.');
    expect(transport.sideband!.silent().join(' ')).toContain('Which API?');
    expect(transport.sideband!.silent().join(' ')).toContain('The observer API.');
    expect(transport.sideband!.silent().join(' ')).not.toContain('Secret');
    expect(transport.sideband!.spoken()).toEqual([]);
  });

  it('hydrates interruptions when voice reconnects, even for long written answers', async () => {
    const { bridge, transport, store } = await harness();
    const entry = { id: 'long-answer', projectId: PROJECT, at: new Date().toISOString(),
      role: 'companion_answer' as const, text: 'Complete written evidence. '.repeat(200) };
    await store.appendProjectConversationEntry(entry, { modality: 'voice', status: 'interrupted',
      startedAt: entry.at, audioEndMs: 1200, deliveredText: 'The observer API.' });
    await bridge.start({ projectId: PROJECT }, 'offer');
    expect(transport.sideband!.silent().join(' ')).toContain('Interrupted after about 1.2s');
    expect(transport.sideband!.silent().join(' ')).toContain('The user did not hear all of this');
    expect(store.getProjectConversation(PROJECT)).toHaveLength(1);
  });

  it('cancels a pending spoken delivery when a new question arrives first', async () => {
    const { bridge, transport, store } = await harness();
    await bridge.start({ projectId: PROJECT }, 'offer');
    const sideband = transport.sideband!;
    sideband.userSays('What changed?');
    sideband.emit({ type: 'delegation.created', delegationId: 'd1' });
    await settle();
    const answer = store.getProjectConversation(PROJECT)[1]!;
    sideband.userSays('Wait, another question.');
    sideband.voSays('Go ahead.');
    await bridge.stop();
    expect(store.getDeliveries(answer.id)[0]?.status).toBe('cancelled');
    expect(store.getProjectConversation(PROJECT).at(-1)?.text).toBe('Go ahead.');
  });

  it('cannot resurrect a connection after it was ended during setup', async () => {
    const { bridge, transport } = await harness();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const create = transport.createSession.bind(transport);
    transport.createSession = async (options) => { await wait; return create(options); };
    const starting = bridge.start({ projectId: PROJECT }, 'offer');
    await settle();
    await bridge.stop();
    release();
    await expect(starting).rejects.toThrow('cancelled');
    expect(bridge.status.connected).toBe(false);
    expect(transport.sideband!.closed).toBe(true);
  });

});

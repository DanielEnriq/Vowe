import { afterEach, describe, expect, it } from 'vitest';

import { FleetRelay, relayMessage, type CaptainRouting, type FleetWorkers } from '../src/fleet/fleet-relay.js';
import type { CaptainExchange, WorkerOutcome, WorkerQuestionEvent } from '../src/fleet/types.js';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type {
  AgentAdapter,
  InstructionResult,
  LaunchOptions,
  Unsubscribe,
} from '../src/types/adapter.js';
import type { NormalizedEvent } from '../src/types/events.js';
import type { AgentSession } from '../src/types/session.js';
import { temporaryStore, testSession } from './helpers.js';

const PROJECT = 'git:fleet';
const ASKER = 'claude-code:asker';
const CAPTAIN = 'claude-code:captain';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/**
 * Workers as the relay sees them. The captain is scripted: each relayed text
 * gets the next reply, delivered as a turn starting and then ending.
 */
class FakeWorkers implements FleetWorkers {
  readonly relayed: Array<{ sessionId: string; text: string }> = [];
  readonly answered: Array<{ sessionId: string; questionId: string; answer: string }> = [];
  readonly launched: LaunchOptions[] = [];
  /** Replies the captain gives, in order. `null` never ends the turn. */
  replies: Array<string | null | { failed: true }> = [];
  /** Questions currently held, by `${sessionId}#${questionId}`. */
  readonly held = new Set<string>();
  outcomes = new Map<string, WorkerOutcome>();
  private readonly questionListeners = new Set<(event: WorkerQuestionEvent) => void>();
  private readonly outcomeListeners = new Set<(outcome: WorkerOutcome) => void>();
  private readonly eventListeners = new Set<(event: NormalizedEvent) => void>();

  constructor(private readonly sessions: Map<string, AgentSession>) {}

  session(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async launch(options: LaunchOptions): Promise<AgentSession> {
    this.launched.push(options);
    return this.sessions.get(CAPTAIN)!;
  }

  async relay(sessionId: string, text: string): Promise<InstructionResult> {
    this.relayed.push({ sessionId, text });
    if (sessionId === CAPTAIN) {
      const reply = this.replies.shift();
      this.outcome({ sessionId, state: 'working', at: now() });
      if (reply !== null && reply !== undefined) {
        setTimeout(() => {
          if (typeof reply === 'object') this.outcome({ sessionId, state: 'failed', at: now(), error: 'boom' });
          else this.outcome({ sessionId, state: 'completed', at: now(), text: reply });
        }, 5);
      }
    }
    return { delivered: true, via: 'fake' };
  }

  async answerQuestion(sessionId: string, questionId: string, answer: string): Promise<boolean> {
    const key = `${sessionId}#${questionId}`;
    if (!this.held.delete(key)) return false;
    this.answered.push({ sessionId, questionId, answer });
    return true;
  }

  outcomeOf(sessionId: string): WorkerOutcome | null {
    return this.outcomes.get(sessionId) ?? null;
  }

  onQuestion(listener: (event: WorkerQuestionEvent) => void): Unsubscribe {
    this.questionListeners.add(listener);
    return () => this.questionListeners.delete(listener);
  }

  onOutcome(listener: (outcome: WorkerOutcome) => void): Unsubscribe {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  onEvent(listener: (event: NormalizedEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  ask(questionId: string, question: string, options?: string[]): void {
    this.held.add(`${ASKER}#${questionId}`);
    for (const listener of this.questionListeners) {
      listener({
        type: 'asked',
        question: {
          id: questionId,
          sessionId: ASKER,
          toolUseId: questionId,
          question,
          ...(options ? { options } : {}),
          askedAt: now(),
        },
      });
    }
  }

  settleByInstruction(questionId: string, answer: string): void {
    this.held.delete(`${ASKER}#${questionId}`);
    for (const listener of this.questionListeners) {
      listener({
        type: 'settled',
        settled: { id: questionId, sessionId: ASKER, answer, by: 'instruction', at: now() },
      });
    }
  }

  outcome(outcome: WorkerOutcome): void {
    this.outcomes.set(outcome.sessionId, outcome);
    for (const listener of this.outcomeListeners) listener(outcome);
  }
}

function now(): string {
  return new Date().toISOString();
}

const wired: CaptainRouting = { captainFor: async (_project, sessionId) => (sessionId === ASKER ? CAPTAIN : null) };

async function fixture(routing?: CaptainRouting, captainTimeoutMs = 2_000) {
  const opened = await temporaryStore();
  cleanup = opened.cleanup;
  await opened.store.upsertProject({
    id: PROJECT,
    name: 'Fleet',
    repoRoot: '/repo/fleet',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  const sessions = new Map<string, AgentSession>([
    [ASKER, testSession({ id: ASKER, providerSessionId: 'asker', projectId: PROJECT, task: 'Split retry out' })],
    [CAPTAIN, testSession({ id: CAPTAIN, providerSessionId: 'captain', projectId: PROJECT })],
  ]);
  const workers = new FakeWorkers(sessions);
  const changes: string[] = [];
  opened.store.onCaptainExchangeChanged((change) => {
    const stored = opened.store.getCaptainExchange(change.exchangeId)!;
    changes.push(`${stored.route}/${stored.status}`);
  });
  const relay = new FleetRelay({
    store: opened.store,
    workers,
    ...(routing ? { routing } : {}),
    captainTimeoutMs,
  });
  relay.start();
  return { ...opened, workers, relay, changes };
}

function only(store: SqliteEventStore): CaptainExchange {
  const [exchange, ...rest] = store.listCaptainExchanges(PROJECT);
  expect(rest).toEqual([]);
  return exchange!;
}

describe('FleetRelay', () => {
  it('records an unwired question for the developer and relays nothing', async () => {
    const { store, workers, relay, changes } = await fixture();
    workers.ask('q1', 'Keep the old header?', ['Keep', 'Cut']);
    await relay.idle();

    const exchange = only(store);
    expect(exchange).toMatchObject({
      askerSessionId: ASKER,
      questionId: 'q1',
      toolUseId: 'q1',
      captainSessionId: null,
      question: 'Keep the old header?',
      options: ['Keep', 'Cut'],
      route: 'you',
      status: 'pending',
      captainAnswer: null,
      userAnswer: null,
      delivery: null,
    });
    expect(workers.relayed).toEqual([]);
    expect(changes).toEqual(['you/pending']);

    const answered = await relay.answerAsUser(exchange.id, 'Cut it now', false);
    expect(answered).toMatchObject({ route: 'you', status: 'answered', userAnswer: 'Cut it now', delivery: 'in-place' });
    expect(workers.answered).toEqual([{ sessionId: ASKER, questionId: 'q1', answer: 'Cut it now' }]);
    await expect(relay.answerAsUser(exchange.id, 'again', false)).rejects.toThrow(/already/);
  });

  it('relays a wired question to the captain and answers the worker in place', async () => {
    const { store, workers, relay, changes } = await fixture(wired);
    workers.replies = ['config/webhook.ts — retryCeilingMs, 30000.'];
    workers.ask('q1', 'Where does the backoff ceiling come from?');
    await relay.idle();

    expect(workers.relayed).toHaveLength(1);
    expect(workers.relayed[0]!.sessionId).toBe(CAPTAIN);
    expect(workers.relayed[0]!.text).toContain('Where does the backoff ceiling come from?');
    expect(workers.relayed[0]!.text).toContain('PASS:');
    expect(workers.answered).toEqual([
      { sessionId: ASKER, questionId: 'q1', answer: 'config/webhook.ts — retryCeilingMs, 30000.' },
    ]);
    expect(only(store)).toMatchObject({
      route: 'captain',
      status: 'answered',
      captainSessionId: CAPTAIN,
      captainAnswer: 'config/webhook.ts — retryCeilingMs, 30000.',
      delivery: 'in-place',
    });
    expect(changes).toEqual(['captain/pending', 'captain/answered']);
  });

  it('passes to the developer on a PASS line, and can tell the captain the answer', async () => {
    const { store, workers, relay } = await fixture(wired);
    workers.replies = ['Depends on external callers.\nPASS: nothing in the project says', 'Noted.'];
    workers.ask('q1', 'Keep the old header for one release?');
    await relay.idle();

    const passed = only(store);
    expect(passed).toMatchObject({
      route: 'you',
      status: 'passed',
      passedToYouReason: 'nothing in the project says',
      captainAnswer: 'Depends on external callers.\nPASS: nothing in the project says',
      captainSessionId: CAPTAIN,
    });
    expect(workers.answered).toEqual([]);

    await relay.answerAsUser(passed.id, 'Keep it one release', true);
    await relay.idle();
    expect(workers.answered).toEqual([{ sessionId: ASKER, questionId: 'q1', answer: 'Keep it one release' }]);
    expect(workers.relayed.map((r) => r.sessionId)).toEqual([CAPTAIN, CAPTAIN]);
    expect(workers.relayed[1]!.text).toContain('Keep it one release');
    expect(only(store)).toMatchObject({ route: 'you', status: 'answered', userAnswer: 'Keep it one release' });
  });

  it('passes to the developer when the captain does not answer in time', async () => {
    const { store, workers, relay } = await fixture(wired, 60);
    workers.replies = [null];
    workers.ask('q1', 'Which file owns header parsing?');
    await relay.idle();
    expect(only(store)).toMatchObject({
      route: 'you',
      status: 'passed',
      passedToYouReason: 'The captain did not answer in time.',
      captainAnswer: null,
    });
    expect(workers.answered).toEqual([]);
  });

  it('passes to the developer when the captain turn fails', async () => {
    const { store, workers, relay } = await fixture(wired);
    workers.replies = [{ failed: true }];
    workers.ask('q1', 'Which file?');
    await relay.idle();
    expect(only(store)).toMatchObject({ route: 'you', status: 'passed', passedToYouReason: 'The captain could not answer.' });
  });

  it('waits for a busy captain to finish its own turn before relaying', async () => {
    const { store, workers, relay } = await fixture(wired);
    workers.outcomes.set(CAPTAIN, { sessionId: CAPTAIN, state: 'working', at: now() });
    workers.replies = ['Named exports only.'];
    workers.ask('q1', 'Default exports anywhere?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workers.relayed).toEqual([]);
    // Its own turn ends: that ending is not the answer.
    workers.outcome({ sessionId: CAPTAIN, state: 'completed', at: now(), text: 'Ready.' });
    await relay.idle();
    expect(only(store)).toMatchObject({ status: 'answered', captainAnswer: 'Named exports only.' });
  });

  it('answers one question at a time per captain', async () => {
    const { store, workers, relay } = await fixture(wired);
    workers.replies = ['first answer', 'second answer'];
    workers.ask('q1', 'First?');
    workers.ask('q2', 'Second?');
    await relay.idle();
    const byQuestion = Object.fromEntries(store.listCaptainExchanges(PROJECT).map((e) => [e.questionId, e.captainAnswer]));
    expect(byQuestion).toEqual({ q1: 'first answer', q2: 'second answer' });
  });

  it('delivers as an instruction when the question is no longer held', async () => {
    const { store, workers, relay } = await fixture(wired);
    workers.replies = ['Use test/support/clock.ts.'];
    workers.ask('q1', 'Is there a fake-timer helper?');
    workers.held.clear();
    await relay.idle();
    expect(only(store)).toMatchObject({ status: 'answered', delivery: 'instruction' });
    const toAsker = workers.relayed.find((r) => r.sessionId === ASKER)!;
    expect(toAsker.text).toContain('Use test/support/clock.ts.');
  });

  it('records an instruction that settled the question as the developer’s answer', async () => {
    const { store, workers, relay } = await fixture();
    workers.ask('q1', 'Cut the header?');
    await relay.idle();
    workers.settleByInstruction('q1', 'cut it');
    await relay.idle();
    expect(only(store)).toMatchObject({ route: 'you', status: 'answered', userAnswer: 'cut it', delivery: 'in-place' });
  });

  it('does not deliver a captain answer once the developer has answered', async () => {
    const { store, workers, relay } = await fixture(wired);
    workers.replies = [null];
    workers.ask('q1', 'Which?');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const exchange = only(store);
    await relay.answerAsUser(exchange.id, 'mine', false);
    workers.outcome({ sessionId: CAPTAIN, state: 'completed', at: now(), text: 'captain says' });
    await relay.idle();
    expect(workers.answered).toEqual([{ sessionId: ASKER, questionId: 'q1', answer: 'mine' }]);
    expect(only(store)).toMatchObject({ status: 'answered', userAnswer: 'mine', captainAnswer: null });
  });

  it('launches a captain read-only with the captain brief', async () => {
    const { workers, relay } = await fixture();
    await relay.launchCaptain(PROJECT, '/repo/fleet');
    expect(workers.launched).toHaveLength(1);
    expect(workers.launched[0]).toMatchObject({ cwd: '/repo/fleet', readOnly: true });
    expect(workers.launched[0]!.prompt).toContain('PASS:');
  });

  it('formats the relayed question with the asker and its options', () => {
    const text = relayMessage(testSession({ displayLabel: 'Attempt A', task: 'Split retry' }), {
      question: 'Keep it?',
      options: ['Keep', 'Cut'],
    } as CaptainExchange);
    expect(text).toContain('Attempt A, working on: Split retry');
    expect(text).toContain('Options: Keep / Cut');
  });
});

/** An adapter that holds questions, for the registry's half of the contract. */
class HoldingAdapter implements AgentAdapter {
  readonly provider = 'holding';
  readonly sent: string[] = [];
  private questionListener: ((event: WorkerQuestionEvent) => void) | null = null;
  private outcomeListener: ((outcome: WorkerOutcome) => void) | null = null;

  async discoverSessions(): Promise<AgentSession[]> {
    return [this.session()];
  }
  async getSession(): Promise<AgentSession | null> {
    return this.session();
  }
  subscribeToEvents(): Unsubscribe {
    return () => undefined;
  }
  async sendInstruction(_id: string, text: string): Promise<InstructionResult> {
    this.sent.push(text);
    return { delivered: true, via: 'holding' };
  }
  onQuestion(listener: (event: WorkerQuestionEvent) => void): Unsubscribe {
    this.questionListener = listener;
    return () => (this.questionListener = null);
  }
  async answerQuestion(_id: string, questionId: string): Promise<boolean> {
    return questionId === 'held';
  }
  onOutcome(listener: (outcome: WorkerOutcome) => void): Unsubscribe {
    this.outcomeListener = listener;
    return () => (this.outcomeListener = null);
  }
  outcomeOf(): WorkerOutcome | null {
    return { sessionId: 'holding:one', state: 'completed', at: now() };
  }
  emit(): void {
    this.questionListener?.({
      type: 'asked',
      question: { id: 'held', sessionId: 'holding:one', question: 'Q?', askedAt: now() },
    });
    this.outcomeListener?.({ sessionId: 'holding:one', state: 'working', at: now() });
  }
  private session(): AgentSession {
    return testSession({
      id: 'holding:one',
      provider: 'holding',
      providerSessionId: 'one',
      capabilities: { ...testSession().capabilities, sendInstruction: true },
    });
  }
}

describe('SessionRegistry fleet control', () => {
  it('relays without touching the conversation, and forwards questions and outcomes', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    const registry = new SessionRegistry({ store: opened.store, reconcileIntervalMs: 60_000 });
    const adapter = new HoldingAdapter();
    registry.registerAdapter(adapter);
    await registry.start();

    const seen: string[] = [];
    registry.on('question', (event) => seen.push(event.type));
    registry.on('outcome', (outcome) => seen.push(outcome.state));
    adapter.emit();
    expect(seen).toEqual(['asked', 'working']);

    await registry.relayToWorker('holding:one', 'relayed text');
    expect(adapter.sent).toEqual(['relayed text']);
    expect(opened.store.getConversation('holding:one')).toEqual([]);

    expect(await registry.answerQuestion('holding:one', 'held', 'yes')).toBe(true);
    expect(await registry.answerQuestion('holding:one', 'gone', 'yes')).toBe(false);
    expect(registry.outcomeOf('holding:one')?.state).toBe('completed');
    await registry.stop();
  });
});

import { randomUUID } from 'node:crypto';

import type { SessionRegistry } from '../registry/session-registry.js';
import type { InstructionResult, LaunchOptions, Unsubscribe } from '../types/adapter.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import type {
  CaptainDelivery,
  CaptainExchange,
  CaptainExchangeStore,
  WorkerOutcome,
  WorkerQuestion,
  WorkerQuestionEvent,
  WorkerQuestionSettled,
} from './types.js';

/**
 * Which captain, if any, a worker may ask instead of stopping for the
 * developer. The fleet layout answers this (a wire from a captain to the
 * worker); the relay only asks.
 */
export interface CaptainRouting {
  captainFor(projectId: string, sessionId: string): Promise<string | null>;
}

/** No wires anywhere: every question goes to the developer. */
export const NO_CAPTAINS: CaptainRouting = { captainFor: async () => null };

/**
 * What the relay needs from the workers, and nothing more.
 *
 * Text moves only through `relay` and `answerQuestion` — the explicit control
 * path. A captain is given nothing here; it cannot reach another worker.
 */
export interface FleetWorkers {
  session(sessionId: string): AgentSession | null;
  launch(options: LaunchOptions, provider?: string): Promise<AgentSession>;
  relay(sessionId: string, text: string): Promise<InstructionResult>;
  answerQuestion(sessionId: string, questionId: string, answer: string): Promise<boolean>;
  outcomeOf(sessionId: string): WorkerOutcome | null;
  onQuestion(listener: (event: WorkerQuestionEvent) => void): Unsubscribe;
  onOutcome(listener: (outcome: WorkerOutcome) => void): Unsubscribe;
  onEvent(listener: (event: NormalizedEvent) => void): Unsubscribe;
}

/** The registry, seen as fleet workers. */
export function registryWorkers(registry: SessionRegistry): FleetWorkers {
  const on = <K extends 'question' | 'outcome' | 'event'>(
    name: K,
    listener: (...args: never[]) => void,
  ): Unsubscribe => {
    registry.on(name, listener as never);
    return () => {
      registry.off(name, listener as never);
    };
  };
  return {
    session: (sessionId) => registry.get(sessionId),
    launch: (options, provider) => {
      const capable = registry.launchCapableProviders();
      const target = provider && capable.includes(provider) ? provider : capable[0];
      if (!target) throw new Error('No installed provider can start a new session.');
      return registry.launchSession(target, options);
    },
    relay: (sessionId, text) => registry.relayToWorker(sessionId, text),
    answerQuestion: (sessionId, questionId, answer) =>
      registry.answerQuestion(sessionId, questionId, answer),
    outcomeOf: (sessionId) => registry.outcomeOf(sessionId),
    onQuestion: (listener) => on('question', listener),
    onOutcome: (listener) => on('outcome', listener),
    onEvent: (listener) => on('event', listener),
  };
}

export interface FleetRelayOptions {
  store: CaptainExchangeStore;
  workers: FleetWorkers;
  routing?: CaptainRouting;
  /** From relaying a question to giving up on the captain. Default 3 minutes. */
  captainTimeoutMs?: number;
  /** Captains are Claude Code workers unless this says otherwise. */
  captainProvider?: string;
  onError?: (scope: string, error: unknown) => void;
}

/** A line in the captain's reply that hands the question to the developer. */
const PASS_LINE = /^\s*PASS:\s*(.*)$/m;

/**
 * Moves a worker's question to its captain and the captain's answer back.
 *
 * The relay, not the captain, is the only thing that carries text between
 * workers, and it does so over the explicit instruction path. What it moved is
 * recorded as a `CaptainExchange`, never as either session's conversation.
 *
 * A question with no wired captain is recorded for the developer straight
 * away. A wired question is relayed; the captain's next completed turn is its
 * answer. A `PASS:` line, a failed turn or the timeout hands it to the
 * developer instead. One captain answers one question at a time, so a turn's
 * end is always the end of the question it was given.
 */
export class FleetRelay {
  private readonly store: CaptainExchangeStore;
  private readonly workers: FleetWorkers;
  private readonly routing: CaptainRouting;
  private readonly captainTimeoutMs: number;
  private readonly captainProvider: string;
  private readonly onError: (scope: string, error: unknown) => void;
  /** Per captain, the tail of its queue. */
  private readonly captains = new Map<string, Promise<void>>();
  /** Open exchanges by `${askerSessionId}#${questionId}`. */
  private readonly open = new Map<string, string>();
  private readonly pending = new Set<Promise<unknown>>();
  private stops: Unsubscribe[] = [];

  constructor(options: FleetRelayOptions) {
    this.store = options.store;
    this.workers = options.workers;
    this.routing = options.routing ?? NO_CAPTAINS;
    this.captainTimeoutMs = options.captainTimeoutMs ?? 180_000;
    this.captainProvider = options.captainProvider ?? 'claude-code';
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.stops.length) return;
    this.stops.push(
      this.workers.onQuestion((event) => {
        const work =
          event.type === 'asked' ? this.asked(event.question) : this.settled(event.settled);
        this.track(work.catch((error) => this.onError('fleet-relay', error)));
      }),
    );
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  /** Everything in flight has finished. For tests and orderly shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * Start a captain: a Claude worker given the captain brief, read-only.
   * It belongs to the fleet once the layout says so; nothing here wires it.
   */
  async launchCaptain(projectId: string, folder: string): Promise<AgentSession> {
    return this.workers.launch(
      { cwd: folder, prompt: captainBrief(projectId, folder), readOnly: true },
      this.captainProvider,
    );
  }

  /** The developer answers. Optionally the captain hears the answer too. */
  async answerAsUser(
    exchangeId: string,
    text: string,
    alsoTellCaptain: boolean,
  ): Promise<CaptainExchange> {
    const exchange = this.store.getCaptainExchange(exchangeId);
    if (!exchange) throw new Error(`vowe: no captain exchange ${exchangeId}`);
    if (exchange.status === 'answered') throw new Error('vowe: this question has already been answered');
    const answer = text.trim();
    if (!answer) throw new Error('vowe: an answer cannot be empty');

    const delivery = await this.deliver(exchange, answer);
    const saved = await this.store.saveCaptainExchange({
      ...exchange,
      route: 'you',
      userAnswer: answer,
      status: 'answered',
      delivery,
      answeredAt: new Date().toISOString(),
    });
    this.open.delete(openKey(exchange.askerSessionId, exchange.questionId));

    if (alsoTellCaptain) {
      const captainId =
        exchange.captainSessionId ??
        (await this.routing.captainFor(exchange.projectId, exchange.askerSessionId));
      if (captainId && captainId !== exchange.askerSessionId) {
        this.track(
          this.enqueue(captainId, () => this.inform(captainId, saved)).catch((error) =>
            this.onError('fleet-relay:inform', error),
          ),
        );
      }
    }
    return saved;
  }

  // ----------------------------------------------------------------- private

  private async asked(question: WorkerQuestion): Promise<void> {
    const asker = this.workers.session(question.sessionId);
    const projectId = asker?.projectId;
    if (!projectId) {
      // Nothing to route through and nowhere to record it; the transcript's
      // own question still reaches the developer as needs-you.
      this.onError('fleet-relay', new Error(`vowe: ${question.sessionId} asked outside any project`));
      return;
    }
    const routed = await this.routing.captainFor(projectId, question.sessionId);
    const captainId = routed && routed !== question.sessionId ? routed : null;

    const exchange = await this.store.saveCaptainExchange({
      id: randomUUID(),
      projectId,
      askerSessionId: question.sessionId,
      questionId: question.id,
      ...(question.toolUseId ? { toolUseId: question.toolUseId } : {}),
      captainSessionId: captainId,
      question: question.question,
      ...(question.options?.length ? { options: question.options } : {}),
      captainAnswer: null,
      route: captainId ? 'captain' : 'you',
      userAnswer: null,
      status: 'pending',
      delivery: null,
      askedAt: question.askedAt,
      answeredAt: null,
    });
    this.open.set(openKey(question.sessionId, question.id), exchange.id);
    if (captainId) await this.enqueue(captainId, () => this.consult(captainId, exchange.id, asker));
  }

  /** A held question settled by something other than this relay. */
  private async settled(settled: WorkerQuestionSettled): Promise<void> {
    const key = openKey(settled.sessionId, settled.id);
    const exchangeId = this.open.get(key);
    if (!exchangeId || settled.by === 'host') return;
    this.open.delete(key);
    if (settled.by !== 'instruction' || settled.answer === null) return;
    const exchange = this.store.getCaptainExchange(exchangeId);
    if (!exchange || exchange.status === 'answered') return;
    await this.store.saveCaptainExchange({
      ...exchange,
      route: 'you',
      userAnswer: settled.answer,
      status: 'answered',
      delivery: 'in-place',
      answeredAt: settled.at,
    });
  }

  private async consult(captainId: string, exchangeId: string, asker: AgentSession): Promise<void> {
    const deadline = Date.now() + this.captainTimeoutMs;
    const initial = this.store.getCaptainExchange(exchangeId);
    if (!initial || initial.status !== 'pending') return;

    // A captain mid-turn would end that turn first; that ending is not ours.
    if (this.workers.outcomeOf(captainId)?.state === 'working') {
      const settled = await this.nextTurnEnd(captainId, deadline, true);
      if (!settled) return this.pass(exchangeId, null, 'The captain was busy and did not answer in time.');
    }

    let reply: string | null | undefined;
    try {
      reply = await this.ask(captainId, relayMessage(asker, initial), deadline);
    } catch (error) {
      return this.pass(exchangeId, null, `The captain could not be reached: ${messageOf(error)}`);
    }
    if (reply === undefined) return this.pass(exchangeId, null, 'The captain did not answer in time.');
    if (!reply) return this.pass(exchangeId, null, 'The captain could not answer.');

    const passed = PASS_LINE.exec(reply);
    if (passed) {
      return this.pass(exchangeId, reply, passed[1]?.trim() || 'The captain passed it to you.');
    }

    const current = this.store.getCaptainExchange(exchangeId);
    // The developer, or an instruction, may have answered while it waited.
    if (!current || current.status === 'answered') return;
    const delivery = await this.deliver(current, reply);
    await this.store.saveCaptainExchange({
      ...current,
      captainAnswer: reply,
      route: 'captain',
      status: 'answered',
      delivery,
      answeredAt: new Date().toISOString(),
    });
    this.open.delete(openKey(current.askerSessionId, current.questionId));
  }

  /**
   * Relay text to a captain and read its next completed turn.
   * `undefined` on timeout; `null` when the turn ended with nothing to say.
   */
  private async ask(captainId: string, text: string, deadline: number): Promise<string | null | undefined> {
    let said: string | null = null;
    let armed = false;
    const stopEvents = this.workers.onEvent((event) => {
      if (!armed || event.sessionId !== captainId || event.kind !== 'agent_message') return;
      const body = event.detail?.['text'];
      if (typeof body === 'string' && body.trim()) said = body.trim();
    });
    try {
      const ended = this.nextTurnEnd(captainId, deadline, false, () => armed);
      armed = true;
      await this.workers.relay(captainId, text);
      const outcome = await ended;
      if (!outcome) return undefined;
      if (outcome.state === 'failed') return null;
      return outcome.text?.trim() || said;
    } finally {
      stopEvents();
    }
  }

  /** Tell the captain what the developer decided. Its reply goes nowhere. */
  private async inform(captainId: string, exchange: CaptainExchange): Promise<void> {
    const deadline = Date.now() + this.captainTimeoutMs;
    if (this.workers.outcomeOf(captainId)?.state === 'working') {
      await this.nextTurnEnd(captainId, deadline, true);
    }
    const asker = this.workers.session(exchange.askerSessionId);
    const ended = this.nextTurnEnd(captainId, deadline, false);
    await this.workers.relay(captainId, informMessage(asker, exchange));
    await ended;
  }

  /**
   * The captain's next turn ending, or `null` at the deadline.
   * `anyEnd` accepts an ending already in progress; otherwise only an ending
   * that follows a start seen (or `armed`) after subscribing counts.
   */
  private nextTurnEnd(
    captainId: string,
    deadline: number,
    anyEnd: boolean,
    armed: () => boolean = () => false,
  ): Promise<WorkerOutcome | null> {
    return new Promise((resolve) => {
      let started = anyEnd;
      const finish = (outcome: WorkerOutcome | null) => {
        clearTimeout(timer);
        stop();
        resolve(outcome);
      };
      const stop = this.workers.onOutcome((outcome) => {
        if (outcome.sessionId !== captainId) return;
        if (outcome.state === 'working') {
          started = true;
          return;
        }
        if (started || armed()) finish(outcome);
      });
      const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    });
  }

  private async pass(exchangeId: string, captainSaid: string | null, reason: string): Promise<void> {
    const current = this.store.getCaptainExchange(exchangeId);
    if (!current || current.status === 'answered') return;
    await this.store.saveCaptainExchange({
      ...current,
      captainAnswer: captainSaid,
      route: 'you',
      passedToYouReason: reason,
      status: 'passed',
    });
  }

  /** In place when the worker is still holding the question; else as its next turn. */
  private async deliver(exchange: CaptainExchange, answer: string): Promise<CaptainDelivery> {
    try {
      if (await this.workers.answerQuestion(exchange.askerSessionId, exchange.questionId, answer)) {
        return 'in-place';
      }
    } catch (error) {
      this.onError('fleet-relay:answer', error);
    }
    try {
      const result = await this.workers.relay(
        exchange.askerSessionId,
        `${CAPTAIN_ANSWER_MARK}${oneLine(exchange.question)}):\n${answer}`,
      );
      return result.delivered ? 'instruction' : 'failed';
    } catch (error) {
      this.onError('fleet-relay:deliver', error);
      return 'failed';
    }
  }

  private enqueue(captainId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.captains.get(captainId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.captains.set(captainId, tail);
    void tail.then(() => {
      if (this.captains.get(captainId) === tail) this.captains.delete(captainId);
    });
    return next;
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
}

function openKey(sessionId: string, questionId: string): string {
  return `${sessionId}#${questionId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

function nameOf(session: AgentSession | null): string {
  if (!session) return 'another agent';
  return session.generatedTitle ?? session.displayLabel;
}

/** How the relay's own messages begin, so a transcript can tell them apart. */
const RELAY_MARK = '[Vowe relay]';
const CAPTAIN_ANSWER_MARK = 'Answer to your earlier question (';

/**
 * Who a user-role message delivered by the relay came from: a captain's answer
 * passed to the agent that asked, or the relay writing to a captain. Null for
 * anything the relay did not write.
 */
export function relayOriginOf(text: string): 'captain' | 'relay' | null {
  const start = text.trimStart();
  if (start.startsWith(CAPTAIN_ANSWER_MARK)) return 'captain';
  if (start.startsWith(RELAY_MARK)) return 'relay';
  return null;
}

/** What the captain is told when a question is relayed to it. */
export function relayMessage(asker: AgentSession | null, exchange: CaptainExchange): string {
  const lines = [
    `${RELAY_MARK} A question from ${nameOf(asker)}${asker?.task ? `, working on: ${oneLine(asker.task)}` : ''}.`,
    '',
    exchange.question,
  ];
  if (exchange.options?.length) lines.push('', `Options: ${exchange.options.join(' / ')}`);
  lines.push(
    '',
    'Reply with the answer for that agent: concise, citing files as path or path:line where you can. Vowe passes your reply back to it.',
    'If the project does not settle this and the developer has to decide, reply with a line `PASS: <why>` instead.',
  );
  return lines.join('\n');
}

function informMessage(asker: AgentSession | null, exchange: CaptainExchange): string {
  return [
    `${RELAY_MARK} For your context: the developer answered a question from ${nameOf(asker)}.`,
    '',
    `Question: ${exchange.question}`,
    `Answer: ${exchange.userAnswer ?? ''}`,
    '',
    'No reply is needed.',
  ].join('\n');
}

/** The standing brief a captain is launched with. */
export function captainBrief(projectId: string, folder: string): string {
  return [
    `You are the captain for a project in Vowe (${projectId}), working in ${folder}.`,
    '',
    'Other coding agents in this project may be wired to you. When one of them has a question, Vowe relays it to you instead of stopping for the developer, and passes your reply back to that agent. You cannot message other agents yourself, and you should not change any files.',
    '',
    'Start by getting to know this project: its layout, conventions, build and test commands, and the decisions recorded in its docs. Keep that context; you will be asked about it. When you are done, reply `Ready.`',
    '',
    'When a question arrives:',
    '- Answer only what was asked, in a few lines, citing files as path or path:line.',
    '- Read the code before answering when you are not sure; say what you checked.',
    '- When the project does not settle it — a product decision, a preference, anything only the developer can decide — reply with a line `PASS: <why>` and nothing else.',
  ].join('\n');
}

import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { WorkerOutcome, WorkerQuestionEvent } from '@vowe/core';

/** A queue that presents itself to the SDK as a stream of user turns. */
class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.buffered.push(message);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const buffered = this.buffered.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>(
        (resolve) => {
          this.waiting = resolve;
        },
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

export function userTurn(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

export interface ManagedSession {
  sessionId: string;
  cwd: string;
  queue: UserMessageQueue;
  query: Query;
  /** False once the underlying query has ended. */
  alive: boolean;
  /** Questions the worker is blocked on, oldest first, by tool use id. */
  held: Map<string, HeldQuestion>;
}

/**
 * An `AskUserQuestion` call parked in `canUseTool`.
 *
 * Without a `canUseTool` callback the CLI treats the tool's `ask` as a
 * terminal denial ("no prompt available in headless mode"), so the worker
 * never actually waits. With one, auto mode falls back to `ask` for a tool
 * that requires user interaction and the call blocks on this promise; the
 * answers ride back in `updatedInput.answers`, keyed by question text, which
 * is what the tool reports to the model.
 */
interface HeldQuestion {
  id: string;
  input: Record<string, unknown>;
  questions: string[];
  resolve: (result: PermissionResult) => void;
}

/** What `canUseTool` tells the model for anything other than a question. */
const NO_APPROVAL_SURFACE =
  'This session has no approval surface, so the action was denied automatically and was not performed. Do not retry it; continue without it or say what you need.';

/** Tools withheld from a read-only worker. Bash stays: reading needs it. */
const WRITING_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

export interface LaunchControlOptions {
  readOnly?: boolean;
}

export interface ControlChannelOptions {
  /**
   * Permission mode for sessions Vowe starts. `auto` lets Claude Code's own
   * classifier approve routine actions and stop on risky ones, which is the
   * right default for a session running unattended while the developer
   * watches through Vowe.
   */
  permissionMode?: Options['permissionMode'];
  onError?: (scope: string, error: unknown) => void;
  /** The SDK entry point. Replaced only by a test. */
  query?: typeof query;
}

/**
 * The control channel: the only part of Vowe that can make a coding agent do
 * something.
 *
 * Two ways in, with different reach:
 *  - sessions Vowe launched are held open with a streaming input queue, so an
 *    instruction becomes the agent's next turn;
 *  - sessions that exist but are not running are continued headlessly by
 *    session id.
 *
 * A session running in a terminal we do not own has no entry here at all —
 * Claude Code exposes no public way to message it — which is why the adapter
 * reports `sendInstruction: false` for that case instead of pretending.
 */
export class ControlChannel {
  private readonly managed = new Map<string, ManagedSession>();
  private readonly outcomes = new Map<string, WorkerOutcome>();
  private readonly questionListeners = new Set<(event: WorkerQuestionEvent) => void>();
  private readonly outcomeListeners = new Set<(outcome: WorkerOutcome) => void>();
  private readonly messageListeners = new Set<(providerSessionId: string, message: SDKMessage) => void>();
  private readonly permissionMode: Options['permissionMode'];
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly query: typeof query;

  constructor(options: ControlChannelOptions = {}) {
    this.permissionMode = options.permissionMode ?? 'auto';
    this.onError = options.onError ?? (() => undefined);
    this.query = options.query ?? query;
  }

  isManaged(sessionId: string): boolean {
    return this.managed.get(sessionId)?.alive === true;
  }

  managedSessionIds(): string[] {
    return [...this.managed.values()]
      .filter((session) => session.alive)
      .map((session) => session.sessionId);
  }

  getManaged(sessionId: string): ManagedSession | undefined {
    return this.managed.get(sessionId);
  }

  /**
   * Start a new session and keep it open for later instructions.
   * Resolves as soon as the provider reports its session id.
   */
  async launch(
    cwd: string,
    prompt: string,
    launchOptions: LaunchControlOptions = {},
  ): Promise<ManagedSession> {
    const queue = new UserMessageQueue();
    queue.push(userTurn(prompt));

    const session: ManagedSession = {
      sessionId: '',
      cwd,
      queue,
      query: null as unknown as Query,
      alive: true,
      held: new Map(),
    };

    const options: Options = {
      cwd,
      permissionMode: this.permissionMode,
      canUseTool: (toolName, input, context) => this.decide(session, toolName, input, context),
      // Streamed tokens feed the transcript; nothing else reads them.
      includePartialMessages: true,
    };
    if (launchOptions.readOnly) options.disallowedTools = WRITING_TOOLS;
    const running = this.query({ prompt: queue, options });
    session.query = running;

    const sessionId = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let failed = false;
      void (async () => {
        try {
          for await (const message of running) {
            const id = (message as { session_id?: string }).session_id;
            if (!settled && id) {
              settled = true;
              session.sessionId = id;
              this.managed.set(id, session);
              this.noteOutcome({ sessionId: id, state: 'working', at: now() });
              resolve(id);
            }
            if (session.sessionId) {
              this.observeResult(session.sessionId, message);
              this.emitMessage(session.sessionId, message);
            }
          }
        } catch (error) {
          failed = true;
          this.onError('managed-session', error);
          if (session.sessionId) {
            this.noteOutcome({ sessionId: session.sessionId, state: 'failed', at: now(), error: errorText(error) });
          }
          if (!settled) {
            settled = true;
            reject(error);
          }
        } finally {
          session.alive = false;
          queue.close();
          this.abandonHeld(session);
          const last = this.outcomes.get(session.sessionId);
          if (session.sessionId && !failed && last?.state !== 'failed') {
            this.noteOutcome({ sessionId: session.sessionId, state: 'ended', at: now() });
          }
        }
      })();
    });

    session.sessionId = sessionId;
    return session;
  }

  /**
   * Deliver an instruction as the next turn of a session we are holding open.
   *
   * A worker blocked on a question cannot start a next turn until the question
   * is settled, so an instruction that arrives then is the answer: it settles
   * the oldest held question rather than queueing behind it forever.
   */
  sendToManaged(sessionId: string, text: string): 'queued' | 'answered' | false {
    const session = this.managed.get(sessionId);
    if (!session?.alive) return false;
    const oldest = session.held.values().next();
    if (!oldest.done) {
      this.settle(session, oldest.value, text, 'instruction');
      return 'answered';
    }
    session.queue.push(userTurn(text));
    this.noteOutcome({ sessionId, state: 'working', at: now() });
    return 'queued';
  }

  /** Settle a held question with an answer. False when it is not held. */
  answerQuestion(sessionId: string, questionId: string, answer: string): boolean {
    const session = this.managed.get(sessionId);
    const held = session?.held.get(questionId);
    if (!session?.alive || !held) return false;
    this.settle(session, held, answer, 'host');
    return true;
  }

  outcomeOf(sessionId: string): WorkerOutcome | null {
    const outcome = this.outcomes.get(sessionId);
    return outcome ? { ...outcome, sessionId: voweId(sessionId) } : null;
  }

  onQuestion(listener: (event: WorkerQuestionEvent) => void): () => void {
    this.questionListeners.add(listener);
    return () => this.questionListeners.delete(listener);
  }

  onOutcome(listener: (outcome: WorkerOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  /**
   * Every SDK message a launched session produces, partial ones included, by
   * provider session id. For the transcript feed; observation reads the
   * transcript file and control reads only results.
   */
  onMessage(listener: (providerSessionId: string, message: SDKMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /**
   * The host's half of the permission protocol.
   *
   * Only a question is held. Everything else that reaches here is an `ask`
   * the auto-mode classifier would not settle, and before this callback
   * existed the CLI denied those itself; denying them here keeps that.
   */
  private decide(
    session: ManagedSession,
    toolName: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (toolName !== 'AskUserQuestion') {
      return Promise.resolve({ behavior: 'deny', message: NO_APPROVAL_SURFACE });
    }
    const asked = questionsOf(input);
    return new Promise<PermissionResult>((resolve) => {
      const held: HeldQuestion = {
        id: context.toolUseID,
        input,
        questions: asked.map((q) => q.question),
        resolve,
      };
      session.held.set(held.id, held);
      context.signal.addEventListener(
        'abort',
        () => this.settle(session, held, null, 'aborted'),
        { once: true },
      );
      const only = asked.length === 1 ? asked[0] : undefined;
      this.emitQuestion({
        type: 'asked',
        question: {
          id: held.id,
          sessionId: voweId(session.sessionId),
          toolUseId: held.id,
          question: asked.map((q) => q.question.trim()).join('\n'),
          ...(only?.options.length ? { options: only.options } : {}),
          askedAt: now(),
        },
      });
    });
  }

  private settle(
    session: ManagedSession,
    held: HeldQuestion,
    answer: string | null,
    by: 'host' | 'instruction' | 'aborted',
  ): void {
    if (session.held.get(held.id) !== held) return;
    session.held.delete(held.id);
    held.resolve(
      answer === null
        ? { behavior: 'deny', message: 'The question was not answered.' }
        : {
            behavior: 'allow',
            updatedInput: {
              ...held.input,
              answers: Object.fromEntries(held.questions.map((question) => [question, answer])),
            },
          },
    );
    this.emitQuestion({
      type: 'settled',
      settled: { id: held.id, sessionId: voweId(session.sessionId), answer, by, at: now() },
    });
  }

  private abandonHeld(session: ManagedSession): void {
    for (const held of [...session.held.values()]) this.settle(session, held, null, 'aborted');
  }

  /** One result message per turn: the provider's turn-complete signal. */
  private observeResult(sessionId: string, message: SDKMessage): void {
    if (message.type !== 'result') return;
    const queued = (message.queued_turn_count ?? 0) > 0;
    if (message.subtype === 'success' && !message.is_error) {
      this.noteOutcome({
        sessionId,
        state: queued ? 'working' : 'completed',
        at: now(),
        ...(message.result ? { text: message.result } : {}),
      });
      return;
    }
    const error =
      message.subtype === 'success' ? message.result : [message.subtype, ...message.errors].join(': ');
    this.noteOutcome({ sessionId, state: 'failed', at: now(), ...(error ? { error } : {}) });
  }

  private noteOutcome(outcome: WorkerOutcome): void {
    this.outcomes.set(outcome.sessionId, outcome);
    const published = { ...outcome, sessionId: voweId(outcome.sessionId) };
    for (const listener of this.outcomeListeners) {
      try {
        listener(published);
      } catch (error) {
        this.onError('outcome-listener', error);
      }
    }
  }

  private emitMessage(sessionId: string, message: SDKMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(sessionId, message);
      } catch (error) {
        this.onError('message-listener', error);
      }
    }
  }

  private emitQuestion(event: WorkerQuestionEvent): void {
    for (const listener of this.questionListeners) {
      try {
        listener(event);
      } catch (error) {
        this.onError('question-listener', error);
      }
    }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const session = this.managed.get(sessionId);
    if (!session?.alive) return false;
    await session.query.interrupt();
    return true;
  }

  /**
   * Continue a session that is not currently running.
   *
   * The instruction is delivered by resuming the real conversation, so the
   * agent sees it in context. We do not wait for the work to finish; the
   * transcript tail is how we observe what happens next.
   */
  async resumeWithInstruction(
    sessionId: string,
    cwd: string | null,
    text: string,
  ): Promise<void> {
    const options: Options = {
      resume: sessionId,
      permissionMode: this.permissionMode,
    };
    if (cwd) options.cwd = cwd;

    const running = this.query({ prompt: text, options });
    this.noteOutcome({ sessionId, state: 'working', at: now() });
    void (async () => {
      try {
        for await (const message of running) {
          // Observation happens through the transcript, so there is exactly
          // one event pipeline to trust; only the turn's ending is read here.
          this.observeResult(sessionId, message);
        }
      } catch (error) {
        this.onError('resume', error);
        this.noteOutcome({ sessionId, state: 'failed', at: now(), error: errorText(error) });
      }
    })();
  }

  async dispose(): Promise<void> {
    for (const session of this.managed.values()) {
      this.abandonHeld(session);
      session.queue.close();
      try {
        session.query.close();
      } catch (error) {
        this.onError('dispose', error);
      }
      session.alive = false;
    }
    this.managed.clear();
  }
}

/** The provider's own id is the adapter's business; listeners get Vowe's. */
function voweId(providerSessionId: string): string {
  return `claude-code:${providerSessionId}`;
}

function now(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AskedQuestion {
  question: string;
  options: string[];
}

/** The questions an `AskUserQuestion` input carries, tolerating any shape. */
export function questionsOf(input: Record<string, unknown>): AskedQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const asked: AskedQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { question, options } = item as { question?: unknown; options?: unknown };
    if (typeof question !== 'string' || !question.trim()) continue;
    const labels = (Array.isArray(options) ? options : [])
      .map((option: unknown) =>
        typeof option === 'object' && option !== null ? (option as { label?: unknown }).label : null,
      )
      .filter((label): label is string => typeof label === 'string' && label.length > 0);
    // Verbatim: the tool looks answers up by exactly this text.
    asked.push({ question, options: labels });
  }
  return asked;
}

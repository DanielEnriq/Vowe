import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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
  private readonly permissionMode: Options['permissionMode'];
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: ControlChannelOptions = {}) {
    this.permissionMode = options.permissionMode ?? 'auto';
    this.onError = options.onError ?? (() => undefined);
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
  async launch(cwd: string, prompt: string): Promise<ManagedSession> {
    const queue = new UserMessageQueue();
    queue.push(userTurn(prompt));

    const running = query({
      prompt: queue,
      options: { cwd, permissionMode: this.permissionMode },
    });

    const session: ManagedSession = {
      sessionId: '',
      cwd,
      queue,
      query: running,
      alive: true,
    };

    const sessionId = await new Promise<string>((resolve, reject) => {
      let settled = false;
      void (async () => {
        try {
          for await (const message of running) {
            const id = (message as { session_id?: string }).session_id;
            if (!settled && id) {
              settled = true;
              session.sessionId = id;
              this.managed.set(id, session);
              resolve(id);
            }
          }
        } catch (error) {
          this.onError('managed-session', error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        } finally {
          session.alive = false;
          queue.close();
        }
      })();
    });

    session.sessionId = sessionId;
    return session;
  }

  /** Deliver an instruction as the next turn of a session we are holding open. */
  sendToManaged(sessionId: string, text: string): boolean {
    const session = this.managed.get(sessionId);
    if (!session?.alive) return false;
    session.queue.push(userTurn(text));
    return true;
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

    const running = query({ prompt: text, options });
    void (async () => {
      try {
        for await (const _message of running) {
          // Drained deliberately: observation happens through the transcript,
          // so there is exactly one event pipeline to trust.
        }
      } catch (error) {
        this.onError('resume', error);
      }
    })();
  }

  async dispose(): Promise<void> {
    for (const session of this.managed.values()) {
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

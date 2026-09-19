import { EventEmitter } from 'node:events';

import type { DelegatedQuestionRunner } from '../delegation/delegated-question-runner.js';
import type {
  CommunicationDecision,
  SurfaceUpdate,
  WindowNote,
} from '../observation/trace-window.js';
import type { ObservationService } from '../observation/observation-service.js';
import { LIVE_APPEND_TOKEN_LIMIT, VO_SYSTEM_PROMPT } from './vo-prompt.js';
import type {
  LiveServerEvent,
  LiveSideband,
  LiveTransport,
} from './live-transport.js';

export interface LiveBridgeOptions {
  transport: LiveTransport;
  observation: ObservationService;
  delegated: DelegatedQuestionRunner;
  /** How much spoken history to keep for reconstructing a delegated question. */
  transcriptTurns?: number;
  onError?: (scope: string, error: unknown) => void;
}

export type LiveBridgeEvents = {
  status: [LiveStatus];
  /** A delegated question and the answer Vowe gave. For the UI. */
  answered: [{ sessionId: string; question: string; spokenAnswer: string; fullAnswer: string }];
};

export interface LiveStatus {
  /** False when no voice credential is configured. */
  available: boolean;
  unavailableReason: string | null;
  connected: boolean;
  /** False when the renderer has a session but the backend could not attach. */
  sidebandAttached: boolean;
  /** The session Vo is currently talking about. */
  sessionId: string | null;
  liveSessionId: string | null;
}

interface Attachment {
  sessionId: string;
  liveSessionId: string;
  sideband: LiveSideband | null;
  detach: (() => void) | null;
}

/**
 * Connects the observation harness to the live conversation.
 *
 * Three distinct paths run through here, and keeping them distinct is the point
 * of the class:
 *
 *  - **Quiet context.** Every window note goes to the assistant silently. It is
 *    never spoken on arrival, but it means that when the user asks "what is it
 *    doing?", the answer is already there without a round trip.
 *  - **Proactive communication.** A candidate the policy approved is handed over
 *    as something to say. Vo phrases it; Vowe decides it is worth saying.
 *  - **Delegated questions.** The assistant asks the backend to handle
 *    something; the backend investigates and hands back a short spoken answer.
 *
 * None of these blocks the others, and none of them blocks observation.
 *
 * What never crosses this boundary: raw trace records, file contents, diffs,
 * command output, credentials, absolute paths. Only interpreted prose goes to
 * the voice provider. `toLiveText` is the single chokepoint.
 */
export class LiveBridge extends EventEmitter<LiveBridgeEvents> {
  private readonly transport: LiveTransport;
  private readonly observation: ObservationService;
  private readonly delegated: DelegatedQuestionRunner;
  private readonly transcriptTurns: number;
  private readonly onError: (scope: string, error: unknown) => void;

  private attachment: Attachment | null = null;
  /** Spoken history, newest last. The only record of what was actually said. */
  private transcript: { speaker: 'user' | 'vo'; text: string }[] = [];
  private userFragment = '';
  private voFragment = '';
  /**
   * Approved updates held back because the moment was wrong. Flushed when the
   * user next speaks, so a queued thought arrives in conversation rather than
   * out of nowhere.
   */
  private queued: SurfaceUpdate[] = [];
  private listening = false;

  constructor(options: LiveBridgeOptions) {
    super();
    this.transport = options.transport;
    this.observation = options.observation;
    this.delegated = options.delegated;
    this.transcriptTurns = options.transcriptTurns ?? 20;
    this.onError = options.onError ?? (() => undefined);
    this.listen();
  }

  get status(): LiveStatus {
    return {
      available: this.transport.available,
      unavailableReason: this.transport.unavailableReason,
      connected: this.attachment !== null,
      sidebandAttached: this.attachment?.sideband != null,
      sessionId: this.attachment?.sessionId ?? null,
      liveSessionId: this.attachment?.liveSessionId ?? null,
    };
  }

  get systemPrompt(): string {
    return VO_SYSTEM_PROMPT;
  }

  /**
   * Start a conversation about one session.
   *
   * The SDP offer comes from the renderer, which owns the microphone; the
   * answer goes back to it. Between those two the backend attaches its own
   * connection, which is how observation reaches a conversation whose audio
   * never passes through this process.
   */
  async start(
    sessionId: string,
    sdpOffer: string,
  ): Promise<{ sdpAnswer: string; status: LiveStatus }> {
    if (!this.transport.available) {
      throw new Error(
        this.transport.unavailableReason ?? 'Voice is not available.',
      );
    }
    await this.stop();

    const created = await this.transport.createSession({
      sdpOffer,
      instructions: VO_SYSTEM_PROMPT,
    });

    this.attachment = {
      sessionId,
      liveSessionId: created.liveSessionId,
      sideband: null,
      detach: null,
    };
    this.transcript = [];
    this.userFragment = '';
    this.voFragment = '';

    try {
      const sideband = await this.transport.attachSideband(created.liveSessionId);
      if (sideband) {
        this.attachment.sideband = sideband;
        this.attachment.detach = sideband.on((event) => {
          void this.handle(event).catch((error) => this.onError('live:event', error));
        });
        await this.primeSession(sessionId, sideband);
      }
    } catch (error) {
      // A conversation the backend cannot observe is degraded, not broken: the
      // user can still talk to Vo, they just will not get proactive updates.
      this.onError('live:sideband', error);
    }

    this.emit('status', this.status);
    return { sdpAnswer: created.sdpAnswer, status: this.status };
  }

  async stop(): Promise<void> {
    const attachment = this.attachment;
    this.attachment = null;
    this.queued = [];
    if (!attachment) return;
    attachment.detach?.();
    try {
      await attachment.sideband?.close();
    } catch (error) {
      this.onError('live:close', error);
    }
    this.emit('status', this.status);
  }

  // ----------------------------------------------------------- observation in

  private listen(): void {
    if (this.listening) return;
    this.listening = true;

    this.observation.on('note', (note) => {
      void this.deliverQuiet(note).catch((error) =>
        this.onError('live:quiet', error),
      );
    });

    this.observation.on('surface', (update, decision) => {
      void this.deliverSurface(update, decision).catch((error) =>
        this.onError('live:surface', error),
      );
    });
  }

  /**
   * A new L1 note, delivered silently.
   *
   * This is the difference between an assistant that can answer "what is it
   * doing?" instantly and one that has to go and find out every time. It is
   * also why the note does not get spoken: the user asked to be told about
   * *developments*, not about every window.
   */
  private async deliverQuiet(note: WindowNote): Promise<void> {
    const sideband = this.sidebandFor(note.sessionId);
    if (!sideband) return;
    const text = [note.summary, note.currentActivity && `Now: ${note.currentActivity}`]
      .filter(Boolean)
      .join(' ');
    await sideband.appendThinking(toLiveText(text));
  }

  private async deliverSurface(
    update: SurfaceUpdate,
    decision: CommunicationDecision,
  ): Promise<void> {
    const sideband = this.sidebandFor(update.sessionId);
    if (!sideband) return;

    switch (decision.action) {
      case 'ignore':
        // Stored, and that is all. Someone may want to see it in the UI later.
        return;
      case 'quiet_context':
        await sideband.appendThinking(toLiveText(`${update.message} (${update.whyNow})`));
        return;
      case 'queue':
        this.queued.push(update);
        return;
      case 'speak_now':
        await this.speak(update, sideband);
        return;
    }
  }

  private async speak(
    update: SurfaceUpdate,
    sideband: LiveSideband,
  ): Promise<void> {
    await sideband.appendCommentary(
      toLiveText(`${update.message} Worth mentioning now because: ${update.whyNow}`),
    );
    // Handing it over is the moment it reached the developer; recording that
    // separately from the decision is what makes "approved but never said"
    // visible rather than invisible.
    await this.observation.markSurfaceDelivered(update.sessionId, update.id);
  }

  // ---------------------------------------------------------- conversation in

  private async handle(event: LiveServerEvent): Promise<void> {
    switch (event.type) {
      case 'transcript.user':
        this.userFragment += event.delta;
        return;
      case 'transcript.assistant':
        // The user starting to speak closes out their previous turn, which is
        // also the natural moment to let anything queued through.
        if (this.userFragment.trim()) {
          this.pushTurn('user', this.userFragment);
          this.userFragment = '';
          void this.flushQueued().catch((error) =>
            this.onError('live:flush', error),
          );
        }
        this.voFragment += event.delta;
        return;
      case 'delegation.created':
        if (this.userFragment.trim()) {
          this.pushTurn('user', this.userFragment);
          this.userFragment = '';
        }
        if (this.voFragment.trim()) {
          this.pushTurn('vo', this.voFragment);
          this.voFragment = '';
        }
        await this.investigate(event.delegationId);
        return;
      case 'session.closed':
        await this.stop();
        return;
      case 'error':
        this.onError('live:provider', new Error(event.message));
        return;
      case 'session.started':
        return;
    }
  }

  /**
   * Handle a delegated request.
   *
   * The provider tells us that the assistant wants backend help, but not what
   * the user said — by design, since the assistant is not the author of the
   * question. So the question is reconstructed from the transcript we have been
   * accumulating all along, which is why that buffer exists.
   */
  private async investigate(delegationId: string): Promise<void> {
    const attachment = this.attachment;
    if (!attachment?.sideband) return;

    const question = this.latestUserTurn();
    if (!question) {
      await attachment.sideband.appendThinking(
        'Vowe received a request for help but could not tell what was asked. Ask the user to repeat it.',
        delegationId,
      );
      return;
    }

    const result = await this.delegated.answer({
      sessionId: attachment.sessionId,
      question,
      liveConversation: this.transcript.slice(-this.transcriptTurns),
    });

    // Only the short form is spoken. The grounded account is already persisted
    // and rendered in Vowe's own window; reading it aloud would make the
    // conversation unusable and is never the right move.
    await attachment.sideband.appendCommentary(
      toLiveText(result.spokenAnswer),
      delegationId,
    );

    this.emit('answered', {
      sessionId: attachment.sessionId,
      question,
      spokenAnswer: result.spokenAnswer,
      fullAnswer: result.fullAnswer,
    });
  }

  private async flushQueued(): Promise<void> {
    if (!this.queued.length) return;
    const sideband = this.attachment?.sideband;
    if (!sideband) return;
    const pending = this.queued;
    this.queued = [];
    for (const update of pending) {
      await sideband.appendCommentary(toLiveText(update.message));
      await this.observation.markSurfaceDelivered(update.sessionId, update.id);
    }
  }

  /** The session's standing context, given once when the conversation opens. */
  private async primeSession(
    sessionId: string,
    sideband: LiveSideband,
  ): Promise<void> {
    const status = this.observation.status(sessionId);
    const parts = [
      status.catchingUp
        ? 'Vowe is still catching up on this session; some earlier work has not been read yet.'
        : 'Vowe is following this session live.',
    ];
    if (status.communicationPreference) {
      parts.push(
        `The user asked: "${status.communicationPreference}". Honour that.`,
      );
    }
    await sideband.appendThinking(toLiveText(parts.join(' ')));
  }

  private sidebandFor(sessionId: string): LiveSideband | null {
    if (!this.attachment || this.attachment.sessionId !== sessionId) return null;
    return this.attachment.sideband;
  }

  private pushTurn(speaker: 'user' | 'vo', text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.transcript.push({ speaker, text: trimmed });
    if (this.transcript.length > this.transcriptTurns * 2) {
      this.transcript = this.transcript.slice(-this.transcriptTurns);
    }
  }

  private latestUserTurn(): string | null {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const turn = this.transcript[i]!;
      if (turn.speaker === 'user') return turn.text;
    }
    return null;
  }
}

/**
 * The single chokepoint for text leaving Vowe for the voice provider.
 *
 * Two jobs. It enforces the provider's per-append ceiling — treated as an upper
 * bound, not a target, because spoken text should be much shorter than that
 * anyway. And it is the one place to look to answer "what does Vowe send to a
 * third party?": interpreted prose, and nothing else. Raw traces, file
 * contents, diffs and command output never reach this function, because no
 * caller passes them.
 */
export function toLiveText(text: string, maxTokens = LIVE_APPEND_TOKEN_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  // Same four-characters-per-token estimate used for windowing. Cutting a
  // little early is free; overshooting the provider's limit is not.
  const maxCharacters = maxTokens * 4 - 64;
  if (collapsed.length <= maxCharacters) return collapsed;
  return `${collapsed.slice(0, maxCharacters)}…`;
}

import { randomUUID } from 'node:crypto';

import OpenAI from 'openai';
import type { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';

import type {
  CreateLiveSessionOptions,
  CreatedLiveSession,
  LiveServerEvent,
  LiveSideband,
  LiveTransport,
  LiveVoice,
  Unsubscribe,
} from '@vowe/core';

export interface OpenAiLiveTransportOptions {
  apiKey?: string;
  /** The live model. */
  model?: string;
  voice?: string;
  /** Injectable for tests. */
  client?: OpenAI;
  onError?: (scope: string, error: unknown) => void;
}

const DEFAULT_MODEL = 'gpt-live-1';
const DEFAULT_VOICE = 'marin';

/**
 * The voices this provider documents for its live models.
 *
 * Vendor knowledge, and therefore in the vendor package. Listed rather than
 * discovered because the API exposes no enumeration endpoint; if the provider
 * retires one, sending it fails loudly at join time with the provider's own
 * message, which is better than a picker that silently offers nothing.
 */
const VOICES: readonly LiveVoice[] = [
  { id: 'marin', label: 'Marin' },
  { id: 'cedar', label: 'Cedar' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'ash', label: 'Ash' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'coral', label: 'Coral' },
  { id: 'echo', label: 'Echo' },
  { id: 'sage', label: 'Sage' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'verse', label: 'Verse' },
];

/**
 * The live voice provider, behind `LiveTransport`.
 *
 * Two connections to one conversation, which is the arrangement that makes the
 * whole design work:
 *
 *  - The **renderer** owns the audio. It holds the microphone and the speaker
 *    and negotiates a peer connection directly with the provider. Its SDP offer
 *    comes here only to be exchanged, because the exchange needs the API key
 *    and the key must never reach a browser context.
 *  - The **backend** attaches a second, server-side connection to the same
 *    session. That is how the observation harness reaches a conversation whose
 *    audio never passes through this process at all.
 *
 * The session is configured for client delegation: when the assistant decides a
 * question needs real work, it hands it to us rather than trying to answer from
 * what it has been told.
 */
export class OpenAiLiveTransport implements LiveTransport {
  readonly name = 'openai-live';
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly voices: readonly LiveVoice[] = VOICES;

  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly voice: string;

  /**
   * The developer's choice, when it is one this provider actually offers.
   *
   * An unrecognised id falls back to the configured default rather than being
   * forwarded: a stale stored preference should not cost someone their call.
   */
  private voiceFor(requested: string | undefined): string {
    const id = requested?.trim();
    if (!id) return this.voice;
    return VOICES.some((voice) => voice.id === id) ? id : this.voice;
  }
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: OpenAiLiveTransportOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.VOWE_LIVE_MODEL ?? DEFAULT_MODEL;
    this.voice = options.voice ?? process.env.VOWE_LIVE_VOICE ?? DEFAULT_VOICE;
    this.onError = options.onError ?? (() => undefined);

    if (options.client) {
      this.client = options.client;
    } else if (apiKey) {
      this.client = new OpenAI({ apiKey });
    } else {
      this.client = null;
    }

    this.available = this.client !== null;
    this.unavailableReason = this.available
      ? null
      : 'No OPENAI_API_KEY is configured, so Vo cannot join by voice. Observation is unaffected.';
  }

  async createSession(
    options: CreateLiveSessionOptions,
  ): Promise<CreatedLiveSession> {
    const client = this.requireClient();
    const created = await client.live.create({
      session: {
        model: this.model,
        instructions: options.instructions,
        audio: { output: { voice: this.voiceFor(options.voice) } },
        // The assistant hands technical questions to Vowe rather than
        // answering them itself. See DelegatedQuestionRunner.
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: options.sdpOffer },
    });

    return {
      liveSessionId: created.session.id,
      sdpAnswer: created.transport.sdp,
      model: this.model,
    };
  }

  async attachSideband(liveSessionId: string): Promise<LiveSideband | null> {
    const client = this.requireClient();
    try {
      // Imported lazily. The SDK's sideband socket depends on `ws`, which is an
      // optional peer dependency, and a module-level import would make a
      // missing optional dependency crash the whole application at load — for a
      // feature that is supposed to degrade quietly when it is unavailable.
      const { SidebandWS } = await import('openai/resources/live/sideband/ws');
      const socket = new SidebandWS(client, { session_id: liveSessionId });
      return new OpenAiSideband(liveSessionId, socket, this.onError);
    } catch (error) {
      // A conversation we cannot observe is degraded, not broken. The user can
      // still talk to Vo; they just will not get proactive updates.
      this.onError('live:attach', error);
      return null;
    }
  }

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new Error(this.unavailableReason ?? 'Voice is not configured.');
    }
    return this.client;
  }
}

/**
 * The server-side half of one conversation.
 *
 * Translates between Vowe's small normalized event set and the provider's much
 * larger one. Events nothing consumes are dropped here rather than modelled
 * upstream — the bridge should only have to know about things it acts on.
 */
class OpenAiSideband implements LiveSideband {
  readonly liveSessionId: string;
  private readonly socket: SidebandWS;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly listeners = new Set<(event: LiveServerEvent) => void>();

  constructor(
    liveSessionId: string,
    socket: SidebandWS,
    onError: (scope: string, error: unknown) => void,
  ) {
    this.liveSessionId = liveSessionId;
    this.socket = socket;
    this.onError = onError;

    this.socket.on('event', (event: ConnectServerEvent) => {
      const normalized = normalize(event);
      if (!normalized) return;
      for (const listener of this.listeners) {
        try {
          listener(normalized);
        } catch (error) {
          this.onError('live:listener', error);
        }
      }
    });

    this.socket.on('error', (error) => this.onError('live:socket', error));
  }

  on(listener: (event: LiveServerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Silent context: the assistant knows it, and will not say it on arrival. */
  async appendThinking(content: string, delegationId: string | null = null): Promise<void> {
    this.socket.send({
      type: 'session.thinking.append',
      event_id: randomUUID(),
      delegation_id: delegationId,
      content,
    });
  }

  /** Speakable context: the assistant should communicate this, in its words. */
  async appendCommentary(content: string, delegationId: string | null = null): Promise<void> {
    this.socket.send({
      type: 'session.commentary.append',
      event_id: randomUUID(),
      delegation_id: delegationId,
      content,
    });
  }

  async appendInstructions(content: string): Promise<void> {
    this.socket.send({
      type: 'session.instructions.append',
      event_id: randomUUID(),
      delegation_id: null,
      content,
    });
  }

  async close(): Promise<void> {
    this.listeners.clear();
    try {
      this.socket.send({ type: 'session.close', event_id: randomUUID() });
    } catch (error) {
      this.onError('live:close-send', error);
    }
    try {
      this.socket.close();
    } catch (error) {
      this.onError('live:close', error);
    }
  }
}

/** Provider event -> the small set Vowe actually acts on, or `null` to drop. */
function normalize(event: ConnectServerEvent): LiveServerEvent | null {
  switch (event.type) {
    case 'session.started':
      return { type: 'session.started' };
    case 'session.closed':
      return { type: 'session.closed', reason: event.reason };
    case 'session.delegation.created':
      return { type: 'delegation.created', delegationId: event.delegation.id };
    case 'session.input_transcript.delta':
      return {
        type: 'transcript.user',
        delta: event.delta,
        startMs: event.start_ms,
        endMs: event.end_ms,
      };
    case 'session.output_transcript.delta':
      return {
        type: 'transcript.assistant',
        delta: event.delta,
        startMs: event.start_ms,
        endMs: event.end_ms,
      };
    case 'error':
      return { type: 'error', message: `${event.error.code}: ${event.error.message}` };
    default:
      // Acknowledgements, usage updates, muting, response events: real, but
      // nothing here acts on them.
      return null;
  }
}

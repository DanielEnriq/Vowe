import type { Unsubscribe } from '../types/adapter.js';

/**
 * The boundary between Vowe and a live voice provider.
 *
 * Everything vendor-specific — endpoints, SDK types, event wire names, audio
 * formats — stays behind this interface, for the same reason `AgentAdapter`
 * exists: the rest of the application should be able to describe what it wants
 * said without knowing who is saying it.
 */
export interface LiveTransport {
  readonly name: string;
  /** False when no credential is configured. The app must still run. */
  readonly available: boolean;
  /** Why voice is unavailable, in words a person can act on. */
  readonly unavailableReason: string | null;

  /**
   * Exchange the renderer's SDP offer for an answer.
   *
   * This runs in the main process precisely so the credential never reaches the
   * renderer: the browser side owns the microphone and the audio, and nothing
   * else.
   */
  createSession(options: CreateLiveSessionOptions): Promise<CreatedLiveSession>;

  /**
   * Attach a second, server-side connection to a session the renderer owns.
   *
   * This is how the observation harness reaches a conversation whose audio is
   * flowing directly between the user's machine and the provider. Returning
   * `null` means the session is usable but unobservable from the backend, which
   * is a degraded mode, not a failure.
   */
  attachSideband(liveSessionId: string): Promise<LiveSideband | null>;
}

export interface CreateLiveSessionOptions {
  sdpOffer: string;
  /** Vo's standing instructions. Immutable once the session starts. */
  instructions: string;
}

export interface CreatedLiveSession {
  liveSessionId: string;
  sdpAnswer: string;
}

/**
 * The server-side half of a live conversation.
 *
 * Three ways to put text in, and they are genuinely different things:
 *
 *  - `appendThinking` — the assistant now knows this. It will not say it, but
 *    it can use it when asked. This is where quiet observation goes.
 *  - `appendCommentary` — the assistant should communicate this, in its own
 *    words. This is where an approved interruption goes.
 *  - `appendInstructions` — change how the assistant behaves.
 */
export interface LiveSideband {
  readonly liveSessionId: string;
  on(listener: (event: LiveServerEvent) => void): Unsubscribe;
  appendThinking(content: string, delegationId?: string | null): Promise<void>;
  appendCommentary(content: string, delegationId?: string | null): Promise<void>;
  appendInstructions(content: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The provider events the bridge acts on, normalized.
 *
 * Only what Vowe actually uses is modelled. A provider will emit far more; the
 * transport is free to drop the rest rather than force a translation for
 * events nothing consumes.
 */
export type LiveServerEvent =
  | { type: 'session.started' }
  | { type: 'session.closed'; reason: string }
  /** The assistant has decided the backend should handle something. */
  | { type: 'delegation.created'; delegationId: string }
  /** Transcript fragments. Not turns — fragments, which may interleave. */
  | { type: 'transcript.user'; delta: string; startMs: number; endMs: number }
  | { type: 'transcript.assistant'; delta: string; startMs: number; endMs: number }
  | { type: 'error'; message: string };

/**
 * The transport used when no voice credential is configured.
 *
 * Observation does not depend on voice, so the absence of a key is an ordinary
 * state with an honest answer, not a startup failure.
 */
export class UnavailableLiveTransport implements LiveTransport {
  readonly name = 'unavailable';
  readonly available = false;
  readonly unavailableReason: string;

  constructor(reason = 'No voice credential is configured.') {
    this.unavailableReason = reason;
  }

  async createSession(): Promise<CreatedLiveSession> {
    throw new Error(this.unavailableReason);
  }

  async attachSideband(): Promise<LiveSideband | null> {
    return null;
  }
}

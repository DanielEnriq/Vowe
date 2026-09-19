import type {
  CreateLiveSessionOptions,
  CreatedLiveSession,
  LiveServerEvent,
  LiveSideband,
  LiveTransport,
} from '../src/live/live-transport.js';
import type { Unsubscribe } from '../src/types/adapter.js';

export interface Appended {
  channel: 'thinking' | 'commentary' | 'instructions';
  content: string;
  delegationId: string | null;
}

/**
 * A live provider that records instead of speaking.
 *
 * The distinction the bridge exists to maintain — silent context versus
 * something said out loud — is only visible in *which* channel a message went
 * to. So the fake records the channel, and the tests assert on it.
 */
export class FakeLiveSideband implements LiveSideband {
  readonly appended: Appended[] = [];
  closed = false;
  private readonly listeners = new Set<(event: LiveServerEvent) => void>();

  constructor(readonly liveSessionId: string) {}

  on(listener: (event: LiveServerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drive the conversation from a test. */
  emit(event: LiveServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Say something as the user, as a stream of fragments would. */
  userSays(text: string): void {
    this.emit({ type: 'transcript.user', delta: text, startMs: 0, endMs: 1 });
  }

  async appendThinking(content: string, delegationId: string | null = null): Promise<void> {
    this.appended.push({ channel: 'thinking', content, delegationId });
  }

  async appendCommentary(content: string, delegationId: string | null = null): Promise<void> {
    this.appended.push({ channel: 'commentary', content, delegationId });
  }

  async appendInstructions(content: string): Promise<void> {
    this.appended.push({ channel: 'instructions', content, delegationId: null });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  spoken(): string[] {
    return this.appended
      .filter((entry) => entry.channel === 'commentary')
      .map((entry) => entry.content);
  }

  silent(): string[] {
    return this.appended
      .filter((entry) => entry.channel === 'thinking')
      .map((entry) => entry.content);
  }
}

export class FakeLiveTransport implements LiveTransport {
  readonly name = 'fake';
  readonly unavailableReason: string | null;
  sideband: FakeLiveSideband | null = null;
  lastInstructions: string | null = null;

  constructor(
    readonly available = true,
    /** Simulates a provider that connects but refuses a backend attach. */
    private readonly allowSideband = true,
  ) {
    this.unavailableReason = available ? null : 'No voice credential is configured.';
  }

  async createSession(options: CreateLiveSessionOptions): Promise<CreatedLiveSession> {
    if (!this.available) throw new Error(this.unavailableReason!);
    this.lastInstructions = options.instructions;
    return { liveSessionId: 'live_fake', sdpAnswer: `answer-for:${options.sdpOffer}` };
  }

  async attachSideband(liveSessionId: string): Promise<LiveSideband | null> {
    if (!this.allowSideband) return null;
    this.sideband = new FakeLiveSideband(liveSessionId);
    return this.sideband;
  }
}

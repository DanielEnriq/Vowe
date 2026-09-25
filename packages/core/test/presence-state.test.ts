import { describe, expect, it } from 'vitest';

import { resolvePresenceState, type PresenceSignals } from '../src/index.js';

/** Nothing happening: Vowe has a model, and that is all. */
function quiet(overrides: Partial<PresenceSignals> = {}): PresenceSignals {
  return {
    voweAvailable: true,
    liveJoining: false,
    liveConnected: false,
    liveMuted: false,
    livePlaybackActive: false,
    needsAttention: false,
    investigating: false,
    following: false,
    ...overrides,
  };
}

describe('Presence state — what Vowe is doing', () => {
  it('is idle when nothing is happening', () => {
    expect(resolvePresenceState(quiet())).toBe('idle');
  });

  it('is observing while Vowe follows work', () => {
    expect(resolvePresenceState(quiet({ following: true }))).toBe('observing');
  });

  it('is thinking while Vowe runs something of its own', () => {
    expect(resolvePresenceState(quiet({ investigating: true }))).toBe('thinking');
  });

  /**
   * The distinction the product turns on. A coding worker running flat out
   * while Vowe watches is Vowe *observing* — Vowe is not the one thinking, and
   * a presence that claimed otherwise would take credit for the worker's work.
   */
  it('is observing, not thinking, when only the worker is busy', () => {
    expect(resolvePresenceState(quiet({ following: true, investigating: false }))).toBe(
      'observing',
    );
  });

  it('is thinking rather than observing when both are true', () => {
    expect(resolvePresenceState(quiet({ following: true, investigating: true }))).toBe(
      'thinking',
    );
  });

  it('is attention when something genuinely needs the developer', () => {
    expect(resolvePresenceState(quiet({ needsAttention: true, following: true }))).toBe(
      'attention',
    );
  });
});

describe('Presence state — voice', () => {
  it('is joining before the call is up', () => {
    expect(resolvePresenceState(quiet({ liveJoining: true }))).toBe('joining');
  });

  it('shows a delegated investigation while the microphone remains live', () => {
    expect(resolvePresenceState(quiet({ liveConnected: true, investigating: true }))).toBe('thinking');
    expect(resolvePresenceState(quiet({ liveConnected: true, investigating: true, livePlaybackActive: true }))).toBe('speaking');
  });

  it('is listening on a connected call' , () => {
    expect(resolvePresenceState(quiet({ liveConnected: true }))).toBe('listening');
  });

  it('is not listening while the microphone is off', () => {
    expect(resolvePresenceState(quiet({ liveConnected: true, liveMuted: true }))).toBe('idle');
  });

  it('is speaking while Vowe’s own audio is playing', () => {
    expect(
      resolvePresenceState(quiet({ liveConnected: true, livePlaybackActive: true })),
    ).toBe('speaking');
  });

  /** Playback without a call is stale evidence, not a presence that speaks. */
  it('does not speak when there is no call', () => {
    expect(resolvePresenceState(quiet({ livePlaybackActive: true }))).toBe('idle');
  });

  /**
   * During a conversation the presence belongs to the person talking. Needs You
   * is still on screen where it always is, so nothing is hidden by this.
   */
  it('keeps the call over attention', () => {
    expect(
      resolvePresenceState(quiet({ liveConnected: true, needsAttention: true })),
    ).toBe('listening');
  });
});

describe('Presence state — unavailability', () => {
  it('outranks everything, because a busy-looking blind presence is a lie', () => {
    expect(
      resolvePresenceState({
        voweAvailable: false,
        liveJoining: true,
        liveConnected: true,
        liveMuted: false,
        livePlaybackActive: true,
        needsAttention: true,
        investigating: true,
        following: true,
      }),
    ).toBe('unavailable');
  });
});

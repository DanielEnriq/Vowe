/**
 * What Vowe is doing, as one word.
 *
 * Presence is the only part of the product that speaks for the whole of Vowe
 * at once, so the state it shows is resolved in one place from signals the
 * application already has. The renderer draws a posture; it never asks a
 * service what is happening.
 *
 * These are product states, not animation presets. Two of them are easy to
 * confuse and must not be: a coding worker running while Vowe follows it is
 * `observing`, and only Vowe's own investigation is `thinking`.
 */

export type PresenceState =
  | 'idle'
  | 'observing'
  | 'joining'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'attention'
  | 'unavailable';

export const PRESENCE_STATES: readonly PresenceState[] = [
  'idle',
  'observing',
  'joining',
  'listening',
  'thinking',
  'speaking',
  'attention',
  'unavailable',
];

/** Where the same presence is drawn. Size, not identity. */
export type PresenceSize = 'signature' | 'compact' | 'project' | 'voice' | 'studio';

export const PRESENCE_SIZES: readonly PresenceSize[] = [
  'signature',
  'compact',
  'project',
  'voice',
  'studio',
];

/**
 * The runtime truth presence is resolved from.
 *
 * Flat booleans rather than the services themselves: every field here is
 * something the application already knows, and a field nothing can yet produce
 * has no business being in the list. Resolution is pure, so it is decided once
 * and testable without a window.
 */
export interface PresenceSignals {
  /** False when Vowe has no model at all — it cannot think, so it says so. */
  voweAvailable: boolean;
  /** A voice session is being established. */
  liveJoining: boolean;
  /** A voice session is up. */
  liveConnected: boolean;
  /** The microphone is off, so a connected call is not being listened to. */
  liveMuted: boolean;
  /** Vowe's own audio is actually playing, as measured where it is played. */
  livePlaybackActive: boolean;
  /** Something in the work genuinely needs the developer. */
  needsAttention: boolean;
  /** Vowe is running a model on the developer's question. */
  investigating: boolean;
  /** Vowe is following work: observing a session, or interpreting a window. */
  following: boolean;
}

/**
 * One posture from many true things at once.
 *
 * The order is a product judgement, not a convenience. Unavailability outranks
 * everything because a presence that looks busy while it cannot see anything is
 * a lie. A live call outranks attention — the same choice the approved design
 * makes — because during a conversation the presence belongs to the person
 * talking, and Needs You is still on screen where it always was.
 */
export function resolvePresenceState(signals: PresenceSignals): PresenceState {
  if (!signals.voweAvailable) return 'unavailable';
  if (signals.liveConnected && signals.livePlaybackActive) return 'speaking';
  if (signals.liveConnected && signals.investigating) return 'thinking';
  if (signals.liveConnected && !signals.liveMuted) return 'listening';
  if (signals.liveJoining) return 'joining';
  if (signals.needsAttention) return 'attention';
  if (signals.investigating) return 'thinking';
  if (signals.following) return 'observing';
  return 'idle';
}

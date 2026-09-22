import type { SurfaceUrgency } from '../observation/trace-window.js';

/**
 * How Vowe behaves, as distinct from how Vowe looks.
 *
 * Deliberately not part of `PresenceProfile`: changing the material must never
 * change how much Vowe interrupts, and the approved design says so in as many
 * words. Appearance and temperament are stored, edited and reasoned about
 * separately.
 *
 * Every field here reaches real runtime behaviour. `proactive` moves which
 * candidates `CommunicationPolicy` is willing to speak; `exploratory` and
 * `casual` are composed into the prompts Vowe actually runs. A dial that
 * changed nothing would be a lie told with a slider, so there is no room here
 * for one.
 */
export interface TemperamentProfile {
  /** `0` quiet … `1` proactive. Governs interruption, not verbosity. */
  proactive: number;
  /** `0` concise … `1` exploratory. Governs how much Vowe volunteers. */
  exploratory: number;
  /** `0` professional … `1` casual. Governs register, never content. */
  casual: number;
  /**
   * The developer's own words about being interrupted.
   *
   * The global default for the per-session communication preference: a session
   * that states its own preference overrides this, and one that does not
   * inherits it. Free text because this is the developer talking, not a
   * setting — the same reason `ObservationState.communicationPreference` is
   * free text.
   */
  personalInstruction?: string;
}

/** The design's own resting positions for the three dials. */
export const DEFAULT_TEMPERAMENT: TemperamentProfile = {
  proactive: 0.3,
  exploratory: 0.35,
  casual: 0.25,
};

/**
 * Long enough to say something real, short enough to sit in a prompt.
 *
 * This text is composed into Vo's standing instructions, which the live
 * transport caps at 500 tokens for the whole append — so an unbounded field
 * here would silently push other, load-bearing context out.
 */
export const MAX_PERSONAL_INSTRUCTION = 400;

export function normalizeTemperament(value: unknown): TemperamentProfile {
  const source = (value ?? {}) as Record<string, unknown>;

  const profile: TemperamentProfile = {
    proactive: dial(source['proactive'], DEFAULT_TEMPERAMENT.proactive),
    exploratory: dial(source['exploratory'], DEFAULT_TEMPERAMENT.exploratory),
    casual: dial(source['casual'], DEFAULT_TEMPERAMENT.casual),
  };

  const instruction =
    typeof source['personalInstruction'] === 'string'
      ? source['personalInstruction'].replace(/\s+/g, ' ').trim().slice(0, MAX_PERSONAL_INSTRUCTION)
      : '';
  if (instruction) profile.personalInstruction = instruction;

  return profile;
}

function dial(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export type TemperamentBand = 'low' | 'middle' | 'high';

/** Thirds. Three bands is what the three-word prose below can carry honestly. */
export function bandOf(value: number): TemperamentBand {
  if (value < 1 / 3) return 'low';
  if (value < 2 / 3) return 'middle';
  return 'high';
}

const SPEAK_FLOOR: Record<TemperamentBand, SurfaceUrgency> = {
  low: 'high',
  middle: 'normal',
  high: 'low',
};

/**
 * The least urgent thing Vowe will interrupt for.
 *
 * This is the mechanism that makes Quiet↔Proactive real rather than
 * decorative. At the quiet end only a candidate the observer marked urgent may
 * be spoken; everything else the model approved is held until the developer
 * next speaks. At the proactive end nothing is held back.
 *
 * It only ever demotes. Promoting something a model declined to speak would be
 * the UI overruling the decision, and erring quiet is the house rule.
 */
export function speakFloor(temperament: TemperamentProfile): SurfaceUrgency {
  return SPEAK_FLOOR[bandOf(temperament.proactive)];
}

const URGENCY_RANK: Record<SurfaceUrgency, number> = { low: 0, normal: 1, high: 2 };

export function meetsSpeakFloor(
  urgency: SurfaceUrgency,
  temperament: TemperamentProfile,
): boolean {
  return (URGENCY_RANK[urgency] ?? 0) >= URGENCY_RANK[speakFloor(temperament)];
}

/**
 * What the decision model is told about this developer's appetite.
 *
 * Kept separate from their own words so that a decision's `reason` can quote
 * the developer and never this. One is a person talking; the other is a
 * setting being described.
 */
export function interruptionAppetite(temperament: TemperamentProfile): string {
  switch (bandOf(temperament.proactive)) {
    case 'low':
      return 'They have asked to be left alone unless something genuinely needs them.';
    case 'middle':
      return 'They want the developments that matter and not the rest.';
    case 'high':
      return 'They have asked to be kept closely informed as work proceeds.';
  }
}

/**
 * Register and length, for the prompts Vowe runs.
 *
 * Composed rather than tabulated as nine strings so that each axis is visibly
 * independent: changing one sentence cannot change the other.
 */
export function temperamentGuidance(temperament: TemperamentProfile): string {
  const lines = [LENGTH[bandOf(temperament.exploratory)], REGISTER[bandOf(temperament.casual)]];
  const instruction = temperament.personalInstruction;
  if (instruction) lines.push(`They have also said: "${instruction}"`);
  return lines.join(' ');
}

const LENGTH: Record<TemperamentBand, string> = {
  low: 'Answer in as few words as the question honestly takes; do not volunteer adjacent detail.',
  middle: 'Answer the question, and add context only where it changes what they should do.',
  high: 'Answer the question and then say what you noticed around it that they would want to know.',
};

const REGISTER: Record<TemperamentBand, string> = {
  low: 'Keep the register professional and plain.',
  middle: 'Keep the register relaxed but precise.',
  high: 'Talk like a colleague at the next desk; stay accurate.',
};

/**
 * One preference, from two places, with the session winning.
 *
 * A developer who said something about *this* session meant it about this
 * session. The global instruction is what applies when they have not.
 */
export function effectivePreference(
  temperament: TemperamentProfile,
  sessionPreference: string | null | undefined,
): string | null {
  const session = typeof sessionPreference === 'string' ? sessionPreference.trim() : '';
  if (session) return session;
  return temperament.personalInstruction ?? null;
}

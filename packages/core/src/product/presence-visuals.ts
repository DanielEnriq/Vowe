import {
  DEFAULT_PRESENCE_PROFILE,
  NEUTRAL_LIGHT_RESPONSE,
  type PresenceMaterial,
  type PresenceMotion,
  type PresenceProfile,
} from './presence-profile.js';
import type { PresenceSize, PresenceState } from './presence-state.js';

/**
 * Every visible quantity of Vowe's presence, as plain numbers.
 *
 * The renderer owns WebGL; this owns what WebGL is told. Keeping the parameter
 * set here rather than in the shader wrapper is what makes the appearance
 * testable at all: "does every state resolve to something drawable, and are two
 * states still different once colour is removed?" is a question about this
 * file, answered without a canvas.
 *
 * States, materials and motions are presets over one parameter set rather than
 * separate animations, so a state change is an interpolation between two
 * postures of one object and never a different object.
 */
export interface PresenceVisuals {
  /** Displacement depth of the noise shell. */
  amp: number;
  /** Spatial frequency of the noise. Higher reads as finer, busier detail. */
  freq: number;
  /** How fast the field's own clock advances. */
  speed: number;
  /** Shear around the vertical axis. */
  torsion: number;
  /** Per-point radial scatter, which thickens the shell into a cloud. */
  jitter: number;
  /** Point sprite size multiplier. */
  size: number;
  /** Shading gain. */
  bright: number;
  /** Fresnel rim response. */
  rim: number;
  /** Strength of the surrounding ring. 0 draws nothing at all. */
  halo: number;
  /** How much of `activity` reaches the displacement. */
  pulse: number;
  /** Warm tint on the rim. Reserved for attention. */
  warm: number;
  /** How strongly the point rows read as lines rather than a scatter. */
  lineBias: number;
  /** Point opacity, from the material. */
  opacity: number;
  /** Colour gain, from the material. */
  gain: number;
  /** Hue travel across the surface, from the material. */
  irid: number;
  /** Lit colour, `#rrggbb`. Overridden by the profile accent. */
  colorA: string;
  /** Shadow colour, `#rrggbb`. Overridden by the profile body accent. */
  colorB: string;
  /** Rotational drift multiplier. */
  spin: number;
  /** Point-count multiplier for this size. */
  density: number;
  /** Overall scale of the point sprites for this size. */
  scale: number;
  /**
   * Whether these numbers are for a light page.
   *
   * Not a material and not a second palette: the developer's material, accent
   * and motion are exactly what they chose in either appearance. What changes
   * is the *illumination* — on a dark page the presence adds its light to the
   * surface it sits on, and on a light one it cannot, because nothing is
   * brighter than paper. So the renderer composites it normally instead and
   * the same object reads as a lit body seen against the page rather than as
   * a glow. The two contrast inputs below are resolved from this here, so the
   * shader is told numbers and never asked which theme it is in.
   */
  onLight: boolean;
  /**
   * Frames per second the renderer should not exceed.
   *
   * A signature in the corner of a window that is open all day does not need
   * sixty frames a second, and measured on a laptop it costs about twice what
   * thirty does. The large sizes, which someone is actually looking at, get
   * the full rate.
   */
  maxFps: number;
}

/** The parameters that carry state. Colour is deliberately not among them. */
export type PresencePosture = Omit<
  PresenceVisuals,
  'colorA' | 'colorB' | 'opacity' | 'gain' | 'irid' | 'density' | 'scale' | 'maxFps' | 'onLight'
>;

interface StatePreset {
  amp: number;
  freq: number;
  speed: number;
  torsion: number;
  jitter: number;
  size: number;
  bright: number;
  rim: number;
  halo: number;
  pulse: number;
  warm: number;
}

/**
 * Ported from the approved design, preset for preset.
 *
 * Each one is a posture of the same object. What separates them is motion,
 * deformation, rhythm and density — never colour alone — because appearance is
 * the developer's to change and a state that only differed by hue would stop
 * being legible the moment they changed it.
 *
 * `joining` has no counterpart in the design and is defined here: quicker than
 * observing and already reaching for the halo listening will hold, but without
 * listening's steadiness, because the call is not up yet.
 */
const STATES: Record<PresenceState, StatePreset> = {
  idle:        { amp: 0.055, freq: 1.5, speed: 0.22, torsion: 0.000, jitter: 0.15, size: 1.00, bright: 0.85, rim: 0.85, halo: 0.00, pulse: 0.00, warm: 0.0 },
  observing:   { amp: 0.085, freq: 1.9, speed: 0.45, torsion: 0.010, jitter: 0.18, size: 1.00, bright: 0.95, rim: 1.00, halo: 0.10, pulse: 0.01, warm: 0.0 },
  joining:     { amp: 0.075, freq: 2.1, speed: 0.85, torsion: 0.005, jitter: 0.22, size: 1.02, bright: 0.90, rim: 1.05, halo: 0.18, pulse: 0.02, warm: 0.0 },
  listening:   { amp: 0.070, freq: 2.5, speed: 0.70, torsion: 0.000, jitter: 0.12, size: 1.12, bright: 1.05, rim: 1.15, halo: 0.55, pulse: 0.05, warm: 0.0 },
  thinking:    { amp: 0.165, freq: 3.4, speed: 1.05, torsion: 0.075, jitter: 0.30, size: 0.92, bright: 0.95, rim: 1.10, halo: 0.12, pulse: 0.07, warm: 0.0 },
  speaking:    { amp: 0.125, freq: 2.0, speed: 0.95, torsion: 0.020, jitter: 0.16, size: 1.08, bright: 1.15, rim: 1.05, halo: 0.28, pulse: 0.09, warm: 0.0 },
  attention:   { amp: 0.105, freq: 5.6, speed: 1.45, torsion: 0.030, jitter: 0.45, size: 0.86, bright: 1.05, rim: 1.25, halo: 0.34, pulse: 0.03, warm: 0.7 },
  unavailable: { amp: 0.020, freq: 1.2, speed: 0.05, torsion: 0.000, jitter: 0.08, size: 0.88, bright: 0.34, rim: 0.40, halo: 0.00, pulse: 0.00, warm: 0.0 },
};

/**
 * The one implemented form.
 *
 * `PresenceForm` is extensible and currently single-valued, so this is a table
 * of one rather than a constant: a second form changes this file and nothing
 * else. These are the design's `liquid` coefficients, which is what the
 * approved point cloud actually is.
 */
const FORM = {
  ampK: 1.0,
  freqK: 1.0,
  torsionK: 1.0,
  jitterK: 1.0,
  sizeK: 1.0,
  lineBias: 0.55,
} as const;

interface MaterialPreset {
  colorA: string;
  colorB: string;
  gain: number;
  opacity: number;
  irid: number;
}

/**
 * All eight the design offers, taken from its own swatch gradients.
 *
 * A material is a preset over one parameter set, not a renderer — which is why
 * the design's full set ships while its extra *forms* do not. `irid` is what
 * separates the two that would otherwise be close: iridescent travels hue
 * across the surface, pearl only warms it.
 */
const MATERIALS: Record<PresenceMaterial, MaterialPreset> = {
  chrome:     { colorA: '#ffffff', colorB: '#464b52', gain: 1.1,  opacity: 0.9,  irid: 0.02 },
  silver:     { colorA: '#f3f7ff', colorB: '#6e7a87', gain: 1.05, opacity: 0.88, irid: 0.05 },
  obsidian:   { colorA: '#a3aab6', colorB: '#13151a', gain: 1.15, opacity: 0.95, irid: 0.0 },
  frost:      { colorA: '#eef6ff', colorB: '#5c7080', gain: 0.95, opacity: 0.8,  irid: 0.1 },
  iridescent: { colorA: '#ffd6f0', colorB: '#6f5fa8', gain: 1.1,  opacity: 0.86, irid: 0.75 },
  matrix:     { colorA: '#b9ffd4', colorB: '#0d1712', gain: 1.2,  opacity: 0.92, irid: 0.0 },
  plasma:     { colorA: '#d3e2ff', colorB: '#3a2a6d', gain: 1.15, opacity: 0.86, irid: 0.35 },
  pearl:      { colorA: '#fff4e8', colorB: '#8d7f9c', gain: 1.0,  opacity: 0.9,  irid: 0.28 },
};

/** Temperament of the motion, not its meaning. State still decides that. */
const MOTIONS: Record<PresenceMotion, number> = {
  calm: 0.55,
  fluid: 1.0,
  reactive: 1.45,
  energetic: 1.9,
};

/**
 * What `lightResponse` does to shading, at the ends of its range.
 *
 * Narrow on purpose. The dial is meant to change how hard the surface reads,
 * not to be able to extinguish the presence or blow it out — an appearance
 * control that can make Vowe invisible is a way to lose it, not to own it.
 */
const LIGHT_FLOOR = 0.7;
const LIGHT_CEILING = 1.3;

interface SizePreset {
  /** Multiplies the point grid. Small presences stay dense, not sparse. */
  density: number;
  scale: number;
  maxFps: number;
  /**
   * How much of the state's ring this size draws.
   *
   * A ring reads as a halo at 26px and as a drawn circle at 300px, where it
   * competes with the sphere it is supposed to surround rather than framing it.
   * The large voice presence therefore draws none: the deformation is the
   * signal there, and the object is strong enough without an outline.
   */
  halo: number;
}

/**
 * Detail by size, taken from how the design uses the orb in each slot.
 *
 * Density falls with size because a 26px presence cannot show 15,000 points —
 * but it falls far less than area does, so the signature still reads as the
 * same dense cloud rather than a handful of dots.
 */
const SIZES: Record<PresenceSize, SizePreset> = {
  signature: { density: 0.42, scale: 0.9, maxFps: 30, halo: 1 },
  compact: { density: 0.5, scale: 0.95, maxFps: 30, halo: 1 },
  project: { density: 1.0, scale: 1.0, maxFps: 60, halo: 1 },
  voice: { density: 1.0, scale: 1.0, maxFps: 60, halo: 0 },
  studio: { density: 1.0, scale: 1.0, maxFps: 60, halo: 1 },
};

export interface PresenceVisualOptions {
  /**
   * The presence is being drawn on a light surface.
   *
   * The appearance of the *application*, not of Vowe. Absent means dark,
   * which is what every caller meant before there was a light one.
   */
  onLight?: boolean | undefined;
  /**
   * Real, normalized activity, if the application has any.
   *
   * Speech energy during a call, and the rhythm of actual execution events
   * while Vowe is thinking. Undefined means nobody measured it. The presence
   * then moves on its state alone rather than inventing a waveform.
   */
  activity?: number | undefined;
  /** The developer asked the system for less movement. */
  reducedMotion?: boolean | undefined;
}

/**
 * What a light page does to the two contrast inputs.
 *
 * Deliberately small. Enough that a chrome sphere reads as chrome on paper
 * rather than as a pale smudge, and not so much that it becomes a different,
 * darker material than the one the developer picked.
 */
const ON_LIGHT_OPACITY = 1.08;
const ON_LIGHT_GAIN = 0.72;

/** Reduced motion is also less work: half the frames, none of the meaning. */
const REDUCED_FPS = 30;

/** How much of the ordinary motion survives `prefers-reduced-motion`. */
const REDUCED_SPEED = 0.25;
const REDUCED_PULSE = 0.3;
const REDUCED_SPIN = 0.15;

/**
 * State and profile in, drawable numbers out. Pure and total.
 *
 * Reduced motion damps speed, pulse and drift and leaves the posture alone —
 * amplitude, frequency, torsion, jitter and size all still differ per state, so
 * a developer who asked for less movement still gets a presence that is
 * recognisably a point cloud and still tells them what Vowe is doing.
 */
export function resolvePresenceVisuals(
  state: PresenceState,
  profile: PresenceProfile,
  size: PresenceSize,
  options: PresenceVisualOptions = {},
): PresenceVisuals {
  const preset = STATES[state] ?? STATES.idle;
  const material = MATERIALS[profile.material] ?? MATERIALS[DEFAULT_PRESENCE_PROFILE.material];
  const motion = MOTIONS[profile.motion] ?? MOTIONS[DEFAULT_PRESENCE_PROFILE.motion];
  const dimensions = SIZES[size] ?? SIZES.project;
  const reduced = options.reducedMotion === true;
  const light = lightGain(profile.lightResponse);
  const onLight = options.onLight === true;

  return {
    amp: preset.amp * FORM.ampK,
    freq: preset.freq * FORM.freqK,
    speed: preset.speed * motion * (reduced ? REDUCED_SPEED : 1),
    torsion: preset.torsion * FORM.torsionK,
    jitter: preset.jitter * FORM.jitterK,
    size: preset.size * FORM.sizeK,
    bright: preset.bright * light,
    rim: preset.rim * light,
    /*
     * No ring on paper. The halo is light added around the object, which a
     * light page cannot show — it would cost a pass to draw nothing, and the
     * one thing it could do, wash the area pale, is the glow the light
     * appearance is meant not to have.
     */
    halo: onLight ? 0 : preset.halo * dimensions.halo,
    pulse: preset.pulse * (reduced ? REDUCED_PULSE : 1),
    warm: preset.warm,
    lineBias: FORM.lineBias,
    /*
     * Composited rather than added, the cloud needs to be read against a
     * bright surface instead of on top of a dark one: a little more ink per
     * point, and the material's gain pulled below one so its lit side stays a
     * tone rather than blowing out to the colour of the page.
     */
    opacity: onLight ? Math.min(1, material.opacity * ON_LIGHT_OPACITY) : material.opacity,
    gain: onLight ? material.gain * ON_LIGHT_GAIN : material.gain,
    irid: material.irid,
    colorA: normalizeAccent(profile.accent) ?? material.colorA,
    colorB: normalizeAccent(profile.bodyAccent) ?? material.colorB,
    spin: (reduced ? REDUCED_SPIN : 1) * motion,
    density: dimensions.density,
    scale: dimensions.scale,
    maxFps: reduced ? Math.min(REDUCED_FPS, dimensions.maxFps) : dimensions.maxFps,
    onLight,
  };
}

/**
 * Clamped to `0..1`, and anything that is not a number is silence.
 *
 * An analyser that has not produced a sample yet hands back `NaN`, and a
 * presence that answered that with an undrawable uniform would be a black
 * canvas rather than a quiet one.
 */
export function clampActivity(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The point grid the design generates, scaled by size. */
export function presencePointCount(density: number): number {
  return presenceRows(density) * presenceColumns(density);
}

export function presenceRows(density: number): number {
  return Math.max(36, Math.round(112 * density));
}

export function presenceColumns(density: number): number {
  return Math.max(44, Math.round(140 * density));
}

/** The state-carrying parameters, for comparing two states honestly. */
export function presencePosture(visuals: PresenceVisuals): PresencePosture {
  const { amp, freq, speed, torsion, jitter, size, bright, rim, halo, pulse, warm, lineBias, spin } =
    visuals;
  return { amp, freq, speed, torsion, jitter, size, bright, rim, halo, pulse, warm, lineBias, spin };
}

/**
 * `0..1` onto a shading multiplier, with the neutral point at exactly `1`.
 *
 * An absent value and the neutral value must draw identically, or every
 * profile written before this control existed would change appearance the
 * first time it was read back.
 */
function lightGain(response: number | undefined): number {
  if (typeof response !== 'number' || !Number.isFinite(response)) return 1;
  const v = Math.min(1, Math.max(0, response));
  return v <= NEUTRAL_LIGHT_RESPONSE
    ? LIGHT_FLOOR + ((1 - LIGHT_FLOOR) * v) / NEUTRAL_LIGHT_RESPONSE
    : 1 + ((LIGHT_CEILING - 1) * (v - NEUTRAL_LIGHT_RESPONSE)) / (1 - NEUTRAL_LIGHT_RESPONSE);
}

const ACCENT = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb` is expanded here so the renderer only ever sees `#rrggbb`. */
function normalizeAccent(accent: string | undefined): string | null {
  if (!accent || !ACCENT.test(accent)) return null;
  const hex = accent.slice(1).toLowerCase();
  if (hex.length === 6) return `#${hex}`;
  return `#${hex[0]!}${hex[0]!}${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}`;
}

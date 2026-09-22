/**
 * How Vowe looks, everywhere.
 *
 * One appearance for one presence: the same profile drives the signature in a
 * sidebar, the orb in a project room and the large form on a voice stage,
 * because they are the same entity and looking different in each place would
 * say otherwise. Stored globally, never inside a session or a project.
 *
 * This is the settings contract only: nothing here implements a form, a
 * material or a motion. What draws them is `presence-visuals.ts`, and what
 * mounts that is the renderer's `VowePresence`.
 *
 * Nothing in this file touches the filesystem, so the renderer can import it
 * directly through `@vowe/core/presence`. Where it is stored is
 * `presence-profile-store.ts`, which is main-process code.
 */

/**
 * Extensible on purpose, and currently a single value.
 *
 * Mesh, knot and halo forms are plausible and the schema will take them
 * without a migration. Only `point-cloud` is implemented, so only
 * `point-cloud` is offered: a picker listing forms that do not render is the
 * kind of thing that makes a product feel like a mock-up.
 */
export type PresenceForm = 'point-cloud';

export type PresenceMaterial =
  | 'chrome'
  | 'silver'
  | 'obsidian'
  | 'frost'
  | 'iridescent'
  | 'matrix'
  | 'plasma'
  | 'pearl';

export type PresenceMotion = 'calm' | 'fluid' | 'reactive' | 'energetic';

export interface PresenceProfile {
  form: PresenceForm;
  material: PresenceMaterial;
  motion: PresenceMotion;
  /** `#rgb` or `#rrggbb`. Tints the lit colour, never the application. */
  accent?: string;
  /** `#rgb` or `#rrggbb`. Tints the shadow colour the body reads as. */
  bodyAccent?: string;
  /**
   * How hard the surface answers its light, `0..1`.
   *
   * A single dial over shading gain and rim response. Absent means the
   * material's own figures stand, which is why `0.5` is the neutral point
   * rather than `0`: a stored profile and an unset one must draw identically.
   */
  lightResponse?: number;
}

export const PRESENCE_FORMS: readonly PresenceForm[] = ['point-cloud'];

/** Ordered as the approved design lays the swatches out. */
export const PRESENCE_MATERIALS: readonly PresenceMaterial[] = [
  'chrome',
  'silver',
  'obsidian',
  'frost',
  'iridescent',
  'matrix',
  'plasma',
  'pearl',
];

export const PRESENCE_MOTIONS: readonly PresenceMotion[] = [
  'calm',
  'fluid',
  'reactive',
  'energetic',
];

/** The value `lightResponse` is absent at. Draws exactly like the material. */
export const NEUTRAL_LIGHT_RESPONSE = 0.5;

export const DEFAULT_PRESENCE_PROFILE: PresenceProfile = {
  form: 'point-cloud',
  material: 'silver',
  motion: 'calm',
};

const ACCENT = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Anything unrecognised becomes the default rather than being rejected.
 *
 * A profile written by a future version that knew about a `mesh` form must
 * still open here, as a point cloud, rather than failing and taking the
 * developer's material and motion down with it.
 */
export function normalizePresenceProfile(value: unknown): PresenceProfile {
  const source = (value ?? {}) as Record<string, unknown>;

  const profile: PresenceProfile = {
    form: oneOf(source['form'], PRESENCE_FORMS, DEFAULT_PRESENCE_PROFILE.form),
    material: oneOf(
      source['material'],
      PRESENCE_MATERIALS,
      DEFAULT_PRESENCE_PROFILE.material,
    ),
    motion: oneOf(
      source['motion'],
      PRESENCE_MOTIONS,
      DEFAULT_PRESENCE_PROFILE.motion,
    ),
  };

  const accent = typeof source['accent'] === 'string' ? source['accent'].trim() : '';
  if (ACCENT.test(accent)) profile.accent = accent.toLowerCase();

  const body = typeof source['bodyAccent'] === 'string' ? source['bodyAccent'].trim() : '';
  if (ACCENT.test(body)) profile.bodyAccent = body.toLowerCase();

  const light = source['lightResponse'];
  if (typeof light === 'number' && Number.isFinite(light)) {
    profile.lightResponse = Math.min(1, Math.max(0, light));
  }

  return profile;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

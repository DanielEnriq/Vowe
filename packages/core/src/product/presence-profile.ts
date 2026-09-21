import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';

/**
 * How Vowe looks, everywhere.
 *
 * One appearance for one presence: the same profile drives the signature in a
 * sidebar, the orb in a project room and the large form on a voice stage,
 * because they are the same entity and looking different in each place would
 * say otherwise. Stored globally, never inside a session or a project.
 *
 * This is the settings contract only. The renderer that draws any of it is
 * Slice 3 — nothing here implements a form, a material or a motion.
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

export type PresenceMaterial = 'silver' | 'obsidian' | 'matrix' | 'plasma';

export type PresenceMotion = 'calm' | 'fluid' | 'reactive';

export interface PresenceProfile {
  form: PresenceForm;
  material: PresenceMaterial;
  motion: PresenceMotion;
  /** `#rgb` or `#rrggbb`. Tints the presence, never the application. */
  accent?: string;
}

export const PRESENCE_FORMS: readonly PresenceForm[] = ['point-cloud'];

export const PRESENCE_MATERIALS: readonly PresenceMaterial[] = [
  'silver',
  'obsidian',
  'matrix',
  'plasma',
];

export const PRESENCE_MOTIONS: readonly PresenceMotion[] = [
  'calm',
  'fluid',
  'reactive',
];

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

  return profile;
}

/** `<storeRoot>/presence.json`, beside `profile.json`. */
export class PresenceProfileStore {
  private readonly file: LocalSettingsFile<PresenceProfile>;

  constructor(options: {
    /** The Vowe store root, e.g. `<userData>/vowe`. */
    root: string;
    onError?: (scope: string, error: unknown) => void;
  }) {
    this.file = new LocalSettingsFile<PresenceProfile>({
      file: path.join(options.root, 'presence.json'),
      normalize: normalizePresenceProfile,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  get(): Promise<PresenceProfile> {
    return this.file.get();
  }

  /** Returns what was stored, which may differ from what was asked for. */
  set(profile: PresenceProfile): Promise<PresenceProfile> {
    return this.file.set(profile);
  }
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

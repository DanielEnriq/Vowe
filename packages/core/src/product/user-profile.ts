import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';

/**
 * Who the developer is, locally.
 *
 * Deliberately the smallest thing that lets a conversation show two speakers.
 * There is no account, no sign-in, no cloud sync and no reading of the OS
 * user: a name and a picture are a display concern, and authentication is a
 * thing Vowe should acquire when it gains something to authenticate *to* —
 * shared projects, multi-device state, hosted billing — not in order to draw
 * an avatar next to a message.
 */
export interface UserProfile {
  displayName: string;
  avatarUri?: string;
}

/** `You` until the developer says otherwise. Never blank, never a guess. */
export const DEFAULT_USER_PROFILE: UserProfile = { displayName: 'You' };

const MAX_DISPLAY_NAME = 60;

/**
 * Avatar sources worth rendering.
 *
 * An allow-list rather than a deny-list, because this string ends up in an
 * `img src` in a renderer that can reach the filesystem. `javascript:` is the
 * obvious hazard; enumerating what is fine is the version of this check that
 * stays correct as schemes are invented.
 */
const SAFE_AVATAR = /^(?:data:image\/[a-z0-9.+-]+[;,]|file:\/\/|https?:\/\/|\/)/i;

export function normalizeUserProfile(value: unknown): UserProfile {
  const source = (value ?? {}) as Record<string, unknown>;

  const raw = typeof source['displayName'] === 'string' ? source['displayName'] : '';
  const displayName = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME);

  const profile: UserProfile = {
    displayName: displayName || DEFAULT_USER_PROFILE.displayName,
  };

  const avatar = typeof source['avatarUri'] === 'string' ? source['avatarUri'].trim() : '';
  if (avatar && SAFE_AVATAR.test(avatar)) profile.avatarUri = avatar;

  return profile;
}

/**
 * `<storeRoot>/profile.json`.
 *
 * Beside `sessions.json` and `projects.json`, not inside either. One identity
 * for the whole application — a display name that lived in a session would be
 * a different person in every room.
 */
export class UserProfileStore {
  private readonly file: LocalSettingsFile<UserProfile>;

  constructor(options: {
    /** The Vowe store root, e.g. `<userData>/vowe`. */
    root: string;
    onError?: (scope: string, error: unknown) => void;
  }) {
    this.file = new LocalSettingsFile<UserProfile>({
      file: path.join(options.root, 'profile.json'),
      normalize: normalizeUserProfile,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  get(): Promise<UserProfile> {
    return this.file.get();
  }

  /** Returns what was stored, which may differ from what was asked for. */
  set(profile: UserProfile): Promise<UserProfile> {
    return this.file.set(profile);
  }
}

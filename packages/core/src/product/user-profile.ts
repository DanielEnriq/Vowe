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

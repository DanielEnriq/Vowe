import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';
import { normalizeUserProfile, type UserProfile } from './user-profile.js';

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

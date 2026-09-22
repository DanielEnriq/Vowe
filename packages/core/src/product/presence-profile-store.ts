import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';
import { normalizePresenceProfile, type PresenceProfile } from './presence-profile.js';

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

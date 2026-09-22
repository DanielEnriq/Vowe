import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';
import { normalizeTemperament, type TemperamentProfile } from './temperament.js';

/**
 * `<storeRoot>/temperament.json`, beside `presence.json`.
 *
 * A separate file from the presence profile because they are separate things:
 * how Vowe looks and how Vowe behaves are edited in the same screen and must
 * never be coupled in storage, or a future appearance migration would be able
 * to reset someone's interruption settings.
 */
export class TemperamentStore {
  private readonly file: LocalSettingsFile<TemperamentProfile>;

  constructor(options: { root: string; onError?: (scope: string, error: unknown) => void }) {
    this.file = new LocalSettingsFile<TemperamentProfile>({
      file: path.join(options.root, 'temperament.json'),
      normalize: normalizeTemperament,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  get(): Promise<TemperamentProfile> {
    return this.file.get();
  }

  /** Returns what was stored, which may differ from what was asked for. */
  set(profile: TemperamentProfile): Promise<TemperamentProfile> {
    return this.file.set(profile);
  }
}

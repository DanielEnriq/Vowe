import path from 'node:path';

import { normalizeAppearanceSetting, type AppearanceSetting } from './appearance.js';
import { LocalSettingsFile } from './local-settings.js';

/** `<storeRoot>/appearance.json`. One appearance for one Vowe, like the voice. */
export class AppearanceStore {
  private readonly file: LocalSettingsFile<AppearanceSetting>;

  constructor(options: { root: string; onError?: (scope: string, error: unknown) => void }) {
    this.file = new LocalSettingsFile<AppearanceSetting>({
      file: path.join(options.root, 'appearance.json'),
      normalize: normalizeAppearanceSetting,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  get(): Promise<AppearanceSetting> {
    return this.file.get();
  }

  set(setting: AppearanceSetting): Promise<AppearanceSetting> {
    return this.file.set(setting);
  }
}

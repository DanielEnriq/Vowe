import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';
import { normalizeVoicePreference, type VoicePreference } from './voice-preference.js';

/** `<storeRoot>/voice.json`. One voice for one Vowe, like the presence. */
export class VoicePreferenceStore {
  private readonly file: LocalSettingsFile<VoicePreference>;

  constructor(options: { root: string; onError?: (scope: string, error: unknown) => void }) {
    this.file = new LocalSettingsFile<VoicePreference>({
      file: path.join(options.root, 'voice.json'),
      normalize: normalizeVoicePreference,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  get(): Promise<VoicePreference> {
    return this.file.get();
  }

  set(preference: VoicePreference): Promise<VoicePreference> {
    return this.file.set(preference);
  }
}

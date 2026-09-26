import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';

/**
 * Projects the developer has paused. A paused project's sessions are still
 * recorded (local, free, no gaps), but Vowe reaches for no model on their
 * behalf until it is resumed; what the developer explicitly asks still runs.
 *
 * `<storeRoot>/observing.json`.
 */
export interface ObservingPreference {
  pausedProjects: string[];
}

export class ObservingStore {
  private readonly file: LocalSettingsFile<ObservingPreference>;

  constructor(options: { root: string; onError?: (scope: string, error: unknown) => void }) {
    this.file = new LocalSettingsFile<ObservingPreference>({
      file: path.join(options.root, 'observing.json'),
      normalize: (value) => {
        const paused = (value as Partial<ObservingPreference> | null)?.pausedProjects;
        return {
          pausedProjects: Array.isArray(paused)
            ? [...new Set(paused.filter((id): id is string => typeof id === 'string'))]
            : [],
        };
      },
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  get(): Promise<ObservingPreference> {
    return this.file.get();
  }

  set(preference: ObservingPreference): Promise<ObservingPreference> {
    return this.file.set(preference);
  }
}

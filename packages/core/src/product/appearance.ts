/**
 * Whether Vowe is dark, light, or whatever the machine is.
 *
 * One setting, three values, and the third is the default — an application
 * that ignores the appearance the developer set for everything else is an
 * application that stands out for the wrong reason. `system` is a standing
 * instruction rather than a resolved value: it keeps following macOS after the
 * choice is made, including the automatic switch at dusk.
 *
 * What is *not* here is the resolved theme. Core does not know whether the
 * machine is currently dark, and storing the answer would make the file wrong
 * the moment the machine changed its mind. The platform resolves `system`, the
 * window is told, and the stylesheet follows.
 */
export type Appearance = 'system' | 'dark' | 'light';

export interface AppearanceSetting {
  theme: Appearance;
}

export const APPEARANCES: readonly Appearance[] = ['system', 'dark', 'light'];

export const DEFAULT_APPEARANCE_SETTING: AppearanceSetting = { theme: 'system' };

export function normalizeAppearanceSetting(value: unknown): AppearanceSetting {
  const source = (value ?? {}) as Record<string, unknown>;
  const raw = source['theme'];
  return APPEARANCES.includes(raw as Appearance)
    ? { theme: raw as Appearance }
    : DEFAULT_APPEARANCE_SETTING;
}

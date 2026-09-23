import { describe, expect, it } from 'vitest';

import {
  APPEARANCES,
  DEFAULT_APPEARANCE_SETTING,
  normalizeAppearanceSetting,
} from '../src/index.js';

describe('Appearance — the one setting, read back safely', () => {
  it('keeps every appearance it offers', () => {
    for (const theme of APPEARANCES) {
      expect(normalizeAppearanceSetting({ theme })).toEqual({ theme });
    }
  });

  /**
   * A settings file is the one input nobody validates before it arrives: it
   * may be absent on first run, hand-edited, or written by a version that
   * spelled things differently. None of those is a reason to start dark when
   * the machine is light, or to start at all with an undefined theme.
   */
  it('falls back to the machine for anything it does not recognise', () => {
    for (const value of [null, undefined, {}, 'dark', 42, { theme: 'solarized' }, { theme: null }]) {
      expect(normalizeAppearanceSetting(value)).toEqual(DEFAULT_APPEARANCE_SETTING);
    }
    expect(DEFAULT_APPEARANCE_SETTING.theme).toBe('system');
  });
});

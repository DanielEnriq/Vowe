import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRESENCE_PROFILE,
  PRESENCE_MATERIALS,
  PRESENCE_MOTIONS,
  PRESENCE_SIZES,
  PRESENCE_STATES,
  clampActivity,
  normalizePresenceProfile,
  presencePointCount,
  presencePosture,
  resolvePresenceVisuals,
  type PresenceProfile,
} from '../src/index.js';

const PROFILE: PresenceProfile = DEFAULT_PRESENCE_PROFILE;

describe('Presence appearance — every state is drawable', () => {
  it('resolves finite, sane parameters for every state at every size', () => {
    for (const state of PRESENCE_STATES) {
      for (const size of PRESENCE_SIZES) {
        const visuals = resolvePresenceVisuals(state, PROFILE, size);
        for (const [key, value] of Object.entries(visuals)) {
          if (typeof value === 'number') {
            expect(Number.isFinite(value), `${state}/${size}/${key}`).toBe(true);
            expect(value, `${state}/${size}/${key}`).toBeGreaterThanOrEqual(0);
          } else {
            expect(value, `${state}/${size}/${key}`).toMatch(/^#[0-9a-f]{6}$/);
          }
        }
        expect(visuals.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * The load-bearing promise of the whole slice: appearance is the developer's
   * to change, so a state that was only a colour would stop meaning anything
   * the moment they changed the material. Every state must differ in motion,
   * deformation or rhythm.
   */
  it('keeps every pair of states distinguishable without colour', () => {
    const postures = PRESENCE_STATES.map(
      (state) => [state, presencePosture(resolvePresenceVisuals(state, PROFILE, 'project'))] as const,
    );

    for (let i = 0; i < postures.length; i++) {
      for (let j = i + 1; j < postures.length; j++) {
        const [a, left] = postures[i]!;
        const [b, right] = postures[j]!;
        expect(left, `${a} vs ${b}`).not.toEqual(right);
      }
    }
  });
});

describe('Presence appearance — the profile drives it', () => {
  it('is deterministic: the same inputs resolve to the same appearance', () => {
    for (const state of PRESENCE_STATES) {
      expect(resolvePresenceVisuals(state, PROFILE, 'voice')).toEqual(
        resolvePresenceVisuals(state, PROFILE, 'voice'),
      );
    }
  });

  it('gives every material its own colour and every motion its own tempo', () => {
    const colours = PRESENCE_MATERIALS.map(
      (material) => resolvePresenceVisuals('idle', { ...PROFILE, material }, 'project').colorB,
    );
    expect(new Set(colours).size).toBe(PRESENCE_MATERIALS.length);

    const speeds = PRESENCE_MOTIONS.map(
      (motion) => resolvePresenceVisuals('observing', { ...PROFILE, motion }, 'project').speed,
    );
    expect(new Set(speeds).size).toBe(PRESENCE_MOTIONS.length);
  });

  it('tints with the accent and leaves the material its shadow', () => {
    const plain = resolvePresenceVisuals('idle', PROFILE, 'project');
    const tinted = resolvePresenceVisuals('idle', { ...PROFILE, accent: '#dce8ff' }, 'project');

    expect(tinted.colorA).toBe('#dce8ff');
    expect(tinted.colorB).toBe(plain.colorB);
  });

  it('expands a short accent, so the renderer only ever sees six digits', () => {
    const visuals = resolvePresenceVisuals('idle', { ...PROFILE, accent: '#ABC' }, 'project');
    expect(visuals.colorA).toBe('#aabbcc');
  });

  /** A profile written by a future version must still open as something. */
  it('draws a profile it does not recognise', () => {
    const profile = normalizePresenceProfile({ form: 'mesh', material: 'lava', motion: 'frantic' });
    const visuals = resolvePresenceVisuals('idle', profile, 'project');
    expect(visuals.colorA).toBe(
      resolvePresenceVisuals('idle', DEFAULT_PRESENCE_PROFILE, 'project').colorA,
    );
  });
});

describe('Presence appearance — size', () => {
  it('stays a dense cloud at every size, and never denser than the design', () => {
    for (const size of PRESENCE_SIZES) {
      const { density } = resolvePresenceVisuals('idle', PROFILE, size);
      expect(density).toBeGreaterThan(0);
      expect(density).toBeLessThanOrEqual(1);
      // Small enough to draw at 26px, dense enough to still read as a cloud.
      expect(presencePointCount(density)).toBeGreaterThan(2000);
    }
  });

  /** A presence that is open all day should not cost what one being watched does. */
  it('runs the small sizes at half rate and the large ones at full', () => {
    expect(resolvePresenceVisuals('idle', PROFILE, 'signature').maxFps).toBe(30);
    expect(resolvePresenceVisuals('idle', PROFILE, 'compact').maxFps).toBe(30);
    for (const size of ['project', 'voice', 'studio'] as const) {
      expect(resolvePresenceVisuals('idle', PROFILE, size).maxFps).toBe(60);
    }
  });

  it('spends the most points where there is room for them', () => {
    const signature = resolvePresenceVisuals('idle', PROFILE, 'signature').density;
    const studio = resolvePresenceVisuals('idle', PROFILE, 'studio').density;
    expect(signature).toBeLessThan(studio);
  });
});

describe('Presence appearance — activity', () => {
  it('clamps anything that is not a usable level to silence', () => {
    expect(clampActivity(-1)).toBe(0);
    expect(clampActivity(2)).toBe(1);
    expect(clampActivity(Number.NaN)).toBe(0);
    expect(clampActivity(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampActivity(undefined)).toBe(0);
    expect(clampActivity(null)).toBe(0);
    expect(clampActivity(0.42)).toBe(0.42);
  });
});

describe('Presence appearance — reduced motion', () => {
  /**
   * Less movement, not less meaning. Speed and pulse come down; the posture
   * that says what Vowe is doing does not, or the setting would cost the
   * developer the state distinctions along with the animation.
   */
  it('damps movement and keeps posture, for every state', () => {
    for (const state of PRESENCE_STATES) {
      const plain = resolvePresenceVisuals(state, PROFILE, 'project');
      const reduced = resolvePresenceVisuals(state, PROFILE, 'project', { reducedMotion: true });

      expect(reduced.speed).toBeLessThanOrEqual(plain.speed);
      expect(reduced.pulse).toBeLessThanOrEqual(plain.pulse);
      expect(reduced.spin).toBeLessThan(plain.spin);
      expect(reduced.maxFps).toBeLessThanOrEqual(plain.maxFps);

      expect(reduced.amp).toBe(plain.amp);
      expect(reduced.freq).toBe(plain.freq);
      expect(reduced.torsion).toBe(plain.torsion);
      expect(reduced.jitter).toBe(plain.jitter);
      expect(reduced.size).toBe(plain.size);
    }
  });

  it('still tells the seven states apart with movement reduced', () => {
    const postures = PRESENCE_STATES.map((state) =>
      JSON.stringify(
        presencePosture(resolvePresenceVisuals(state, PROFILE, 'project', { reducedMotion: true })),
      ),
    );
    expect(new Set(postures).size).toBe(PRESENCE_STATES.length);
  });
});

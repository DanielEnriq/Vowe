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
    // Both illuminations: a presence that is undrawable on paper is as broken
    // as one that is undrawable in the dark.
    for (const onLight of [false, true]) {
      for (const state of PRESENCE_STATES) {
        for (const size of PRESENCE_SIZES) {
          const visuals = resolvePresenceVisuals(state, PROFILE, size, { onLight });
          for (const [key, value] of Object.entries(visuals)) {
            const where = `${onLight ? 'light' : 'dark'}/${state}/${size}/${key}`;
            if (typeof value === 'number') {
              expect(Number.isFinite(value), where).toBe(true);
              expect(value, where).toBeGreaterThanOrEqual(0);
            } else if (typeof value === 'boolean') {
              expect(value, where).toBe(onLight);
            } else {
              expect(value, where).toMatch(/^#[0-9a-f]{6}$/);
            }
          }
          expect(visuals.opacity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  /**
   * The light appearance changes the light, not the developer's choices.
   *
   * The failure this guards against is the easy one: reaching for a darker
   * material or a different accent when the page turns white, which would
   * silently overrule what someone picked in the studio. What may differ is
   * how the cloud is composited and how hard it is lit — and the ring, which
   * is added light and so has nothing to add to paper.
   */
  it('keeps the material on a light page, and changes only the light', () => {
    for (const state of PRESENCE_STATES) {
      const dark = resolvePresenceVisuals(state, PROFILE, 'project');
      const light = resolvePresenceVisuals(state, PROFILE, 'project', { onLight: true });

      expect(light.colorA).toBe(dark.colorA);
      expect(light.colorB).toBe(dark.colorB);
      expect(light.irid).toBe(dark.irid);
      expect(presencePosture({ ...light, halo: dark.halo })).toEqual(presencePosture(dark));

      expect(light.onLight).toBe(true);
      expect(light.halo).toBe(0);
      expect(light.gain).toBeLessThan(dark.gain);
      expect(light.opacity).toBeGreaterThanOrEqual(dark.opacity);
      expect(light.opacity).toBeLessThanOrEqual(1);
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

describe('Presence appearance — the full design control surface', () => {
  it('draws all eight materials distinguishably, and never by colour alone', () => {
    expect(PRESENCE_MATERIALS).toHaveLength(8);

    const fingerprints = PRESENCE_MATERIALS.map((material) => {
      const { colorA, colorB, gain, opacity, irid } = resolvePresenceVisuals(
        'idle',
        { ...PROFILE, material },
        'studio',
      );
      return JSON.stringify({ colorA, colorB, gain, opacity, irid });
    });
    expect(new Set(fingerprints).size).toBe(PRESENCE_MATERIALS.length);

    // Two materials may share a hue family; they may not share everything but
    // hue, or changing material would be a recolour rather than a material.
    const lit = PRESENCE_MATERIALS.map(
      (material) => resolvePresenceVisuals('idle', { ...PROFILE, material }, 'studio').colorA,
    );
    expect(new Set(lit).size).toBe(PRESENCE_MATERIALS.length);
  });

  it('separates the four motion modes monotonically', () => {
    expect(PRESENCE_MOTIONS).toEqual(['calm', 'fluid', 'reactive', 'energetic']);

    const speeds = PRESENCE_MOTIONS.map(
      (motion) => resolvePresenceVisuals('observing', { ...PROFILE, motion }, 'project').speed,
    );
    for (let i = 1; i < speeds.length; i += 1) {
      expect(speeds[i]!, PRESENCE_MOTIONS[i]).toBeGreaterThan(speeds[i - 1]!);
    }
  });

  it('tints the body with bodyAccent and leaves the lit colour alone', () => {
    const base = resolvePresenceVisuals('idle', PROFILE, 'studio');
    const tinted = resolvePresenceVisuals('idle', { ...PROFILE, bodyAccent: '#3a2a6d' }, 'studio');

    expect(tinted.colorB).toBe('#3a2a6d');
    expect(tinted.colorA).toBe(base.colorA);
  });

  it('expands a short body accent and ignores a malformed one', () => {
    expect(resolvePresenceVisuals('idle', { ...PROFILE, bodyAccent: '#abc' }, 'studio').colorB).toBe(
      '#aabbcc',
    );
    const material = resolvePresenceVisuals('idle', PROFILE, 'studio').colorB;
    expect(
      resolvePresenceVisuals('idle', { ...PROFILE, bodyAccent: 'violet' }, 'studio').colorB,
    ).toBe(material);
  });

  /**
   * The whole reason the neutral point is 0.5 rather than 0: a profile stored
   * before this control existed must draw exactly like one that sets it to the
   * middle, or reading a profile back would silently change how Vowe looks.
   */
  it('draws identically whether lightResponse is absent or neutral', () => {
    const absent = resolvePresenceVisuals('speaking', PROFILE, 'voice');
    const neutral = resolvePresenceVisuals('speaking', { ...PROFILE, lightResponse: 0.5 }, 'voice');
    expect(neutral).toEqual(absent);
  });

  it('moves shading with lightResponse, monotonically and within bounds', () => {
    const at = (lightResponse: number) =>
      resolvePresenceVisuals('speaking', { ...PROFILE, lightResponse }, 'voice');

    const soft = at(0);
    const mid = at(0.5);
    const strong = at(1);

    expect(soft.bright).toBeLessThan(mid.bright);
    expect(mid.bright).toBeLessThan(strong.bright);
    expect(soft.rim).toBeLessThan(mid.rim);
    expect(mid.rim).toBeLessThan(strong.rim);

    // Bounded: the dial cannot extinguish the presence or blow it out.
    expect(soft.bright / mid.bright).toBeCloseTo(0.7, 5);
    expect(strong.bright / mid.bright).toBeCloseTo(1.3, 5);
  });

  it('clamps an out-of-range lightResponse rather than distorting the surface', () => {
    const low = resolvePresenceVisuals('idle', { ...PROFILE, lightResponse: -4 }, 'studio');
    const high = resolvePresenceVisuals('idle', { ...PROFILE, lightResponse: 9 }, 'studio');
    expect(low.bright).toBeCloseTo(resolvePresenceVisuals('idle', { ...PROFILE, lightResponse: 0 }, 'studio').bright, 10);
    expect(high.bright).toBeCloseTo(resolvePresenceVisuals('idle', { ...PROFILE, lightResponse: 1 }, 'studio').bright, 10);
  });

  it('keeps every state apart at every material, so appearance never costs meaning', () => {
    for (const material of PRESENCE_MATERIALS) {
      const postures = PRESENCE_STATES.map((state) =>
        JSON.stringify(presencePosture(resolvePresenceVisuals(state, { ...PROFILE, material }, 'project'))),
      );
      expect(new Set(postures).size, material).toBe(PRESENCE_STATES.length);
    }
  });
});

describe('Presence profile — the widened schema', () => {
  it('keeps the new appearance fields through normalization', () => {
    const profile = normalizePresenceProfile({
      form: 'point-cloud',
      material: 'iridescent',
      motion: 'energetic',
      accent: '#DCE8FF',
      bodyAccent: '#ABC',
      lightResponse: 0.8,
    });
    expect(profile).toEqual({
      form: 'point-cloud',
      material: 'iridescent',
      motion: 'energetic',
      accent: '#dce8ff',
      bodyAccent: '#abc',
      lightResponse: 0.8,
    });
  });

  it('drops the new fields rather than storing nonsense', () => {
    const profile = normalizePresenceProfile({
      material: 'pearl',
      bodyAccent: 'rebeccapurple',
      lightResponse: 'strong',
    });
    expect(profile.bodyAccent).toBeUndefined();
    expect(profile.lightResponse).toBeUndefined();
    expect(profile.material).toBe('pearl');
  });

  it('clamps a stored lightResponse into range', () => {
    expect(normalizePresenceProfile({ lightResponse: 12 }).lightResponse).toBe(1);
    expect(normalizePresenceProfile({ lightResponse: -3 }).lightResponse).toBe(0);
  });
});

describe('Presence visuals — reacting to real work', () => {
  /**
   * The point of the thinking state having a pulse at all: an activity signal
   * derived from real execution events must be able to reach the surface.
   * Without this it is a parameter the renderer computes and nothing consumes.
   */
  it('lets activity reach the surface while Vowe is thinking', () => {
    const visuals = resolvePresenceVisuals('thinking', DEFAULT_PRESENCE_PROFILE, 'project');
    expect(visuals.pulse).toBeGreaterThan(0);
  });

  /**
   * The large voice presence is the sphere and nothing else. The ring reads as
   * a halo at signature size and as a drawn circle at 300px, where it framed
   * the orb against the edge of its own canvas.
   */
  it('draws no ring at voice size, in any state', () => {
    for (const state of PRESENCE_STATES) {
      const voice = resolvePresenceVisuals(state, DEFAULT_PRESENCE_PROFILE, 'voice');
      expect(voice.halo).toBe(0);
    }
    // Every other size keeps it: this is framing, not a change of appearance.
    expect(
      resolvePresenceVisuals('listening', DEFAULT_PRESENCE_PROFILE, 'signature').halo,
    ).toBeGreaterThan(0);
  });
});

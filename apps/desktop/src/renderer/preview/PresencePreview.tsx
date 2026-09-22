import { useState, type ReactElement } from 'react';

import {
  DEFAULT_PRESENCE_PROFILE,
  PRESENCE_MATERIALS,
  PRESENCE_MOTIONS,
  PRESENCE_SIZES,
  PRESENCE_STATES,
  type PresenceMaterial,
  type PresenceMotion,
  type PresenceProfile,
  type PresenceState,
} from '@vowe/core/presence';

import { VowePresence } from '../presence/index.js';

/**
 * Where the presence is looked at, not used.
 *
 * Development only, and deliberately not reachable from the application: these
 * are inspection controls over the real component, not product controls over a
 * fake one. Every presence on this page is the same `VowePresence` the sidebar
 * mounts, with the same renderer behind it.
 */
/**
 * One section at a time, because contexts are finite.
 *
 * Chromium keeps a small number of live WebGL contexts per page and drops the
 * oldest when a page asks for more — which on a page showing every state at
 * every size means the first presences quietly go blank. The application will
 * never mount twenty at once; this page would, so it does not.
 */
const SECTIONS = ['states', 'sizes', 'signature', 'interactive', 'stress'] as const;
type Section = (typeof SECTIONS)[number];

export function PresencePreview(): ReactElement {
  const [section, setSection] = useState<Section>('states');
  const [material, setMaterial] = useState<PresenceMaterial>(
    DEFAULT_PRESENCE_PROFILE.material,
  );
  const [motion, setMotion] = useState<PresenceMotion>(DEFAULT_PRESENCE_PROFILE.motion);
  const [accent, setAccent] = useState('');
  const [activity, setActivity] = useState(0);
  const [mounted, setMounted] = useState(true);

  const profile: PresenceProfile = {
    form: 'point-cloud',
    material,
    motion,
    ...(accent ? { accent } : {}),
  };

  return (
    <div className="preview">
      <header>
        <h1>Vowe Presence</h1>
        <p>
          The production component. Compare against the approved design: silhouette,
          density, centre-to-edge falloff, perceived depth, speed and rim.
        </p>
      </header>

      <div className="controls">
        <label>
          Material
          <select
            value={material}
            onChange={(event) => setMaterial(event.target.value as PresenceMaterial)}
          >
            {PRESENCE_MATERIALS.map((one) => (
              <option key={one}>{one}</option>
            ))}
          </select>
        </label>

        <label>
          Motion
          <select
            value={motion}
            onChange={(event) => setMotion(event.target.value as PresenceMotion)}
          >
            {PRESENCE_MOTIONS.map((one) => (
              <option key={one}>{one}</option>
            ))}
          </select>
        </label>

        <label>
          Accent
          <select value={accent} onChange={(event) => setAccent(event.target.value)}>
            <option value="">material default</option>
            <option value="#dce8ff">#dce8ff cold</option>
            <option value="#ffd7b0">#ffd7b0 warm</option>
            <option value="#b9ffd4">#b9ffd4 green</option>
          </select>
        </label>

        <label>
          Activity {activity.toFixed(2)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={activity}
            onChange={(event) => setActivity(Number(event.target.value))}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={mounted}
            onChange={(event) => setMounted(event.target.checked)}
          />
          Mounted
        </label>

      </div>

      <div className="sections">
        {SECTIONS.map((one) => (
          <button
            key={one}
            type="button"
            className={one === section ? 'on' : ''}
            onClick={() => setSection(one)}
          >
            {one}
          </button>
        ))}
      </div>

      {mounted && section === 'states' && (
          <section>
            <h2>States · project size</h2>
            <div className="grid">
              {PRESENCE_STATES.map((state) => (
                <figure key={state}>
                  <VowePresence
                    state={state}
                    profile={profile}
                    size="project"
                    activity={activity}
                  />
                  <figcaption>{state}</figcaption>
                </figure>
              ))}
            </div>
          </section>
      )}

      {mounted && section === 'sizes' && (
          <section>
            <h2>Sizes · one renderer</h2>
            <div className="grid sizes">
              {PRESENCE_SIZES.map((size) => (
                <figure key={size}>
                  <VowePresence
                    state="listening"
                    profile={profile}
                    size={size}
                    activity={activity}
                  />
                  <figcaption>{size}</figcaption>
                </figure>
              ))}
            </div>
          </section>
      )}

      {mounted && section === 'signature' && (
          <section>
            <h2>Signature · every state at 26px</h2>
            <div className="row">
              {PRESENCE_STATES.map((state) => (
                <figure key={state}>
                  <VowePresence state={state} profile={profile} size="signature" />
                  <figcaption>{state}</figcaption>
                </figure>
              ))}
            </div>
          </section>
      )}

      {mounted && section === 'interactive' && (
          <section>
            <h2>Interactive</h2>
            <div className="row">
              <VowePresence
                state="idle"
                profile={profile}
                size="compact"
                label="Talk to Vowe"
                onActivate={() => window.alert('activated')}
              />
              <span className="note">
                Click it, or tab to it and press Enter. Without a handler it is not a
                control at all.
              </span>
            </div>
          </section>
      )}

      {mounted && section === 'stress' && (
          <section>
            <h2>Twelve at once · mount, unmount, repeat</h2>
            <div className="row wrap">
              {Array.from({ length: 12 }, (_, index) => (
                <VowePresence
                  key={index}
                  state={PRESENCE_STATES[index % PRESENCE_STATES.length]!}
                  profile={profile}
                  size="compact"
                />
              ))}
            </div>
          </section>
      )}
    </div>
  );
}

import { useEffect, useState, type ReactElement } from 'react';

import type {
  LiveVoice,
  PresenceProfile,
  PresenceState,
  TemperamentProfile,
  VoicePreference,
} from '@vowe/core';
import { NEUTRAL_LIGHT_RESPONSE, PRESENCE_MATERIALS, PRESENCE_MOTIONS, PRESENCE_STATES } from '@vowe/core/presence';

import { VowePresence } from '../presence/index.js';

interface Props {
  profile: PresenceProfile;
  temperament: TemperamentProfile;
  voice: VoicePreference;
  voiceUnavailableReason: string | null;
  sidebarOpen: boolean;
  onProfileChange: (next: PresenceProfile) => void;
  onTemperamentChange: (next: TemperamentProfile) => void;
  onVoiceChange: (next: VoicePreference) => void;
}

/**
 * Vowe's own settings: how it looks, how it sounds, how it behaves.
 *
 * Every control here maps to something real. The design offers five forms and
 * this offers one, because only one is implemented and a picker listing forms
 * that do not render is what makes a product feel like a mock-up. What is here
 * instead is the whole of what does work — eight materials, four motion modes,
 * both colours, light response — and three behaviour dials that genuinely move
 * runtime behaviour rather than decorating this screen.
 */
export function PresenceStudio({
  profile,
  temperament,
  voice,
  voiceUnavailableReason,
  sidebarOpen,
  onProfileChange,
  onTemperamentChange,
  onVoiceChange,
}: Props): ReactElement {
  const [preview, setPreview] = useState<PresenceState>('idle');
  const voices = useVoices();

  return (
    <main className="studio">
      <div className={`studio-stage${sidebarOpen ? '' : ' clear-titlebar'}`}>
        <div className="identity">
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-0.018em' }}>
            Your Vowe
          </h1>
          <span className="summary">
            {[profile.material, profile.motion].map(capitalize).join(' · ')}
          </span>
          <span className="what">
            Appearance, voice and behaviour are set separately. Changing the material never
            changes how much Vowe interrupts you.
          </span>
        </div>

        <div className="studio-preview">
          {/* The same component the sidebar and the voice stage mount. */}
          <VowePresence state={preview} profile={profile} size="studio" />
        </div>

        <div className="studio-states">
          <span className="eyebrow">Preview state</span>
          <div className="options">
            {PRESENCE_STATES.map((state) => (
              <button
                className={`state-button${preview === state ? ' on' : ''}`}
                type="button"
                key={state}
                aria-pressed={preview === state}
                onClick={() => setPreview(state)}
              >
                {stateLabel(state)}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <span className="note">{STATE_NOTES[preview]}</span>
        </div>
      </div>

      <aside className="studio-panel">
        <div className="panel-heading">
          <span className="title">Appearance</span>
          <span className="what">Material, colour and motion</span>
        </div>

        <section className="studio-section">
          <span className="eyebrow">Material</span>
          <div className="swatches">
            {PRESENCE_MATERIALS.map((material) => (
              <button
                className={`swatch${profile.material === material ? ' on' : ''}`}
                type="button"
                key={material}
                aria-pressed={profile.material === material}
                title={capitalize(material)}
                onClick={() => onProfileChange({ ...profile, material })}
              >
                <span className="chip-fill" style={{ background: SWATCHES[material] }} />
                <span className="label">{capitalize(material)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="studio-section">
          <span className="eyebrow">Colour and light</span>
          <div className="accents">
            <span className="label">Highlight</span>
            <div className="options">
              {HIGHLIGHTS.map((accent) => (
                <button
                  className={`accent${(profile.accent ?? '') === accent.value ? ' on' : ''}`}
                  type="button"
                  key={accent.label}
                  aria-label={accent.label}
                  title={accent.label}
                  style={{ background: accent.swatch }}
                  onClick={() =>
                    onProfileChange(withOptional(profile, 'accent', accent.value))
                  }
                />
              ))}
            </div>
          </div>
          <div className="accents">
            <span className="label">Body</span>
            <div className="options">
              {BODIES.map((accent) => (
                <button
                  className={`accent${(profile.bodyAccent ?? '') === accent.value ? ' on' : ''}`}
                  type="button"
                  key={accent.label}
                  aria-label={accent.label}
                  title={accent.label}
                  style={{ background: accent.swatch }}
                  onClick={() =>
                    onProfileChange(withOptional(profile, 'bodyAccent', accent.value))
                  }
                />
              ))}
            </div>
          </div>

          <Slider
            label="Light response · soft to strong"
            value={profile.lightResponse ?? NEUTRAL_LIGHT_RESPONSE}
            valueLabel={lightLabel(profile.lightResponse ?? NEUTRAL_LIGHT_RESPONSE)}
            onChange={(lightResponse) => onProfileChange({ ...profile, lightResponse })}
          />
        </section>

        <section className="studio-section">
          <span className="eyebrow">Motion</span>
          <div className="segmented">
            {PRESENCE_MOTIONS.map((motion) => (
              <button
                className={profile.motion === motion ? 'on' : undefined}
                type="button"
                key={motion}
                aria-pressed={profile.motion === motion}
                onClick={() => onProfileChange({ ...profile, motion })}
              >
                {capitalize(motion)}
              </button>
            ))}
          </div>
        </section>

        <div className="rule" />

        <div className="panel-heading">
          <span className="title">Voice</span>
          <span className="what">How Vowe sounds</span>
        </div>

        <section className="studio-section">
          {voiceUnavailableReason ? (
            <span className="fine">{voiceUnavailableReason}</span>
          ) : voices.length === 0 ? (
            <span className="fine">This provider offers no choice of voice.</span>
          ) : (
            <>
              <select
                aria-label="Voice"
                value={voice.voice ?? ''}
                onChange={(event) =>
                  onVoiceChange({ voice: event.target.value || null })
                }
              >
                <option value="">Provider default</option>
                {voices.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {/*
                No preview button and no description of each voice: nothing here
                can play a sample without opening a real call, and no provider
                publishes what a voice sounds like.
              */}
              <span className="fine">Takes effect on your next call.</span>
            </>
          )}
        </section>

        <div className="rule" />

        <div className="panel-heading">
          <span className="title">Behaviour</span>
          <span className="what">How Vowe communicates</span>
        </div>

        <section className="studio-section" style={{ gap: 16 }}>
          <Slider
            ends={['Quiet', 'Proactive']}
            value={temperament.proactive}
            onChange={(proactive) => onTemperamentChange({ ...temperament, proactive })}
          />
          <Slider
            ends={['Concise', 'Exploratory']}
            value={temperament.exploratory}
            onChange={(exploratory) => onTemperamentChange({ ...temperament, exploratory })}
          />
          <Slider
            ends={['Professional', 'Casual']}
            value={temperament.casual}
            onChange={(casual) => onTemperamentChange({ ...temperament, casual })}
          />
        </section>

        <section className="studio-section" style={{ gap: 9 }}>
          <span className="eyebrow">Personal instruction</span>
          <textarea
            rows={3}
            aria-label="Personal instruction"
            value={temperament.personalInstruction ?? ''}
            placeholder="Only interrupt me when something actually needs my attention."
            onChange={(event) =>
              onTemperamentChange({
                ...temperament,
                personalInstruction: event.target.value,
              })
            }
          />
          <span className="fine">
            The default for every session. Anything you say about one session overrides it
            there.
          </span>
        </section>
      </aside>
    </main>
  );
}

function Slider({
  label,
  ends,
  value,
  valueLabel,
  onChange,
}: {
  label?: string;
  ends?: [string, string];
  value: number;
  valueLabel?: string;
  onChange: (value: number) => void;
}): ReactElement {
  return (
    <div className="slider-row">
      {label && (
        <div className="named">
          <span>{label}</span>
          {valueLabel && <span className="value">{valueLabel}</span>}
        </div>
      )}
      {ends && (
        <div className="ends">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label={label ?? (ends ? `${ends[0]} to ${ends[1]}` : 'value')}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function useVoices(): LiveVoice[] {
  const [voices, setVoices] = useState<LiveVoice[]>([]);
  useEffect(() => {
    void window.vowe.listVoices().then(setVoices).catch(() => undefined);
  }, []);
  return voices;
}

/** Swatches mirror the material presets, so the picker shows what it selects. */
const SWATCHES: Record<string, string> = {
  chrome: 'linear-gradient(145deg,#ffffff,#8b939c 55%,#464b52)',
  silver: 'linear-gradient(145deg,#f3f7ff,#7b8794 60%,#2f3640)',
  obsidian: 'linear-gradient(145deg,#8d95a2,#23262b 45%,#0b0d10)',
  frost: 'linear-gradient(145deg,#eef6ff,#9fb4c6 60%,#5c7080)',
  iridescent: 'linear-gradient(145deg,#ffd6f0,#9ec8e8 50%,#6f5fa8)',
  matrix: 'linear-gradient(145deg,#b9ffd4,#1c4030 45%,#080d0a)',
  plasma: 'linear-gradient(145deg,#d3e2ff,#5a49a8 50%,#1d1534)',
  pearl: 'linear-gradient(145deg,#fff4e8,#cbbcd6 55%,#8d7f9c)',
};

const HIGHLIGHTS = [
  { label: 'Material default', value: '', swatch: 'linear-gradient(145deg,#ffffff,#8b939c)' },
  { label: 'Cold white', value: '#dce8ff', swatch: '#dce8ff' },
  { label: 'Warm', value: '#ffd9b0', swatch: '#ffd9b0' },
  { label: 'Signal green', value: '#b9ffd4', swatch: '#b9ffd4' },
];

const BODIES = [
  { label: 'Material default', value: '', swatch: 'linear-gradient(145deg,#6e7a87,#2f3640)' },
  { label: 'Ink', value: '#14161a', swatch: '#14161a' },
  { label: 'Steel', value: '#7b8794', swatch: '#7b8794' },
  { label: 'Violet', value: '#3a2a6d', swatch: '#3a2a6d' },
];

const STATE_NOTES: Record<PresenceState, string> = {
  idle: 'Barely moving. Enough life to show it is still there.',
  observing: 'A slow travelling swell while Vowe reads each window.',
  joining: 'Quicker, already reaching for the halo listening will hold.',
  listening: 'The surface tightens and quickens with your voice.',
  thinking: 'Deep, slow deformation and no halo. This replaces a spinner.',
  speaking: 'Displacement follows the syllables, so the words have a body.',
  attention: 'Held tension, a fast ripple and a warm rim.',
  unavailable: 'Dimmed and nearly still. Vowe cannot see the work right now.',
};

function stateLabel(state: PresenceState): string {
  return state === 'unavailable' ? 'Unavailable' : capitalize(state);
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

function lightLabel(value: number): string {
  if (value < 0.33) return 'Soft';
  return value < 0.7 ? 'Balanced' : 'Strong';
}

/** An empty choice removes the key rather than storing an empty string. */
function withOptional(
  profile: PresenceProfile,
  key: 'accent' | 'bodyAccent',
  value: string,
): PresenceProfile {
  const next = { ...profile };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

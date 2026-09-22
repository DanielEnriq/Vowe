import type { ReactElement, RefObject } from 'react';

import type { PresenceProfile, PresenceState } from '@vowe/core';

import { VowePresence } from '../presence/index.js';

interface Props {
  presence: PresenceProfile;
  presenceState: PresenceState;
  activity: number | undefined;
  muted: boolean;
  /** Present only when the backend could attach and hear the call. */
  liveText: string | null;
  sidebandAttached: boolean;
  audio: RefObject<HTMLAudioElement | null>;
  onToggleMute: () => void;
  onEnd: () => void;
}

/**
 * A call, as one fixed frame.
 *
 * The orb takes the room and nothing below it moves: the caption slot is a
 * constant height whether or not there is anything to put in it, so a line
 * arriving never shifts the controls out from under a cursor.
 *
 * The caption is the provider's own transcript of the call, and it exists only
 * while the backend is attached to it. When it is not, the stage says so
 * rather than showing an empty space that looks like silence.
 */
export function VoiceStage({
  presence,
  presenceState,
  activity,
  muted,
  liveText,
  sidebandAttached,
  audio,
  onToggleMute,
  onEnd,
}: Props): ReactElement {
  return (
    <div className="voice-stage">
      <VowePresence
        state={presenceState}
        profile={presence}
        size="voice"
        activity={activity}
      />

      <div className="voice-caption">
        <span className="state">{stateLabel(presenceState)}</span>
        {sidebandAttached ? (
          <p className={presenceState === 'speaking' ? 'speaking' : undefined}>{liveText ?? ''}</p>
        ) : (
          <p>Vowe cannot follow this call from its side, so nothing is transcribed here.</p>
        )}
      </div>

      <div className="voice-controls">
        <button type="button" onClick={onToggleMute} aria-pressed={muted}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button type="button" onClick={onEnd}>
          End
        </button>
      </div>

      <audio ref={audio} autoPlay hidden />
    </div>
  );
}

function stateLabel(state: PresenceState): string {
  const labels: Partial<Record<PresenceState, string>> = {
    joining: 'Joining',
    listening: 'Listening',
    thinking: 'Investigating',
    speaking: 'Speaking',
  };
  return labels[state] ?? 'In voice';
}

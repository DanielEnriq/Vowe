import type { ReactElement } from 'react';

import type { AgentSession, PresenceProfile, PresenceState } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { RoomIdentity } from '../shell/TopChrome.js';
import { VowePresence } from '../presence/index.js';
import { providerName } from '../components/ui.js';
import { sessionTitle } from '@vowe/core/projections';

interface Props {
  session: AgentSession;
  presence: PresenceProfile;
  presenceState: PresenceState;
  observing: boolean;
  inVoice: boolean;
  voiceUnavailableReason: string | null;
  activity: number | undefined;
  onToggleVoice: () => void;
}

/**
 * Which session this is. Not what is happening in it.
 *
 * The header used to carry the interpreter's current-activity line as well —
 * "All ten regression items fixed, awaiting live end-to-end…" — which is real
 * and useful prose in the wrong place twice over. It is already in the
 * conversation, as a milestone or an answer, where it is dated and can be
 * descended into; and a permanent strip of it re-renders on every observation,
 * so the one piece of chrome that should be still was the one thing on screen
 * that never stopped moving.
 *
 * So this identifies context and nothing else: who, on what, where, and
 * whether Vowe is watching. Current worker activity belongs to the timeline.
 *
 * The presence here is the voice entry point. Clicking it joins or ends the
 * call — voice is a state of this room, not a separate product, so there is no
 * modal and nothing to dismiss.
 *
 * Drawn at the top of the room, on the row the application band occupies. It
 * belongs to the room and not to the window: it starts at the room's left
 * edge plus the room's inset, the same inset the conversation below it uses,
 * so opening the projects panel moves the session's name and the session's
 * conversation together. Nothing here knows what is open. See `RoomIdentity`.
 */
export function SessionHeader({
  session,
  presence,
  presenceState,
  observing,
  inVoice,
  voiceUnavailableReason,
  activity,
  onToggleVoice,
}: Props): ReactElement {
  const canTalk = voiceUnavailableReason === null;

  return (
    <RoomIdentity>
      <button
        className="talk"
        type="button"
        aria-label={inVoice ? 'End the call with Vowe' : 'Talk to Vowe'}
        title={inVoice ? 'End' : (voiceUnavailableReason ?? 'Talk to Vowe')}
        disabled={!canTalk}
        onClick={onToggleVoice}
      >
        <VowePresence
          state={presenceState}
          profile={presence}
          size="compact"
          className="header"
          activity={activity}
        />
        {inVoice && <span className="hint">End</span>}
      </button>

      <div className="stack">
        <Fading as="h1">{sessionTitle(session)}</Fading>
        <Fading className="meta">
          {[providerName(session.provider), session.branch]
            .filter(Boolean)
            .join(' · ')}
          {' · '}
          <span className="state">
            <span className={`dot ${session.status}`} aria-hidden />
            {inVoice ? 'In voice' : observing ? 'Observing' : 'Not observing'}
          </span>
        </Fading>
      </div>
    </RoomIdentity>
  );
}

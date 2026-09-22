import type { ReactElement } from 'react';

import type { AgentSession, PresenceProfile, PresenceState } from '@vowe/core';

import { VowePresence } from '../presence/index.js';
import { DeskIcon } from '../shell/icons.js';
import { providerName } from '../components/ui.js';

interface Props {
  session: AgentSession;
  presence: PresenceProfile;
  presenceState: PresenceState;
  observing: boolean;
  inVoice: boolean;
  voiceUnavailableReason: string | null;
  deskCount: number;
  deskHasNew: boolean;
  workbenchOpen: boolean;
  clearTitlebar: boolean;
  activity: number | undefined;
  onToggleVoice: () => void;
  onOpenWorkbench: () => void;
}

/**
 * Who is working, on what, and what Vowe is doing about it.
 *
 * The presence here is the voice entry point. Clicking it joins or ends the
 * call — voice is a state of this room, not a separate product, so there is no
 * modal and nothing to dismiss.
 */
export function SessionHeader({
  session,
  presence,
  presenceState,
  observing,
  inVoice,
  voiceUnavailableReason,
  deskCount,
  deskHasNew,
  workbenchOpen,
  clearTitlebar,
  activity,
  onToggleVoice,
  onOpenWorkbench,
}: Props): ReactElement {
  const canTalk = voiceUnavailableReason === null;

  return (
    <header className={`session-header${clearTitlebar ? ' clear-titlebar' : ''}`}>
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

      <div className="identity">
        <div className="line">
          <h1>{session.displayLabel}</h1>
          <span className="where">
            {[providerName(session.provider), session.branch].filter(Boolean).join(' · ')}
          </span>
          <span className="state">
            <span className={`dot ${session.status}`} aria-hidden />
            {inVoice ? 'In voice' : observing ? 'Observing' : 'Not observing'}
          </span>
        </div>
        <span className="worker">
          {session.semanticState?.currentActivity ?? 'No interpretation yet.'}
        </span>
      </div>

      {!workbenchOpen && deskCount > 0 && (
        <button
          className="desk-button"
          type="button"
          aria-label={`Open workbench · ${deskCount} on the desk`}
          onClick={onOpenWorkbench}
        >
          <DeskIcon />
          <span className="count">{deskCount}</span>
          {deskHasNew && <span className="new" aria-hidden />}
        </button>
      )}
    </header>
  );
}

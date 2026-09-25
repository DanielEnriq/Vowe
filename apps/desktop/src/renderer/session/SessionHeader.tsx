import type { ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { RoomIdentity } from '../shell/TopChrome.js';
import { ProviderGlyph, providerName } from '../components/ui.js';
import { sessionTitle } from '@vowe/core/projections';

interface Props {
  session: AgentSession;
  observing: boolean;
  inVoice: boolean;
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
 * Vowe itself is not here either. The presence used to sit at this title as
 * the way into a call, which put the one moving thing in the window on the
 * row that should be stillest, and put Vowe next to the name of the worker's
 * session rather than next to where you speak to it. It is in the composer
 * now, beside send — where you are already typing to it.
 *
 * Drawn at the top of the room, on the row the application band occupies. It
 * belongs to the room and not to the window: it starts at the room's left
 * edge plus the room's inset, the same inset the conversation below it uses,
 * so opening the projects panel moves the session's name and the session's
 * conversation together. Nothing here knows what is open. See `RoomIdentity`.
 */
export function SessionHeader({ session, observing, inVoice }: Props): ReactElement {
  return (
    <RoomIdentity>
      <div className="stack">
        <Fading as="h1">{sessionTitle(session)}</Fading>
        <Fading className="meta">
          {/*
            The mark sits before the name rather than replacing it. There is
            room for both here, and the header is where someone confirms what
            they are looking at — the sidebar is where they recognise it.
          */}
          <span className="provider-mark">
            <ProviderGlyph provider={session.provider} size={13} />
          </span>
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

import type { ReactElement } from 'react';

import type { AgentSession, FleetLayout, FleetStatus, Project } from '@vowe/core';
import { sessionTitle } from '@vowe/core/projections';

import { BackIcon } from '../shell/icons.js';
import { RoomIdentity } from '../shell/TopChrome.js';
import { statusLook } from '../state/fleet-views.js';

/** Stand-in for Fleet's agent view; the real one replaces this file with the same signature. */
export function AgentView(props: {
  project: Project;
  session: AgentSession;
  layout: FleetLayout;
  status: FleetStatus | undefined;
  onBack(): void;
  onOpenAgent(sessionId: string): void;
  onCompare(clusterId: string): void;
}): ReactElement {
  const look = statusLook(props.status);
  return (
    <main className="session-room fc-room">
      <RoomIdentity>
        <button className="fc-back" type="button" onClick={props.onBack} title={props.project.name}>
          <BackIcon />
          <span className="fc-back-name">{props.project.name}</span>
        </button>
        <h1 className="fm-title">{sessionTitle(props.session)}</h1>
        <span className="fm-member-status">
          <span className={`dot ${look.tone}`} aria-hidden />
          <span className={`status-word ${look.tone}`}>{look.word}</span>
        </span>
      </RoomIdentity>
      <div className="fc-body" />
    </main>
  );
}

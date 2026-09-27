import type { ReactElement, ReactNode } from 'react';

import type { ContextRef, DesignEntry, DesignRevision, PresenceProfile } from '@vowe/core';

import { LiveInvestigation } from '../session/LiveInvestigation.js';
import { MessageBody } from '../session/MessageBody.js';
import { SettledInvestigation } from '../session/SettledInvestigation.js';
import { changeCount, revisionFor, unanswered, type StudioTurn } from '../state/studio.js';

/**
 * The design conversation. Quieter than a chat: Vowe's words are plain text,
 * yours sit to the right, and a move made on the canvas is a single line.
 * Each reply that changed the design can open the change it made.
 */
export function StudioThread({
  entries, revisions, turn, working, presence, activity, onOpenRef, onShowChange,
}: {
  entries: readonly DesignEntry[];
  revisions: readonly DesignRevision[];
  turn: StudioTurn;
  working: boolean;
  presence: PresenceProfile;
  activity: number | undefined;
  onOpenRef: (ref: ContextRef) => void;
  onShowChange: (ord: number) => void;
}): ReactElement {
  const rows: ReactNode[] = entries.map((entry) => {
    if (entry.role === 'companion_note') return null;
    if (entry.role === 'developer_move') {
      return <p key={entry.id} className="studio-move-line"><span>You</span> {entry.text}</p>;
    }
    const mine = entry.role === 'user_message';
    const revision = mine ? null : revisionFor(entry.id, revisions);
    const count = revision ? changeCount(revisions, revision) : 0;
    return (
      <div key={entry.id} className={`turn studio-turn${mine ? ' user' : ''}`} aria-label={mine ? 'You' : 'Vowe'}>
        {entry.investigation && (
          <SettledInvestigation entryId={entry.id} receipt={entry.investigation} onOpenRef={onOpenRef} />
        )}
        <MessageBody text={entry.text} {...(mine ? {} : { onOpenRef })} />
        {revision?.model && count > 0 && (
          <button type="button" className="link-button studio-changes-chip" onClick={() => onShowChange(revision.ord)}>
            {count === 1 ? '1 change' : `${count} changes`}
          </button>
        )}
      </div>
    );
  });
  return (
    <>
      {rows}
      {(turn.live.active || turn.live.answer.length > 0 || turn.consulting) && (
        <LiveInvestigation
          live={turn.live}
          presence={presence}
          activity={activity}
          gathering={turn.consulting !== null}
          onOpenRef={onOpenRef}
          pending={turn.consulting && (
            <div className="consult-pending" role="status">
              <span className="label">Checking current behavior…</span>
              <span className="check-detail">{turn.consulting.activity ?? turn.consulting.question}</span>
            </div>
          )}
        />
      )}
      {unanswered(entries, working) && (
        <p className="fine studio-unanswered">Vowe didn’t finish replying to this.</p>
      )}
    </>
  );
}

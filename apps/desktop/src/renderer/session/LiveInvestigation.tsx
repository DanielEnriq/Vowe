import type { ReactElement } from 'react';

import type { ContextRef, PresenceProfile } from '@vowe/core';

import type { LiveInvestigation as LiveInvestigationState } from '../hooks/useVoweData.js';
import { liveRows } from '../state/investigation-timeline.js';
import { turnPhase } from '../state/live-investigation.js';
import { InvestigationTimeline } from './InvestigationTimeline.js';
import { MessageBody } from './MessageBody.js';
import { VoweMark } from './VoweMark.js';

/**
 * Vowe, working — while it is actually working.
 *
 * Everything here appears when it really happens: each lookup when the lookup
 * is recorded, each sentence when the model writes it. There is no spinner, no
 * skeleton and no percentage, because a progress bar over an investigation
 * nobody can measure would be a number invented to fill a gap.
 *
 * **One timeline.** Lookups and thinking are the same column in the order they
 * occurred — look, think, look, think — because that is what happened, and
 * they are drawn in the same restrained language, because they are the same
 * kind of event. `InvestigationTimeline` is that column, and the settled turn
 * above uses it too.
 *
 * **Two levels of "working", never one word for both.** Inside the trace,
 * `Thinking · Ns` is one reasoning span that is open right now, and it closes
 * into `Thought for Ns` like any other row. The turn as a whole is a separate
 * fact — still gathering, now writing, or done — and it is carried by Vowe's
 * mark at the tail of the region: alone while investigating, since the trace
 * above already says what is happening, and with `Answering…` once the reply
 * is being written, since by then the trace has stopped saying anything.
 *
 * **In the flow.** The region is an ordinary block in an ordinary column: the
 * work appears directly under the question and the answer directly under the
 * work. Nothing pins it to the bottom of the viewport — a live turn pushed
 * down against the composer reads as a modal rather than as the next thing in
 * a conversation.
 */
export function LiveInvestigation({
  live,
  presence,
  activity,
  onOpenRef,
}: {
  live: LiveInvestigationState;
  presence: PresenceProfile;
  activity: number | undefined;
  /** Where a lookup opens. Absent in rooms with no workbench. */
  onOpenRef?: (ref: ContextRef) => void;
}): ReactElement {
  const phase = turnPhase(live);
  const rows = liveRows(live);
  const writing = live.answer.length > 0;

  return (
    <div className="turn live">
      <InvestigationTimeline rows={rows} followTail {...(onOpenRef ? { onOpenRef } : {})} />

      {/*
        The answer, as it is written. The same text the entry will hold: what
        gets persisted is the model's final message, so nothing read here can
        disagree with what is kept. The byline is the one the settled turn
        wears, so nothing changes identity when the entry lands; it is still,
        because the turn's liveness is the tail's to say.
      */}
      {writing && (
        <>
          <div className="signature-line">
            <VoweMark profile={presence} />
            <span className="speaker">Vowe</span>
          </div>
          <div className="live-answer">
            <MessageBody text={live.answer} />
          </div>
        </>
      )}

      {/*
        The turn is alive. Always the last thing in the region, under whatever
        happened most recently — the newest trace row, then the newest line of
        the answer — and gone the moment the turn is finished.
      */}
      {phase !== 'finished' && (
        <div
          className="live-tail"
          role="status"
          aria-label={phase === 'answering' ? 'Vowe is answering' : 'Vowe is working'}
        >
          <VoweMark
            profile={presence}
            state={phase === 'answering' ? 'answering' : 'thinking'}
            activity={activity}
          />
          {phase === 'answering' && <span className="label">Answering…</span>}
        </div>
      )}
    </div>
  );
}

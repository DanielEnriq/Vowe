import { useEffect, useState, type ReactElement } from 'react';

import type { ContextRef, PresenceProfile } from '@vowe/core';

import type { LiveInvestigation as LiveInvestigationState } from '../hooks/useVoweData.js';
import { liveRows } from '../state/investigation-timeline.js';
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
  const writing = live.answer.length > 0;
  const rows = liveRows(live);
  const thinkingNow = rows.some((row) => row.kind === 'thought' && row.live);

  return (
    <div className="turn live">
      {/*
        Vowe is working but has neither looked nor exposed a thought yet — the
        first moment after a question, the gap between a lookup and whatever
        comes next, and every moment with a provider that exposes no reasoning
        at all. It is the newest row of the same column, not a region of its
        own: same line, same scale, same muted ink as a thought row.
      */}
      <InvestigationTimeline
        rows={rows}
        followTail
        pending={live.active && !writing && !thinkingNow ? <ThinkingSince /> : undefined}
        {...(onOpenRef ? { onOpenRef } : {})}
      />

      {/*
        The answer, as it is written. The same text the entry will hold: what
        gets persisted is the model's final message, so nothing read here can
        disagree with what is kept. The byline is the same mark the settled
        turn wears, in its speaking state — no identity swap when it lands,
        and the one place in this region the mark appears at all.
      */}
      {writing && (
        <>
          <div className="signature-line">
            <VoweMark
              profile={presence}
              state={live.active ? 'answering' : 'idle'}
              activity={activity}
            />
            <span className="speaker">Vowe</span>
          </div>
          <div className="live-answer">
            <MessageBody text={live.answer} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Working, with nothing exposed yet.
 *
 * Its own tiny clock rather than a prop: this row exists only between the
 * question and the first thing Vowe does, so the only true start it has is the
 * moment it was mounted. A component rather than a helper because it holds
 * state — and because it only exists in one of the region's states.
 */
function ThinkingSince(): ReactElement {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));

  return (
    <span className="exec-step thought live">
      <span className="label">Thinking · {seconds}s</span>
    </span>
  );
}

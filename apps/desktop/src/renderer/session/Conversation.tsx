import { useEffect, useMemo, useRef, type ReactElement } from 'react';

import type {
  ContextRef,
  ConversationDelivery,
  ConversationEntry,
  PresenceProfile,
  WorkerMilestone,
} from '@vowe/core';

import type { LiveInvestigation as LiveInvestigationState } from '../hooks/useVoweData.js';

import {
  buildTimeline,
  deliveredPortion,
  deliveryFor,
  isGroundedAnswer,
  type SpeakerTurn,
} from '../state/conversation.js';
import { LiveInvestigation } from './LiveInvestigation.js';
import { MessageBody } from './MessageBody.js';
import { SettledInvestigation } from './SettledInvestigation.js';
import { VoweMark } from './VoweMark.js';

interface Props {
  entries: ConversationEntry[];
  deliveries: ConversationDelivery[];
  milestones: WorkerMilestone[];
  presence: PresenceProfile;
  userName: string;
  providerLabel: string;
  /** An ask is in flight; Vowe is looking into it right now. */
  investigating: boolean;
  /** The work as it happens: lookups, exposed working, the answer being written. */
  live: LiveInvestigationState;
  /** Real execution activity, so the live mark moves to the work. */
  activity: number | undefined;
  /** Where a lookup in the investigation column opens. */
  onOpenRef: (ref: ContextRef) => void;
}

/**
 * The session's one conversation, read as a column rather than a chat.
 *
 * The asymmetry is deliberate and is not bubbles-on-both-sides. What the
 * developer said is an *object* they handed over: compact, right aligned,
 * sitting on a surface, as wide as its own content and no wider. What Vowe
 * said is a *document*: left aligned, full reading measure, Markdown, no
 * container, identified by the mark and byline. The eye should be able to tell
 * which is which without reading either, and a symmetric chat would throw that
 * away for the sake of looking like every other client.
 *
 * Identity is shown once per speaker run rather than once per message, and
 * Vowe's mark is the same `VoweMark` the live region uses — one identity down
 * the whole column, in different states.
 */
export function Conversation({
  entries,
  deliveries,
  milestones,
  presence,
  userName,
  providerLabel,
  investigating,
  live,
  activity,
  onOpenRef,
}: Props): ReactElement {
  const scroller = useRef<HTMLDivElement | null>(null);
  const timeline = useMemo(
    () => buildTimeline({ entries, milestones }),
    [entries, milestones],
  );

  /*
   * The log follows the newest turn — unless the reader has gone looking.
   *
   * The tail grows as work lands and as the answer is written, and staying
   * with it is the whole point of streaming. But scrolling to the bottom on
   * every delta takes the column away from anyone who has scrolled up to read
   * something earlier, several times a second, which is worse than not
   * following at all. So the rule is the ordinary one: follow while the reader
   * is already at the end, and leave them alone the moment they are not.
   *
   * `working` is how much of the live region exists so far: one number that
   * moves whenever anything down there does.
   */
  const last = live.steps[live.steps.length - 1];
  const working =
    live.steps.length + (last?.kind === 'thought' ? last.text.length : 0);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance > FOLLOW_WITHIN) return;
    element.scrollTop = element.scrollHeight;
  }, [timeline.length, investigating, working, live.answer.length]);

  return (
    <div className="conversation" ref={scroller}>
      <div className="conversation-measure">
        {timeline.length === 0 && !investigating && (
          <div className="empty-block">
            <h2>Nothing said yet</h2>
            <p className="empty">
              Ask Vowe about this work, or talk to it. Either way it is the same
              conversation, and it is kept.
            </p>
          </div>
        )}

        {timeline.map((item) =>
          item.kind === 'milestone' ? (
            <div className="milestone" key={item.id}>
              <span className="rule" />
              <span className={`text${item.milestone.failed ? ' failed' : ''}`}>
                {providerLabel} · {item.milestone.text}
              </span>
              <span className="rule" />
            </div>
          ) : (
            <Turn
              key={item.id}
              turn={item}
              deliveries={deliveries}
              presence={presence}
              userName={userName}
              onOpenRef={onOpenRef}
            />
          ),
        )}

        {(investigating || live.answer.length > 0) && (
          <LiveInvestigation
            live={live}
            presence={presence}
            activity={activity}
            onOpenRef={onOpenRef}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One speaker's run of turns.
 *
 * Vowe's byline is the same `VoweMark` the live region uses, in its settled
 * state. One identity down the whole column: what changes between a turn that
 * finished and an answer being written is the mark's state, never the mark.
 */
function Turn({
  turn,
  deliveries,
  presence,
  userName,
  onOpenRef,
}: {
  turn: SpeakerTurn;
  deliveries: ConversationDelivery[];
  presence: PresenceProfile;
  userName: string;
  onOpenRef: (ref: ContextRef) => void;
}): ReactElement {
  return (
    <div className={`turn${turn.speaker === 'user' ? ' user' : ''}`}>
      {turn.speaker === 'user' ? (
        <span className="speaker">{userName}</span>
      ) : (
        <div className="signature-line">
          <VoweMark profile={presence} />
          <span className="speaker">Vowe</span>
        </div>
      )}

      {turn.entries.map((entry) => (
        <Entry
          key={entry.id}
          entry={entry}
          deliveries={deliveries}
          onOpenRef={onOpenRef}
        />
      ))}
    </div>
  );
}

function Entry({
  entry,
  deliveries,
  onOpenRef,
}: {
  entry: ConversationEntry;
  deliveries: ConversationDelivery[];
  onOpenRef: (ref: ContextRef) => void;
}): ReactElement {
  const portion = deliveredPortion(entry, deliveryFor(entry.id, deliveries));
  // Only an investigated answer wears a receipt; an ordinary turn must never
  // be dressed as one that went and looked.
  const grounded = isGroundedAnswer(entry);

  return (
    <>
      {/*
        What Vowe did before answering, in the order it did it — the same
        column the live region showed, read back from the run's trace once the
        answer settled. One line until it is opened, and then the whole
        chronology, thinking included, in the same bounded window.
      */}
      {grounded && entry.investigation && (
        <SettledInvestigation
          entryId={entry.id}
          receipt={entry.investigation}
          onOpenRef={onOpenRef}
        />
      )}

      {portion.boundaryUnknown ? (
        <>
          <MessageBody text={entry.text} />
          <span className="interrupted">
            <span className="mark">Interrupted</span>
            <span>Where it stopped was not recorded.</span>
          </span>
        </>
      ) : portion.spokenFormDiffers ? (
        <>
          <MessageBody text={portion.heard ?? ''} />
          <span className="interrupted">
            <span className="mark">Interrupted</span>
            <span>Spoken aloud; the written answer is below.</span>
          </span>
          <div className="unheard">
            <MessageBody text={portion.unheard ?? ''} />
          </div>
        </>
      ) : portion.interrupted ? (
        <>
          <MessageBody text={portion.heard ?? ''} />
          <span className="interrupted">
            <span className="mark">Interrupted</span>
            <span>You did not hear the rest.</span>
          </span>
          {portion.unheard && (
            <div className="unheard">
              <MessageBody text={portion.unheard ?? ''} />
            </div>
          )}
        </>
      ) : (
        <MessageBody text={entry.text} />
      )}
    </>
  );
}

/**
 * How close to the end still counts as being at the end.
 *
 * Generous enough that a line of prose arriving does not count as the reader
 * having scrolled away, and small enough that someone who has genuinely gone
 * up to read an earlier turn is left where they are.
 */
const FOLLOW_WITHIN = 120;

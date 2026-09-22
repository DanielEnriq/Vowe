import { useEffect, useMemo, useRef, type ReactElement } from 'react';

import type {
  ContextRef,
  ConversationDelivery,
  ConversationEntry,
  PresenceProfile,
  WorkerMilestone,
} from '@vowe/core';
import { formatRef } from '@vowe/core/refs';

import {
  buildTimeline,
  deliveredPortion,
  deliveryFor,
  isGroundedAnswer,
  type SpeakerTurn,
} from '../state/conversation.js';
import { OpenIcon } from '../shell/icons.js';
import { Receipt } from './Receipt.js';
import { signatureStyle } from './signature.js';

interface Props {
  entries: ConversationEntry[];
  deliveries: ConversationDelivery[];
  milestones: WorkerMilestone[];
  presence: PresenceProfile;
  userName: string;
  providerLabel: string;
  workbenchOpen: boolean;
  /** An ask is in flight; Vowe is looking into it right now. */
  investigating: boolean;
  onOpenRef: (ref: ContextRef) => void;
}

/**
 * The session's one conversation, read as a column rather than a chat.
 *
 * Editorial treatment: identity is shown once per speaker run, not once per
 * message, and Vowe's mark is a point field drawn from the same profile as the
 * orb rather than an avatar. Worker milestones sit between turns as rules, so
 * the thread stays readable while still saying what happened.
 */
export function Conversation({
  entries,
  deliveries,
  milestones,
  presence,
  userName,
  providerLabel,
  workbenchOpen,
  investigating,
  onOpenRef,
}: Props): ReactElement {
  const scroller = useRef<HTMLDivElement | null>(null);
  const timeline = useMemo(
    () => buildTimeline({ entries, milestones }),
    [entries, milestones],
  );

  // The log rests at the newest turn.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [timeline.length, investigating]);

  return (
    <div className="conversation" ref={scroller}>
      <div className={`conversation-measure${workbenchOpen ? ' with-workbench' : ''}`}>
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

        {investigating && (
          <div className="turn">
            <div className="thinking">
              <span className="signature" style={signatureStyle(presence)} aria-hidden />
              <span className="label">Looking into it…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
          <span className="signature" style={signatureStyle(presence)} aria-hidden />
          <span className="speaker">Vowe</span>
        </div>
      )}

      {turn.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} deliveries={deliveries} onOpenRef={onOpenRef} />
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
      {grounded && entry.investigation && (
        <Receipt receipt={entry.investigation} onOpen={onOpenRef} />
      )}

      {portion.boundaryUnknown ? (
        <>
          <p>{entry.text}</p>
          <span className="interrupted">
            <span className="mark">Interrupted</span>
            <span>Where it stopped was not recorded.</span>
          </span>
        </>
      ) : portion.spokenFormDiffers ? (
        <>
          <p>{portion.heard}</p>
          <span className="interrupted">
            <span className="mark">Interrupted</span>
            <span>Spoken aloud; the written answer is below.</span>
          </span>
          <p className="unheard">{portion.unheard}</p>
        </>
      ) : portion.interrupted ? (
        <>
          <p>{portion.heard}</p>
          <span className="interrupted">
            <span className="mark">Interrupted</span>
            <span>You did not hear the rest.</span>
          </span>
          {portion.unheard && <p className="unheard">{portion.unheard}</p>}
        </>
      ) : (
        <p>{entry.text}</p>
      )}

      {grounded && entry.refs && entry.refs.length > 0 && (
        <div className="artifact-links">
          {entry.refs.slice(0, 3).map((ref) => (
            <button
              className="artifact-link"
              type="button"
              key={formatRef(ref)}
              onClick={() => onOpenRef(ref)}
            >
              <OpenIcon />
              {shortLabel(ref)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** `↗ ask.ts · 84` — the address, at the length a line can hold. */
function shortLabel(ref: ContextRef): string {
  switch (ref.kind) {
    case 'repo':
      return `${base(ref.path)}${ref.line ? ` · ${ref.line}` : ''}`;
    case 'diff':
      return ref.path ? `${base(ref.path)} · diff` : 'working diff';
    case 'window':
      return 'worker activity';
    case 'trace':
      return `trace ${ref.startSeq}–${ref.endSeq}`;
    case 'event':
    case 'transcript':
      return 'worker activity';
    case 'symbol':
      return ref.nodeId;
    case 'lesson':
      return 'project memory';
  }
}

const base = (path: string): string => path.split('/').pop() ?? path;

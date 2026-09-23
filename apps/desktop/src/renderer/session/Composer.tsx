import { useEffect, useRef, useState, type ReactElement } from 'react';

import type {
  AgentSession,
  ContextRef,
  PresenceProfile,
  PresenceState,
} from '@vowe/core';
import { formatRef } from '@vowe/core/refs';

import {
  composerKeyAction,
  resolveDestination,
  shouldOfferWorker,
  type Destination,
} from '../state/composer.js';
import { Fading } from '../shell/Fading.js';
import { ChevronDownIcon, CloseIcon, DiffIcon, FileIcon, PlusIcon, SendIcon } from '../shell/icons.js';
import { VowePresence } from '../presence/index.js';

export interface Attachment {
  ref: ContextRef;
  label: string;
}

interface Props {
  session: AgentSession | null;
  providerLabel: string;
  busy: boolean;
  /** What the workbench is showing, so it can be attached explicitly. */
  viewing: Attachment | null;
  /**
   * Held by the room rather than here, because the workbench can add to it
   * too — "Add to question" over there has to reach the same list as the `+`
   * in here, and two copies of that list would disagree.
   */
  attachments: Attachment[];
  onAttach: (attachment: Attachment) => void;
  onRemoveAttachment: (ref: ContextRef) => void;
  onAsk: (question: string, refs: ContextRef[]) => void;
  onInstruct: (text: string) => void;
  /** Vowe, drawn beside send: the way into a call from where you are typing. */
  presence: PresenceProfile;
  presenceState: PresenceState;
  inVoice: boolean;
  voiceUnavailableReason: string | null;
  /** Real work, when something measured it. See `VowePresence`. */
  activity: number | undefined;
  onToggleVoice: () => void;
}

/**
 * How long a pointer has to stay before Vowe stirs.
 *
 * Long enough that crossing the button on the way to send does nothing — the
 * motion is an answer to attention, and a pointer passing through is not that.
 */
const DWELL_MS = 380;

/**
 * How much Vowe moves when you rest on it.
 *
 * The same motion it makes while it works, turned down: this is the presence
 * acknowledging you, not reporting that anything is happening. A level, not an
 * impulse, because nothing has happened to decay from.
 */
const DWELL_ACTIVITY = 0.22;

/**
 * One composer, with a destination rather than a mode.
 *
 * The distinction this enforces is the whole point: talking *about* the worker
 * and talking *to* it are different acts, reached by two different paths, and
 * an imperative typed at Vowe is never quietly forwarded. At most it earns an
 * offer — and only when the worker could actually receive it.
 */
export function Composer({
  session,
  providerLabel,
  busy,
  viewing,
  attachments,
  onAttach,
  onRemoveAttachment,
  onAsk,
  onInstruct,
  presence,
  presenceState,
  inVoice,
  voiceUnavailableReason,
  activity,
  onToggleVoice,
}: Props): ReactElement {
  /*
   * Vowe stirs when you rest on it.
   *
   * A timer rather than `:hover`, because the motion should answer attention
   * rather than every pointer that crosses the button on its way to send.
   */
  const [dwelling, setDwelling] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopDwell = () => {
    if (dwell.current) clearTimeout(dwell.current);
    dwell.current = null;
    setDwelling(false);
  };
  useEffect(() => stopDwell, []);

  const canTalk = voiceUnavailableReason === null;
  /*
   * Real work wins over a hover. While Vowe is actually doing something the
   * presence reports that; resting on it must not overwrite the report with a
   * politer one.
   */
  const orbActivity =
    activity !== undefined || dwelling
      ? Math.max(activity ?? 0, dwelling ? DWELL_ACTIVITY : 0)
      : undefined;
  const [draft, setDraft] = useState('');
  const [requested, setRequested] = useState<Destination>('vowe');
  const [menu, setMenu] = useState<'none' | 'context' | 'destination'>('none');
  const area = useRef<HTMLTextAreaElement | null>(null);

  const destination = resolveDestination(requested, session);
  const toWorker = destination.effective === 'worker';
  const offer = shouldOfferWorker(draft, destination);

  const attach = (attachment: Attachment) => {
    onAttach(attachment);
    setMenu('none');
  };

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (toWorker) {
      onInstruct(text);
    } else {
      onAsk(
        text,
        attachments.map((item) => item.ref),
      );
    }
    setDraft('');
    for (const attachment of attachments) onRemoveAttachment(attachment.ref);
    if (area.current) area.current.style.height = 'auto';
  };

  return (
    <div className="composer-dock">
      <div className={`composer${toWorker ? ' to-worker' : ''}`}>
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((attachment) => (
              <span className="chip" key={formatRef(attachment.ref)}>
                <FileIcon />
                {attachment.label}
                <button
                  type="button"
                  aria-label={`Remove ${attachment.label}`}
                  onClick={() => onRemoveAttachment(attachment.ref)}
                >
                  <CloseIcon size={9} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={area}
          rows={1}
          value={draft}
          aria-label={toWorker ? `Instruct ${providerLabel}` : 'Ask Vowe about this work'}
          placeholder={
            toWorker ? `Give ${providerLabel} an instruction…` : 'Ask about this work…'
          }
          onChange={(event) => {
            setDraft(event.target.value);
            const element = event.target;
            element.style.height = 'auto';
            element.style.height = `${Math.min(150, element.scrollHeight)}px`;
          }}
          onKeyDown={(event) => {
            // Newline is the textarea's own behaviour, so only sending needs
            // the default suppressed.
            if (composerKeyAction(event) !== 'send') return;
            event.preventDefault();
            send();
          }}
        />

        <div className="composer-row">
          <button
            className="round-button"
            type="button"
            aria-label="Add context"
            title="Add context"
            onClick={() => setMenu((open) => (open === 'context' ? 'none' : 'context'))}
          >
            <PlusIcon />
          </button>

          <button
            className={`destination${toWorker ? ' to-worker' : ''}`}
            type="button"
            aria-label="Choose who this goes to"
            onClick={() => setMenu((open) => (open === 'destination' ? 'none' : 'destination'))}
          >
            {toWorker ? providerLabel : 'Vowe'}
            <ChevronDownIcon />
          </button>

          {/*
            Viewing something is not attaching it. The workbench is where
            attention is; the composer's context is what the question carries,
            and the developer says which explicitly.
          */}
          {viewing && !attachments.some((item) => formatRef(item.ref) === formatRef(viewing.ref)) && (
            <span className="viewing">
              <Fading>Viewing {viewing.label}</Fading>
              <button type="button" onClick={() => attach(viewing)}>
                Add
              </button>
            </span>
          )}

          <span style={{ flex: 1 }} />

          {/*
            Voice, where you are already writing to Vowe.

            The same entity that used to sit by the session's title, moved to
            the one place in the room that is already addressed to it. Clicking
            joins or ends the call: voice is a state of this room, not a
            separate product, so there is no modal and nothing to dismiss.
          */}
          <button
            className={`talk${inVoice ? ' in-voice' : ''}`}
            type="button"
            aria-label={inVoice ? 'End the call with Vowe' : 'Talk to Vowe'}
            title={inVoice ? 'End' : (voiceUnavailableReason ?? 'Talk to Vowe')}
            disabled={!canTalk}
            onClick={onToggleVoice}
            onPointerEnter={() => {
              if (!canTalk) return;
              dwell.current = setTimeout(() => setDwelling(true), DWELL_MS);
            }}
            onPointerLeave={stopDwell}
            onBlur={stopDwell}
          >
            <VowePresence
              state={presenceState}
              profile={presence}
              size="signature"
              activity={orbActivity}
            />
          </button>

          <span className="shortcut">↩</span>
          <button
            className={`send${toWorker ? ' to-worker' : ''}`}
            type="button"
            aria-label={toWorker ? `Send to ${providerLabel}` : 'Ask Vowe'}
            title={toWorker ? `Send to ${providerLabel}` : 'Ask Vowe'}
            disabled={!draft.trim() || busy}
            onClick={send}
          >
            <SendIcon />
          </button>
        </div>

        {menu === 'context' && (
          <div className="menu context">
            <span className="menu-label">Add context</span>
            <button
              type="button"
              onClick={() => {
                void window.vowe.chooseFile().then((path) => {
                  if (path) attach({ ref: { kind: 'repo', path }, label: base(path) });
                });
              }}
            >
              <FileIcon />
              File
            </button>
            <button
              type="button"
              disabled={!session}
              onClick={() =>
                session &&
                attach({
                  ref: { kind: 'diff', sessionId: session.id },
                  label: 'current diff',
                })
              }
            >
              <DiffIcon />
              Current diff
            </button>
          </div>
        )}

        {menu === 'destination' && (
          <div className="menu destination-menu">
            <button
              className="stacked"
              type="button"
              onClick={() => {
                setRequested('vowe');
                setMenu('none');
              }}
            >
              <span className="title">Vowe</span>
              <span className="what">
                Ask about the work. Nothing is sent to {providerLabel}.
              </span>
            </button>
            <button
              className="stacked"
              type="button"
              disabled={!destination.workerAvailable}
              onClick={() => {
                setRequested('worker');
                setMenu('none');
              }}
            >
              <span className="title">{providerLabel}</span>
              <span className="what">
                {destination.workerUnavailableReason ?? 'Send an instruction to the worker.'}
              </span>
            </button>
          </div>
        )}
      </div>

      {offer && (
        <div className="offer">
          <span>
            This reads like an instruction for {providerLabel}. Vowe will not pass it on
            unless you say so.
          </span>
          <button type="button" onClick={() => setRequested('worker')}>
            Send to {providerLabel}
          </button>
        </div>
      )}
    </div>
  );
}

const base = (path: string): string => path.split('/').pop() ?? path;

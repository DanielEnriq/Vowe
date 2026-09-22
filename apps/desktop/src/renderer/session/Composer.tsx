import { useRef, useState, type ReactElement } from 'react';

import type { AgentSession, ContextRef } from '@vowe/core';
import { formatRef } from '@vowe/core/refs';

import {
  composerKeyAction,
  resolveDestination,
  shouldOfferWorker,
  type Destination,
} from '../state/composer.js';
import { Fading } from '../shell/Fading.js';
import { ChevronDownIcon, CloseIcon, DiffIcon, FileIcon, PlusIcon, SendIcon } from '../shell/icons.js';

export interface Attachment {
  ref: ContextRef;
  label: string;
}

interface Props {
  session: AgentSession | null;
  providerLabel: string;
  narrow: boolean;
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
}

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
  narrow,
  busy,
  viewing,
  attachments,
  onAttach,
  onRemoveAttachment,
  onAsk,
  onInstruct,
}: Props): ReactElement {
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
      <div className={`composer${narrow ? ' narrow' : ''}${toWorker ? ' to-worker' : ''}`}>
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
        <div className={`offer${narrow ? ' narrow' : ''}`}>
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

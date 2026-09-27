import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactElement } from 'react';

import { formatRef } from '@vowe/core/refs';

import type { Attachment } from '../session/Composer.js';
import { composerKeyAction } from '../state/composer.js';
import { CloseIcon, SendIcon } from '../shell/icons.js';

interface Props {
  draft: string;
  working: boolean;
  disabled: boolean;
  error: string | null;
  /** What Vowe is doing, in words, while it works. */
  status: string | null;
  viewing: Attachment | null;
  attachments: Attachment[];
  /** What is selected on the canvas, first chosen first: what "this" or "these" mean. */
  about: { id: string; label: string }[];
  variant: 'opening' | 'docked' | 'floating';
  placeholder: string;
  onDraft: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Let go of one selected element, or all of them with null. */
  onClearAbout: (id: string | null) => void;
  onAttach: (item: Attachment) => void;
  onDetach: (item: Attachment) => void;
}

/** How many selected elements are named before the rest are counted. */
const ABOUT_SHOWN = 3;

export interface ComposerHandle {
  focus: () => void;
  element: () => HTMLElement | null;
}

/**
 * The Studio composer: Ask's shape, with what "this" is, Stop while Vowe is
 * working, and one quiet line saying what it is doing. The same composer
 * opens the room, sits under the conversation, and floats over the design
 * when the conversation is put away.
 */
export const StudioComposer = forwardRef<ComposerHandle, Props>(function StudioComposer({
  draft, working, disabled, error, status, viewing, attachments, about, variant, placeholder,
  onDraft, onSend, onStop, onClearAbout, onAttach, onDetach,
}, handle): ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useImperativeHandle(handle, () => ({
    focus: () => {
      const element = field.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    },
    element: () => box.current,
  }), []);
  useEffect(() => {
    if (!field.current) return;
    field.current.style.height = 'auto';
    field.current.style.height = `${Math.min(160, field.current.scrollHeight)}px`;
  }, [draft]);
  const canAttach = viewing && !attachments.some((item) => formatRef(item.ref) === formatRef(viewing.ref));
  return (
    <div ref={box} className={`project-ask studio-ask ${variant}${about.length ? ' pointing' : ''}`}>
      {(about.length > 0 || canAttach || attachments.length > 0) && (
        <div className="studio-ask-context">
          {about.length > 0 && (
            <span className={`studio-about-set${about.length > 1 ? ' several' : ''}`} role="group" aria-label={about.length > 1 ? `${about.length} selected` : 'Selected'}>
              {about.slice(0, ABOUT_SHOWN).map((element) => (
                <button key={element.id} type="button" className="studio-about" title={`Stop pointing at ${element.label}`} onClick={() => onClearAbout(element.id)}>
                  <span className="dot" aria-hidden="true" />
                  <span className="name">{element.label}</span>
                  <CloseIcon size={11} />
                </button>
              ))}
              {about.length > ABOUT_SHOWN && (
                <span className="studio-about more" title={about.slice(ABOUT_SHOWN).map((element) => element.label).join(', ')}>
                  +{about.length - ABOUT_SHOWN}
                </span>
              )}
              {about.length > 1 && (
                <button type="button" className="link-button studio-about-clear" onClick={() => onClearAbout(null)}>Clear</button>
              )}
            </span>
          )}
          {canAttach && (
            <button className="link-button" type="button" onClick={() => onAttach(viewing)}>Add {viewing.label}</button>
          )}
          {attachments.map((item) => (
            <button className="small-button" type="button" key={formatRef(item.ref)} title={`Remove ${item.label}`} onClick={() => onDetach(item)}>
              {item.label}<CloseIcon />
            </button>
          ))}
        </div>
      )}
      <div className="ask-field">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Message Vowe in Studio"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (composerKeyAction(event) !== 'send') return;
            event.preventDefault();
            onSend();
          }}
        />
        {working ? (
          <button className="link-button studio-stop" type="button" onClick={onStop}>Stop</button>
        ) : (
          <button className="send" type="button" aria-label="Send" title="Send" disabled={disabled || !draft.trim()} onClick={onSend}>
            <SendIcon />
          </button>
        )}
      </div>
      {(status || error) && (
        <div className="studio-ask-foot">
          {error ? <span className="fine" role="alert">{error}</span> : <span className="studio-status" role="status">{status}</span>}
        </div>
      )}
    </div>
  );
});

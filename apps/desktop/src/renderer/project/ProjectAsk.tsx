import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { formatRef } from '@vowe/core/refs';
import type { Attachment } from '../session/Composer.js';
import { composerKeyAction } from '../state/composer.js';
import { SendIcon, CloseIcon } from '../shell/icons.js';

interface Props {
  voiceControl?: ReactNode;
  draft: string;
  asking: boolean;
  error: string | null;
  viewing: Attachment | null;
  attachments: Attachment[];
  onDraft: (draft: string) => void;
  onSend: () => void;
  onAttach: (attachment: Attachment) => void;
  onDetach: (attachment: Attachment) => void;
}

/** One draft follows the user between Home and conversation. Viewing is not attaching. */
export function ProjectAsk({ voiceControl, draft, asking, error, viewing, attachments, onDraft,
  onSend, onAttach, onDetach }: Props): ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!field.current) return;
    field.current.style.height = 'auto';
    field.current.style.height = `${Math.min(120, field.current.scrollHeight)}px`;
  }, [draft]);
  const canAttach = viewing && !attachments.some((item) => formatRef(item.ref) === formatRef(viewing.ref));
  return (
    <div className="project-ask">
      {canAttach && <div className="project-viewing">
        <span>On your desk · {viewing.label}</span>
        <button className="link-button" type="button" onClick={() => onAttach(viewing)}>Add to question</button>
      </div>}
      {attachments.length > 0 && <div className="project-attachments" aria-label="Attached to question">
        {attachments.map((item) => <button className="small-button" type="button" key={formatRef(item.ref)}
          title={`Remove ${item.label} from question`} onClick={() => onDetach(item)}>
          {item.label}<CloseIcon />
        </button>)}
      </div>}
      <div className="ask-field">
        <textarea ref={field} rows={1} value={draft} placeholder="Ask Vowe about this project…"
          aria-label="Ask Vowe about this project" onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (composerKeyAction(event) !== 'send') return;
            event.preventDefault();
            onSend();
          }} />
        {voiceControl}
        <button className="send" type="button" aria-label="Ask Vowe" title="Ask Vowe"
          disabled={!draft.trim() || asking} onClick={onSend}><SendIcon /></button>
      </div>
      {error && <span className="fine" role="alert">{error}</span>}
    </div>
  );
}

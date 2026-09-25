import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import type { ContextRef, ConversationDelivery, PresenceProfile, ProjectConversationEntry } from '@vowe/core';
import type { LiveInvestigation as InvestigationState } from '../hooks/useVoweData.js';
import { useActivityImpulse } from '../presence/index.js';
import { LiveInvestigation } from '../session/LiveInvestigation.js';
import { SettledInvestigation } from '../session/SettledInvestigation.js';
import { MessageBody } from '../session/MessageBody.js';

interface Props {
  entries: ProjectConversationEntry[];
  deliveries: ConversationDelivery[];
  voice: ReactNode;
  live: InvestigationState;
  asking: boolean;
  entryId: string | undefined;
  presence: PresenceProfile;
  composer: ReactNode;
  onHome: () => void;
  onSelectEntry: (id: string | undefined) => void;
  onOpenRef: (ref: ContextRef) => void;
}

/** The existing durable thread, with question anchors rather than invented chat records. */
export function ProjectConversation({ entries, deliveries, voice, live, asking, entryId, presence, composer,
  onHome, onSelectEntry, onOpenRef }: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const turns = useRef(new Map<string, HTMLDivElement>());
  const follow = useRef(!entryId);
  const located = useRef<string | undefined>(undefined);
  const activity = useActivityImpulse(live.beat, live.active);
  const questions = entries.filter((entry) => (entry.role === 'user_question' || entry.role === 'user_message'));
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (entryId && located.current !== entryId) {
      const turn = turns.current.get(entryId);
      if (!turn) return;
      element.scrollTop += turn.getBoundingClientRect().top - element.getBoundingClientRect().top - 24;
      follow.current = false;
      located.current = entryId;
    } else if (!entryId && located.current) {
      located.current = undefined;
      follow.current = true;
    }
    if (follow.current) element.scrollTop = element.scrollHeight;
  }, [entries, live, asking, entryId]);

  return <div className="project-conversation conversation-column">
    <nav className="project-conversation-nav" aria-label="Project conversation">
      <button className="link-button" type="button" onClick={onHome}>← Project</button>
      {questions.length > 0 && <select aria-label="Conversation history" value={entryId ?? ''}
        onChange={(event) => onSelectEntry(event.target.value || undefined)}>
        <option value="">Conversation history · {questions.length}</option>
        {[...questions].reverse().map((question) => <option key={question.id} value={question.id}>
          {new Date(question.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {question.text.slice(0, 100)}
        </option>)}
      </select>}
    </nav>
    <div className="conversation" ref={scroller} onScroll={() => {
      const element = scroller.current;
      if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    }}>
      <div className="conversation-measure">
        {entries.length === 0 && !asking && !live.active && <p className="empty">Ask about the project. Your conversation stays here.</p>}
        {entries.map((entry) => <div key={entry.id}
          ref={(node) => { if (node) turns.current.set(entry.id, node); else turns.current.delete(entry.id); }}
          className={`turn${(entry.role === 'user_question' || entry.role === 'user_message') ? ' user' : ''}`}>
          <span className="speaker">{(entry.role === 'user_question' || entry.role === 'user_message') ? 'You' : 'Vowe'}</span>
          {entry.role === 'companion_answer' && entry.investigation &&
            <SettledInvestigation entryId={entry.id} receipt={entry.investigation} onOpenRef={onOpenRef} />}
          <MessageBody text={entry.text} />
          {entry.origin?.kind === 'live_turn' && <span className="fine">Voice</span>}
          {deliveries.filter((delivery) => delivery.entryId === entry.id && delivery.modality === 'voice').slice(-1).map((delivery) =>
            <span className="fine" key={delivery.id}>{delivery.status === 'interrupted' ? 'Voice · interrupted' :
              delivery.status === 'cancelled' ? 'Voice · playback ended early' : delivery.status === 'started' ? 'Voice · delivery incomplete' : 'Spoken'}</span>)}
        </div>)}
        {(asking || live.active || live.answer.length > 0) &&
          <LiveInvestigation live={live} presence={presence} activity={activity} onOpenRef={onOpenRef} />}
      </div>
    </div>
    <div className="project-composer-dock"><div className="conversation-measure">{voice}{composer}</div></div>
  </div>;
}

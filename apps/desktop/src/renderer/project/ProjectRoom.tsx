import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { ContextRef, PresenceProfile, PresenceState, ProjectBrief, ProjectSessionSummary } from '@vowe/core';
import { Fading } from '../shell/Fading.js';
import { useActivityImpulse, VowePresence } from '../presence/index.js';
import { formatAgo, ProviderGlyph, providerName } from '../components/ui.js';
import { VoweMark } from '../session/VoweMark.js';
import { workItemFor } from '../state/project-work.js';
import type { ProjectChange } from '../state/project-home.js';

interface Props {
  brief: ProjectBrief | null;
  changes: ProjectChange[];
  presence: PresenceProfile;
  presenceState: PresenceState;
  composer: ReactNode;
  voice?: ReactNode;
  investigation?: ReactNode;
  activity?: number | undefined;
  hasConversation: boolean;
  investigating: boolean;
  onOpenConversation: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRef: (ref: ContextRef) => void;
}

/** The living home. Conversation and its scroll position belong elsewhere. */
export function ProjectRoom({ brief, changes, presence, presenceState, composer, voice, investigation, activity,
  hasConversation, investigating, onOpenConversation, onOpenSession, onOpenRef }: Props): ReactElement {
  const latest = brief?.active.length === 0 ? brief.recent[0] : null;
  return (
    <div className="project-home scroll">
      <div className="project-home-measure">
        <section className="project-orientation">
          <VowePresence state={presenceState} profile={presence} size="project" activity={activity} />
          <div className="reading">
            <p className="headline">{brief?.headline ?? 'Reading the project…'}</p>
            {latest?.currentUnderstanding && (
              <div className="project-last-understanding">
                <button type="button" className="link-button" onClick={() => onOpenSession(latest.sessionId)}>
                  {latest.title}
                </button>
                <p>{latest.currentUnderstanding}</p>
                <span className="fine">Last active {formatAgo(latest.lastActivityAt)}</span>
              </div>
            )}
          </div>
        </section>
        {voice}
        {investigation}
        <NeedsYou brief={brief} onOpenSession={onOpenSession} />
        {brief && brief.active.length > 0 && <CurrentWork brief={brief} presence={presence} onOpen={onOpenSession} />}
        {changes.length > 0 && (
          <section className="project-changes">
            <h2>What changed</h2>
            {changes.map((change) => (
              <button className="project-change" type="button" key={change.id}
                onClick={() => change.ref ? onOpenRef(change.ref) : change.sessionId && onOpenSession(change.sessionId)}>
                <span className="change-title">{change.title}</span>
                <time title={new Date(change.at).toLocaleString()} dateTime={change.at}>{formatAgo(change.at)}</time>
                <span className="change-text">{change.text}</span>
              </button>
            ))}
          </section>
        )}
        <div className="project-home-ask">
          {brief && <KnowledgeChip status={brief.knowledge.status} at={brief.knowledge.updatedAt} />}
          {composer}
          {(hasConversation || investigating) && (
            <button className="link-button project-resume" type="button" onClick={onOpenConversation}>
              {investigating ? 'Vowe is looking into your question →' : 'Open conversation →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NeedsYou({
  brief,
  onOpenSession,
}: {
  brief: ProjectBrief | null;
  onOpenSession: (sessionId: string) => void;
}): ReactElement | null {
  const items = brief?.needsAttention ?? [];

  if (items.length === 0) return null;

  return (
    <section className="section">
      <h2 className="attention">Needs you</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item) => (
          <div className="attention-card" key={item.id}>
            <div className="top">
              <span className="dot lg waiting" aria-hidden />
              <span className="title">{titleOf(brief, item.sessionId)}</span>
              <span className="waiting">
                {item.kind === 'permission' ? 'Waiting for permission' : 'Waiting on your decision'}
              </span>
            </div>
            <p>{item.summary}</p>
            <div className="actions">
              {/*
                Open session, not Approve once. Answering a permission prompt
                needs a provider control contract that does not exist, and a
                button that looked like it worked would be the worst kind.
              */}
              <button className="button" type="button" onClick={() => onOpenSession(item.sessionId)}>
                Open session
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--ink-6)' }}>
                {formatAgo(item.createdAt)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CurrentWork({
  brief,
  presence,
  onOpen,
}: {
  brief: ProjectBrief;
  presence: PresenceProfile;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  return (
    <div className="current-work">
      <h2>Current work</h2>
      <div className="work-list">
        {brief.active.map((session) => (
          <WorkLine key={session.sessionId} session={session} presence={presence} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function WorkLine({
  session,
  presence,
  onOpen,
}: {
  session: ProjectSessionSummary;
  presence: PresenceProfile;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  const item = workItemFor(session);
  useEffect(() => {
    // Opening Current Work follows its real workers through the existing observer.
    void window.vowe.startObserving(session.sessionId).catch(() => undefined);
  }, [session.sessionId]);
  const beat = useWorkerBeat(session.sessionId);
  const activity = useActivityImpulse(beat, item.presence === 'observing');

  return (
    <button
      className={`work-line${item.needsYou ? ' needs-you' : ''}`}
      type="button"
      onClick={() => onOpen(item.sessionId)}
    >
      <Fading className="title">{item.title}</Fading>
      <span className="meta">
        <ProviderGlyph provider={session.provider} size={12} />
        <span>
          {[providerName(session.provider), formatAgo(session.lastActivityAt)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className={`doing${item.interpreted ? '' : ' plain'}`}>
        <VoweMark profile={presence} state={item.presence} activity={activity} />
        <Fading className="text">{item.line}</Fading>
      </span>
      {item.understanding && <span className="understanding">{item.understanding}</span>}
    </button>
  );
}

/**
 * The worker's own events, as a beat the mark can move to.
 *
 * The one live signal the renderer already receives per session: every
 * normalized event the adapter records arrives on `onSessionEvent`. The mark's
 * state still comes from status; this only says how much is happening now, so
 * a worker that has gone quiet between tool calls settles within a second.
 */
function useWorkerBeat(sessionId: string): number {
  const [beat, setBeat] = useState(0);
  useEffect(
    () =>
      window.vowe.onSessionEvent((event) => {
        if (event.sessionId === sessionId) setBeat((value) => value + 1);
      }),
    [sessionId],
  );
  return beat;
}

function KnowledgeChip({ status, at }: { status: string; at?: string }): ReactElement | null {
  const text: Record<string, string> = {
    ready: 'Vowe knows this repository',
    stale: 'Vowe knows this repository · refreshing',
    indexing: 'Reading this repository',
    error: 'Vowe could not read this repository',
  };
  const label = text[status];
  if (!label) return null;

  return (
    <span className="knows">
      <span className={`dot ${status === 'ready' ? 'working' : 'idle'}`} aria-hidden />
      {label}
      {status === 'ready' && at ? ` · updated ${formatAgo(at)}` : ''}
    </span>
  );
}

function titleOf(brief: ProjectBrief | null, sessionId: string): string {
  const found = [...(brief?.active ?? []), ...(brief?.recent ?? [])].find(
    (session) => session.sessionId === sessionId,
  );
  return found?.title ?? 'This session';
}

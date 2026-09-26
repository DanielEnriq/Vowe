import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';

import type { ContextRef, PresenceProfile, Project } from '@vowe/core';
import { formatRef } from '@vowe/core/refs';

import { useDesign, useDesigns, useStudioTurn } from '../hooks/useVoweData.js';
import { useActivityImpulse } from '../presence/index.js';
import { LiveInvestigation } from '../session/LiveInvestigation.js';
import { MessageBody } from '../session/MessageBody.js';
import { SettledInvestigation } from '../session/SettledInvestigation.js';
import type { Attachment } from '../session/Composer.js';
import { Fading } from '../shell/Fading.js';
import { PanelToggle } from '../shell/PanelToggle.js';
import { RoomActions, RoomIdentity } from '../shell/TopChrome.js';
import { tildePath } from '../components/ui.js';
import { projectRef } from '../state/project-home.js';
import { designPaneView, unanswered } from '../state/studio.js';
import { activeTab, EMPTY_WORKBENCH, workbenchReducer } from '../state/workbench.js';
import { composerKeyAction } from '../state/composer.js';
import { SendIcon, CloseIcon } from '../shell/icons.js';
import { Workbench } from '../workbench/Workbench.js';
import { DesignPane } from './DesignPane.js';

interface Props {
  project: Project;
  presence: PresenceProfile;
  /** The design in view; absent means the most recently active one. */
  designId: string | undefined;
  narrow: boolean;
  /** False when no model is configured. Studio says so rather than pretending. */
  available: boolean;
  onSelectDesign: (designId: string | undefined) => void;
  onHome: () => void;
  onOpenSession: (sessionId: string) => void;
}

/**
 * STUDIO — what should this system become?
 *
 * The conversation on the left and the living design on the right: the design
 * is the primary object, and the conversation is how it moves. When Vowe needs
 * a fact about the implementation it checks the repository — quietly, as one
 * Vowe — and the files it rests on descend into the Workbench, which takes the
 * design's place until you come back to it.
 *
 * Nothing here is project truth. What is said and drafted in Studio stays in
 * Studio: it is not project memory, and Project Ask does not see it.
 */
export function StudioSpace({ project, presence, designId, narrow, available, onSelectDesign, onHome, onOpenSession }: Props): ReactElement {
  const { designs, loaded } = useDesigns(project.id);
  const activeId = designId ?? designs[0]?.id ?? null;
  // A design that no longer exists falls back to the most recent one — but not
  // one created a moment ago, which the list has simply not caught up with.
  const created = useRef(new Set<string>());
  useEffect(() => {
    if (!designId || !loaded || created.current.has(designId)) return;
    if (!designs.some((design) => design.id === designId)) onSelectDesign(undefined);
  }, [designId, designs, loaded, onSelectDesign]);
  const view = useDesign(activeId);
  const entries = useMemo(() => (view?.design.id === activeId ? view.entries : []), [view, activeId]);
  const revisions = useMemo(() => (view?.design.id === activeId ? view.revisions : []), [view, activeId]);
  const entryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const turn = useStudioTurn(activeId, entryIds, revisions);
  const working = (view?.inFlight ?? false) || turn.live.active;
  const activity = useActivityImpulse(turn.live.beat, turn.live.active);

  const [viewingOrd, setViewingOrd] = useState<number | null>(null);
  // A new design, or a new revision arriving, brings the current one back.
  useEffect(() => setViewingOrd(null), [activeId, revisions.length]);
  const pane = designPaneView(revisions, turn.design, viewingOrd);

  const [desk, dispatch] = useReducer(workbenchReducer, EMPTY_WORKBENCH);
  const deskShown = desk.open && desk.tabs.length > 0;
  const [narrowShows, setNarrowShows] = useState<'conversation' | 'design'>('conversation');
  const [error, setError] = useState<string | null>(null);

  const openRef = useCallback(async (ref: ContextRef) => {
    try {
      const artifact = await window.vowe.openArtifact(projectRef(ref, project.repoRoot));
      dispatch({ type: 'open', artifact });
      dispatch({ type: 'setOpen', open: true });
      setNarrowShows('design');
      setError(null);
    } catch {
      setError('That evidence could not be opened.');
    }
  }, [project.repoRoot]);

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const sending = useRef(false);
  const active = activeTab(desk);
  const viewing: Attachment | null = deskShown && active ? { ref: active.sourceRef, label: active.title } : null;

  const send = async () => {
    const message = draft.trim();
    if (!message || sending.current || working || !available) return;
    sending.current = true;
    setError(null);
    const submitted = attachments;
    setDraft('');
    setAttachments([]);
    try {
      let target = activeId;
      if (!target) {
        const design = await window.vowe.createDesign(project.id);
        target = design.id;
        created.current.add(target);
        onSelectDesign(target);
      }
      await window.vowe.converseDesign(target, message, submitted.map((item) => item.ref));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause));
      setDraft((current) => current || message);
      setAttachments((current) => (current.length ? current : submitted));
    } finally {
      sending.current = false;
    }
  };

  const newDesign = async () => {
    if (!available) return;
    try {
      const design = await window.vowe.createDesign(project.id);
      created.current.add(design.id);
      onSelectDesign(design.id);
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Follow the conversation's tail unless the developer has scrolled away.
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [entries, turn]);
  useEffect(() => { follow.current = true; }, [activeId]);

  const single = narrow;
  const showConversation = !single || narrowShows === 'conversation';
  const showRight = !single || narrowShows === 'design';

  return (
    <main className={`studio-room${single ? ' single' : ''}`}>
      <RoomIdentity>
        <div className="stack">
          <Fading as="h1">{project.name}</Fading>
          <Fading className="meta" title={tildePath(project.repoRoot)}>
            Studio
          </Fading>
        </div>
      </RoomIdentity>

      {showConversation && (
        <section className="studio-conversation" aria-label="Design conversation">
          <nav className="studio-nav" aria-label="Studio">
            <button className="link-button" type="button" onClick={onHome}>← Project</button>
            <span className="studio-nav-designs">
              {designs.length > 1 && (
                <select aria-label="Designs" value={activeId ?? ''} onChange={(event) => onSelectDesign(event.target.value || undefined)}>
                  {designs.map((design) => (
                    <option key={design.id} value={design.id}>{design.title}</option>
                  ))}
                </select>
              )}
              {available && activeId && (
                <button className="link-button" type="button" disabled={working} onClick={() => void newDesign()}>
                  New design
                </button>
              )}
            </span>
          </nav>

          <div
            className="conversation studio-thread"
            ref={scroller}
            onScroll={() => {
              const element = scroller.current;
              if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
            }}
          >
            <div className="studio-measure">
              {!available ? (
                <div className="studio-opening">
                  <p className="studio-question">What should this system become?</p>
                  <p className="fine">Studio needs a model configured. Add a key to <code>.env</code> and restart Vowe.</p>
                </div>
              ) : loaded && entries.length === 0 && !working ? (
                <div className="studio-opening">
                  <p className="studio-question">What should this system become?</p>
                  <p className="studio-hint">
                    Think out loud about the design. Vowe keeps it written down beside you, and checks the
                    repository when an implementation fact matters. Nothing here becomes project truth.
                  </p>
                </div>
              ) : null}

              {entries.map((entry) => (
                <div key={entry.id} className={`turn${entry.role === 'user_message' ? ' user' : ''}`}>
                  <span className="speaker">{entry.role === 'user_message' ? 'You' : 'Vowe'}</span>
                  {entry.investigation && (
                    <SettledInvestigation entryId={entry.id} receipt={entry.investigation} onOpenRef={(ref) => void openRef(ref)} />
                  )}
                  <MessageBody text={entry.text} {...(entry.role === 'companion_message' ? { onOpenRef: (ref: ContextRef) => void openRef(ref) } : {})} />
                </div>
              ))}

              {(turn.live.active || turn.live.answer.length > 0 || turn.consulting) && (
                <LiveInvestigation
                  live={turn.live}
                  presence={presence}
                  activity={activity}
                  gathering={turn.consulting !== null}
                  onOpenRef={(ref) => void openRef(ref)}
                  pending={turn.consulting && (
                    <div className="consult-pending" role="status">
                      <span className="label">Checking the repository: {turn.consulting.question}</span>
                      {turn.consulting.activity && <span className="check-detail">{turn.consulting.activity}</span>}
                    </div>
                  )}
                />
              )}

              {unanswered(entries, working) && (
                <p className="fine studio-unanswered">Vowe didn’t finish replying to this.</p>
              )}
            </div>
          </div>

          <div className="studio-composer">
            <div className="studio-measure">
              <StudioComposer
                draft={draft}
                working={working}
                disabled={!available}
                error={error}
                viewing={viewing}
                attachments={attachments}
                placeholder={entries.length === 0 ? 'What are we designing?' : 'Think with Vowe…'}
                onDraft={setDraft}
                onSend={() => void send()}
                onStop={() => { if (activeId) void window.vowe.cancelDesignTurn(activeId); }}
                onAttach={(item) => setAttachments((list) => list.some((other) => formatRef(other.ref) === formatRef(item.ref)) ? list : [...list, item])}
                onDetach={(item) => setAttachments((list) => list.filter((other) => formatRef(other.ref) !== formatRef(item.ref)))}
              />
            </div>
          </div>
        </section>
      )}

      {showRight && (deskShown ? (
        <Workbench
          state={desk}
          full={single}
          entries={[]}
          findFiles={async () => []}
          onActivate={(id) => dispatch({ type: 'activate', id })}
          onClose={(id) => dispatch({ type: 'closeTab', id })}
          onKeep={(id) => dispatch({ type: 'keep', id })}
          onOpenRef={(ref) => void openRef(ref)}
          onOpenSession={onOpenSession}
        />
      ) : (
        <DesignPane pane={pane} revisions={revisions} onView={setViewingOrd} onOpenRef={(ref) => void openRef(ref)} />
      ))}

      <RoomActions>
        {single ? (
          <button className="link-button" type="button" onClick={() => setNarrowShows((shown) => (shown === 'design' ? 'conversation' : 'design'))}>
            {narrowShows === 'design' ? 'Conversation' : deskShown ? 'Evidence' : 'Design'}
          </button>
        ) : null}
        {deskShown && (
          <PanelToggle side="right" open label="Back to the design" onToggle={() => dispatch({ type: 'setOpen', open: false })} />
        )}
      </RoomActions>
    </main>
  );
}

/** The Studio composer: Ask's shape, with Stop while Vowe is working. */
function StudioComposer({
  draft, working, disabled, error, viewing, attachments, placeholder, onDraft, onSend, onStop, onAttach, onDetach,
}: {
  draft: string;
  working: boolean;
  disabled: boolean;
  error: string | null;
  viewing: Attachment | null;
  attachments: Attachment[];
  placeholder: string;
  onDraft: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  onAttach: (item: Attachment) => void;
  onDetach: (item: Attachment) => void;
}): ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!field.current) return;
    field.current.style.height = 'auto';
    field.current.style.height = `${Math.min(160, field.current.scrollHeight)}px`;
  }, [draft]);
  const canAttach = viewing && !attachments.some((item) => formatRef(item.ref) === formatRef(viewing.ref));
  return (
    <div className="project-ask studio-ask">
      {canAttach && (
        <div className="project-viewing">
          <span>On your desk · {viewing.label}</span>
          <button className="link-button" type="button" onClick={() => onAttach(viewing)}>Add to message</button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="project-attachments" aria-label="Attached to message">
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
      {error && <span className="fine" role="alert">{error}</span>}
    </div>
  );
}

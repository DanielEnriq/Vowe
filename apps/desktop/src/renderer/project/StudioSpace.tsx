import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';

import type { ContextRef, DesignOp, DesignRevision, DesignSlot, PresenceProfile, Project } from '@vowe/core';
import { formatRef } from '@vowe/core/refs';
import { diffModels, elementLabel, EMPTY_MODEL } from '@vowe/core/studio-model';

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
import {
  canvasNote,
  changeCount,
  lensView,
  revisionFor,
  shownDesign,
  studioRoom,
  unanswered,
  type ChangesLens,
} from '../state/studio.js';
import { activeTab, EMPTY_WORKBENCH, workbenchReducer } from '../state/workbench.js';
import { composerKeyAction } from '../state/composer.js';
import { SendIcon, CloseIcon } from '../shell/icons.js';
import { Workbench } from '../workbench/Workbench.js';
import { Markdown } from '../workbench/Markdown.js';
import { browsable, DesignList, DesignSwitcher } from './DesignBrowser.js';
import { SystemCanvas, type CanvasSelection } from './SystemCanvas.js';

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
 * The system being designed is the room. Before there is one, the room is a
 * single question. Once Vowe can draw the first shape of it, the system
 * materializes across most of the window and the conversation becomes a rail
 * beside it: a way of changing and questioning the design, not the place the
 * design lives. Select a part and "this" means it. The repository is checked
 * quietly, on the part in question. Evidence rises as a sheet beneath the
 * design and drops away again without the design ever leaving.
 *
 * Nothing here is project truth. What is said and drawn in Studio stays in
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
  const current = view?.design.id === activeId ? view : null;
  const entries = useMemo(() => current?.entries ?? [], [current]);
  const revisions = useMemo(() => current?.revisions ?? [], [current]);
  const entryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const turn = useStudioTurn(activeId, entryIds, revisions);
  const working = (current?.inFlight ?? false) || turn.live.active;
  const activity = useActivityImpulse(turn.live.beat, turn.live.active);

  const room = studioRoom(revisions, turn);
  const design = shownDesign(revisions, current?.layout ?? {}, turn);
  const note = canvasNote(entries, revisions);
  const title = design.model.title || designs.find((candidate) => candidate.id === activeId)?.title || 'Studio';

  // ------------------------------------------------------------ selection
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  useEffect(() => setSelection(null), [activeId]);
  // Something no longer on the canvas cannot be what "this" means.
  useEffect(() => {
    if (!selection) return;
    const model = design.model;
    const alive =
      selection.kind === 'part' ? model.parts.some((part) => part.id === selection.id && !part.retired)
        : selection.kind === 'link' ? model.links.some((link) => link.id === selection.id && !link.retired)
          : model.duties.some((duty) => duty.id === selection.id && !duty.retired);
    if (!alive) setSelection(null);
  }, [design.model, selection]);

  // ---------------------------------------------------------------- lens
  const [lens, setLens] = useState<ChangesLens | null>(null);
  useEffect(() => setLens(null), [activeId, revisions.length]);
  const lensed = lensView(revisions, lens);
  const drawn = useMemo(() => revisions.filter((revision) => revision.model), [revisions]);

  // "3 changes", briefly, when a move lands; then the canvas is plain again.
  const [fresh, setFresh] = useState<DesignRevision | null>(null);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const latest = drawn[drawn.length - 1] ?? null;
    if (seen.current !== null && latest && latest.ord > seen.current) {
      setFresh(latest);
      const timer = window.setTimeout(() => setFresh(null), 6000);
      seen.current = latest.ord;
      return () => window.clearTimeout(timer);
    }
    seen.current = latest?.ord ?? 0;
    return undefined;
  }, [drawn]);
  useEffect(() => { seen.current = null; setFresh(null); }, [activeId]);

  const changesOf = useCallback((id: string) => {
    const touching: { ord: number; summary: string; by: string }[] = [];
    drawn.forEach((revision, index) => {
      const diff = diffModels(drawn[index - 1]?.model ?? EMPTY_MODEL, revision.model!);
      const hit = diff.entries.some((entry) => {
        if (entry.id === id) return true;
        if (entry.kind === 'link') return entry.id.startsWith(`${id}->`) || entry.id.endsWith(`->${id}`);
        if (entry.kind === 'duty') return revision.model!.duties.some((duty) => duty.id === entry.id && duty.part === id) || entry.was?.part === id;
        return false;
      });
      if (hit) touching.push({ ord: revision.ord, summary: revision.summary, by: revision.move?.author === 'developer' ? 'You' : 'Vowe' });
    });
    return touching.reverse();
  }, [drawn]);

  // ------------------------------------------------------------- evidence
  const [desk, dispatch] = useReducer(workbenchReducer, EMPTY_WORKBENCH);
  const deskShown = desk.open && desk.tabs.length > 0;
  const [error, setError] = useState<string | null>(null);
  const openRef = useCallback(async (ref: ContextRef) => {
    try {
      const artifact = await window.vowe.openArtifact(projectRef(ref, project.repoRoot));
      dispatch({ type: 'open', artifact });
      dispatch({ type: 'setOpen', open: true });
      setError(null);
    } catch {
      setError('That evidence could not be opened.');
    }
  }, [project.repoRoot]);

  // ---------------------------------------------------------------- rail
  const [railOpen, setRailOpen] = useState(!narrow);
  useEffect(() => setRailOpen(!narrow), [narrow]);
  const [showDocument, setShowDocument] = useState(false);
  useEffect(() => setShowDocument(false), [activeId]);

  // ------------------------------------------------------------- compose
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [start, setStart] = useState<'code' | 'idea' | null>(null);
  const sending = useRef(false);
  const active = activeTab(desk);
  const viewing: Attachment | null = deskShown && active ? { ref: active.sourceRef, label: active.title } : null;
  const about = selection && room === 'workspace'
    ? { ...selection, label: elementLabel(design.model, selection.kind, selection.id) }
    : null;

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
        const fresh = await window.vowe.createDesign(project.id);
        target = fresh.id;
        created.current.add(target);
        onSelectDesign(target);
      }
      await window.vowe.converseDesign(target, message, submitted.map((item) => item.ref), {
        ...(about ? { focus: { kind: about.kind, id: about.id } } : {}),
        ...(start && entries.length === 0 ? { start } : {}),
      });
    } catch (cause) {
      setError(errorText(cause));
      setDraft((current) => current || message);
      setAttachments((current) => (current.length ? current : submitted));
    } finally {
      sending.current = false;
    }
  };

  const manipulate = async (ops: DesignOp[]) => {
    if (!activeId || working) return;
    try {
      await window.vowe.manipulateDesign(activeId, ops);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const newDesign = async () => {
    if (!available) return;
    try {
      const fresh = await window.vowe.createDesign(project.id);
      created.current.add(fresh.id);
      onSelectDesign(fresh.id);
      setDraft('');
      setStart(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  // Esc peels back one layer: the lens, then the selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (lens) setLens(null);
      else if (selection) setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lens, selection]);

  // Follow the conversation's tail unless the developer has scrolled away.
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [entries, turn, room, railOpen]);
  useEffect(() => { follow.current = true; }, [activeId]);

  const composer = (placeholder: string, floating = false) => (
    <StudioComposer
      draft={draft}
      working={working}
      disabled={!available}
      error={error}
      viewing={viewing}
      attachments={attachments}
      about={about?.label ?? null}
      floating={floating}
      placeholder={placeholder}
      onDraft={setDraft}
      onSend={() => void send()}
      onStop={() => { if (activeId) void window.vowe.cancelDesignTurn(activeId); }}
      onClearAbout={() => setSelection(null)}
      onAttach={(item) => setAttachments((list) => list.some((other) => formatRef(other.ref) === formatRef(item.ref)) ? list : [...list, item])}
      onDetach={(item) => setAttachments((list) => list.filter((other) => formatRef(other.ref) !== formatRef(item.ref)))}
    />
  );

  const thread = (
    <>
      {entries.map((entry) => {
        if (entry.role === 'companion_note') return null;
        if (entry.role === 'developer_move') {
          return <p key={entry.id} className="studio-move-line"><span>You</span> {entry.text}</p>;
        }
        const revision = entry.role === 'companion_message' ? revisionFor(entry.id, revisions) : null;
        const count = revision ? changeCount(revisions, revision) : 0;
        return (
          <div key={entry.id} className={`turn${entry.role === 'user_message' ? ' user' : ''}`}>
            <span className="speaker">{entry.role === 'user_message' ? 'You' : 'Vowe'}</span>
            {entry.investigation && (
              <SettledInvestigation entryId={entry.id} receipt={entry.investigation} onOpenRef={(ref) => void openRef(ref)} />
            )}
            <MessageBody text={entry.text} {...(entry.role === 'companion_message' ? { onOpenRef: (ref: ContextRef) => void openRef(ref) } : {})} />
            {revision?.model && count > 0 && (
              <button type="button" className="link-button studio-changes-chip" onClick={() => setLens({ kind: 'move', ord: revision.ord })}>
                {count === 1 ? '1 change' : `${count} changes`}
              </button>
            )}
          </div>
        );
      })}

      {(turn.live.active || turn.live.answer.length > 0 || turn.consulting) && (
        <LiveInvestigation
          live={turn.live}
          presence={presence}
          activity={activity}
          gathering={turn.consulting !== null}
          onOpenRef={(ref) => void openRef(ref)}
          pending={turn.consulting && (
            <div className="consult-pending" role="status">
              <span className="label">Checking current behavior…</span>
              <span className="check-detail">{turn.consulting.activity ?? turn.consulting.question}</span>
            </div>
          )}
        />
      )}

      {unanswered(entries, working) && (
        <p className="fine studio-unanswered">Vowe didn’t finish replying to this.</p>
      )}
    </>
  );

  // ------------------------------------------------------------- opening
  const earlier = browsable(designs, null).filter((design) => design.id !== activeId);
  if (room === 'opening') {
    return (
      <main className="studio-room opening">
        <RoomIdentity>
          <div className="stack">
            <Fading as="h1">{project.name}</Fading>
            <Fading className="meta" title={tildePath(project.repoRoot)}>Studio</Fading>
          </div>
        </RoomIdentity>
        <section className="studio-opening-room" aria-label="Start a design">
          <nav className="studio-opening-nav">
            <button className="link-button" type="button" onClick={onHome}>← Project</button>
          </nav>
          <div className="studio-opening-body" ref={scroller}>
            <h2 className="studio-question">What are we designing?</h2>
            {!available ? (
              <p className="fine">Studio needs a model configured. Add a key to <code>.env</code> and restart Vowe.</p>
            ) : (
              <>
                {composer(start === 'code' ? 'Which part of the system are we changing?' : start === 'idea' ? 'Describe the idea…' : 'Describe what you want to change…')}
                {entries.length === 0 && !working && (
                  <div className="studio-starters" role="group" aria-label="How to begin">
                    <button type="button" className={`link-button${start === 'code' ? ' active' : ''}`} onClick={() => setStart(start === 'code' ? null : 'code')}>start from code</button>
                    <button type="button" className={`link-button${start === 'idea' ? ' active' : ''}`} onClick={() => setStart(start === 'idea' ? null : 'idea')}>start from an idea</button>
                  </div>
                )}
                <div className="studio-opening-thread">{thread}</div>
                {entries.length === 0 && !working && earlier.length > 0 && (
                  <section className="studio-earlier" aria-label="Earlier designs">
                    <h3>Earlier designs</h3>
                    <DesignList designs={earlier} activeId={activeId} onSelect={onSelectDesign} />
                  </section>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    );
  }

  // ----------------------------------------------------------- workspace
  const latest = drawn[drawn.length - 1] ?? null;
  const freshCount = fresh ? changeCount(revisions, fresh) : 0;
  const checking = turn.consulting?.partId ?? null;

  return (
    <main className={`studio-room workspace${railOpen ? '' : ' rail-closed'}${narrow ? ' single' : ''}`}>
      <RoomIdentity>
        <div className="stack">
          <Fading as="h1">{project.name}</Fading>
          <Fading className="meta" title={tildePath(project.repoRoot)}>Studio</Fading>
        </div>
      </RoomIdentity>

      {railOpen && (
        <section className="studio-rail" aria-label="Design conversation">
          <nav className="studio-nav" aria-label="Studio">
            <button className="link-button" type="button" onClick={onHome}>← Project</button>
            <span className="studio-nav-designs">
              <DesignSwitcher
                designs={designs}
                activeId={activeId}
                onSelect={onSelectDesign}
                onNew={available && !working ? () => void newDesign() : null}
              />
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
            <div className="studio-rail-measure">{thread}</div>
          </div>
          <div className="studio-composer">{composer('Talk about the design…')}</div>
        </section>
      )}

      <section className={`studio-surface${deskShown ? ' with-depth' : ''}`} aria-label="System design">
        {room === 'workspace' && !showDocument && <h2 className="studio-surface-title" title={design.model.intent}>{title}</h2>}
        <div className="studio-surface-tools">
          {latest && room === 'workspace' && (
            <>
              <button type="button" className={`link-button${lens ? ' active' : ''}`} onClick={() => setLens(lens ? null : { kind: 'move', ord: latest.ord })}>Changes</button>
              <button type="button" className="link-button" disabled={working} onClick={() => activeId && void window.vowe.tidyDesign(activeId)}>Tidy</button>
            </>
          )}
          {revisions.length > 0 && (
            <button type="button" className={`link-button${showDocument ? ' active' : ''}`} onClick={() => setShowDocument(!showDocument)}>Document</button>
          )}
        </div>

        {showDocument || room === 'legacy' ? (
          <div className="studio-document">
            <div className="studio-document-measure">
              {room === 'legacy' && !showDocument && (
                <p className="studio-legacy-note">This design was written as a document. Vowe will draw it as a system on your next message.</p>
              )}
              <div className="design-document">
                <Markdown text={revisions[revisions.length - 1]?.document ?? ''} onOpenRef={(ref) => void openRef(ref)} />
              </div>
            </div>
          </div>
        ) : (
          <SystemCanvas
            model={design.model}
            layout={design.layout}
            selection={selection}
            onSelect={setSelection}
            checking={checking}
            note={note}
            lens={lensed}
            editable={!working && !turn.preview}
            animateArrival={turn.live.active || turn.preview !== null}
            changesOf={changesOf}
            onShowChange={(ord) => setLens({ kind: 'move', ord })}
            onRename={(id, name) => void manipulate([{ op: 'part', id, name }])}
            onRelocateDuty={(dutyId, partId) => void manipulate([{ op: 'duty', id: dutyId, part: partId }])}
            onPin={(id, slot: DesignSlot) => {
              if (!activeId) return;
              void window.vowe.setDesignLayout(activeId, { ...(current?.layout ?? {}), [id]: slot }).catch((cause) => setError(errorText(cause)));
            }}
            onOpenRef={(ref) => void openRef(ref)}
          />
        )}

        {!showDocument && checking === null && turn.consulting && room === 'workspace' && (
          <p className="studio-surface-status" role="status">Checking current behavior…</p>
        )}

        {lensed && lens && (
          <div className="studio-lens-bar" role="toolbar" aria-label="Changes">
            {lens.kind === 'move' && lensed.revision ? (
              <>
                <button type="button" className="link-button" aria-label="Earlier change" disabled={lensed.index === 0} onClick={() => setLens({ kind: 'move', ord: drawn[lensed.index - 1]!.ord })}>‹</button>
                <span className="studio-lens-where">{lensed.index + 1} of {lensed.total}</span>
                <button type="button" className="link-button" aria-label="Later change" disabled={lensed.index === lensed.total - 1} onClick={() => setLens({ kind: 'move', ord: drawn[lensed.index + 1]!.ord })}>›</button>
                <span className="studio-lens-summary">
                  <span className="by">{lensed.revision.move?.author === 'developer' ? 'You' : 'Vowe'}</span>
                  {lensed.revision.summary || 'Changed the design'}
                </span>
                {lensed.revision.move && (
                  <button type="button" className="link-button" disabled={working} onClick={() => { void manipulate([{ op: 'revert', move: lensed.revision!.move!.id }]); setLens(null); }}>
                    Revert
                  </button>
                )}
              </>
            ) : (
              <span className="studio-lens-summary">Compared with today’s code</span>
            )}
            <span className="studio-lens-end">
              <button type="button" className={`link-button${lens.kind === 'today' ? ' active' : ''}`} onClick={() => setLens(lens.kind === 'today' ? (latest ? { kind: 'move', ord: latest.ord } : null) : { kind: 'today' })}>
                Today’s code
              </button>
              <button type="button" className="link-button" aria-label="Close changes" onClick={() => setLens(null)}><CloseIcon /></button>
            </span>
          </div>
        )}

        {!lens && fresh && freshCount > 0 && !showDocument && (
          <button type="button" className="studio-fresh-chip" onClick={() => { setLens({ kind: 'move', ord: fresh.ord }); setFresh(null); }}>
            {freshCount === 1 ? '1 change' : `${freshCount} changes`}
          </button>
        )}

        {!railOpen && <div className="studio-floating-composer">{composer('Talk about the design…', true)}</div>}

        {deskShown && (
          <div className="studio-depth">
            <Workbench
              state={desk}
              full
              entries={[]}
              findFiles={async () => []}
              onActivate={(id) => dispatch({ type: 'activate', id })}
              onClose={(id) => dispatch({ type: 'closeTab', id })}
              onKeep={(id) => dispatch({ type: 'keep', id })}
              onOpenRef={(ref) => void openRef(ref)}
              onOpenSession={onOpenSession}
            />
          </div>
        )}
      </section>

      <RoomActions>
        <button className="link-button studio-rail-toggle" type="button" onClick={() => setRailOpen(!railOpen)}>
          {railOpen ? 'Hide conversation' : 'Conversation'}
        </button>
        {deskShown && (
          <PanelToggle side="right" open label="Back to the design" onToggle={() => dispatch({ type: 'setOpen', open: false })} />
        )}
      </RoomActions>
    </main>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
}

/** The Studio composer: Ask's shape, with what "this" is and Stop while Vowe is working. */
function StudioComposer({
  draft, working, disabled, error, viewing, attachments, about, floating, placeholder,
  onDraft, onSend, onStop, onClearAbout, onAttach, onDetach,
}: {
  draft: string;
  working: boolean;
  disabled: boolean;
  error: string | null;
  viewing: Attachment | null;
  attachments: Attachment[];
  about: string | null;
  floating: boolean;
  placeholder: string;
  onDraft: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearAbout: () => void;
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
    <div className={`project-ask studio-ask${floating ? ' floating' : ''}`}>
      {(about || canAttach || attachments.length > 0) && (
        <div className="studio-ask-context">
          {about && (
            <button type="button" className="studio-about" title="Stop pointing at this" onClick={onClearAbout}>
              <span className="label">about</span> {about}<CloseIcon />
            </button>
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
      {error && <span className="fine" role="alert">{error}</span>}
    </div>
  );
}


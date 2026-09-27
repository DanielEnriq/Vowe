import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactElement } from 'react';

import type { ContextRef, DesignOp, DesignRevision, PresenceProfile, Project } from '@vowe/core';
import { formatRef } from '@vowe/core/refs';
import { diffModels, elementLabel, EMPTY_MODEL } from '@vowe/core/studio-model';

import { useDesign, useDesigns, useStudioTurn } from '../hooks/useVoweData.js';
import { useActivityImpulse } from '../presence/index.js';
import type { Attachment } from '../session/Composer.js';
import { RoomActions, RoomControls } from '../shell/TopChrome.js';
import { usePrefersReducedMotion } from '../shell/theme.js';
import { BackIcon, CloseIcon, ConversationIcon } from '../shell/icons.js';
import { projectRef } from '../state/project-home.js';
import {
  canvasNote,
  lensView,
  shownDesign,
  studioCaption,
  studioRoom,
  studioStatus,
  STUDIO_QUIET,
  type ChangesLens,
} from '../state/studio.js';
import { activeTab, EMPTY_WORKBENCH, workbenchReducer } from '../state/workbench.js';
import { Workbench } from '../workbench/Workbench.js';
import { Markdown } from '../workbench/Markdown.js';
import { browsable, DesignList } from './DesignBrowser.js';
import { StudioMenu, StudioTitle, type StudioMenuItem } from './StudioChrome.js';
import { StudioComposer, type ComposerHandle } from './StudioComposer.js';
import { StudioThread } from './StudioThread.js';
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

const CONVERSATION_KEY = 'vowe.studio.conversation';
const RAIL_WIDTH_KEY = 'vowe.studio.rail-width';
const RAIL_DEFAULT = 340;
const RAIL_MIN = 280;
const RAIL_MAX = 640;
/** Dragged this close to the room's left edge, the conversation is put away rather than squeezed. */
const RAIL_CLOSE_AT = 180;
/** The column's slide, as long as the stylesheet's transition plus a frame or two. */
const RAIL_SLIDE_MS = 340;
/** How long the room takes to become a workspace around the first shape of the system. */
const BECOMING_MS = 760;
/** How long a settled reply stays under the design when the conversation is put away. */
const CAPTION_MS = 9000;

function rememberedWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(value) && value >= RAIL_MIN ? Math.min(RAIL_MAX, value) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

function remembered(): boolean | null {
  try {
    const value = window.localStorage.getItem(CONVERSATION_KEY);
    return value === null ? null : value === 'open';
  } catch {
    return null;
  }
}

/**
 * STUDIO — what should this system become?
 *
 * The system being designed is the room. Before there is one, the room is a
 * single question. Once Vowe can draw the first shape of it, the workspace
 * materializes around the conversation: the question lifts away, the
 * composer settles into place, and the first parts arrive along the flow.
 * From then on the design takes the window and the conversation is a narrow
 * rail beside it — or put away entirely, leaving the system, what you have
 * selected, and a composer floating over it.
 *
 * Select a part and "this" means it: its neighbourhood comes forward, what
 * Vowe knows about it opens beside it, and typing goes straight to the
 * composer. The repository is checked quietly, on the part in question.
 * Evidence rises as a sheet beneath the design, with the part still in view
 * above it, and drops away again to exactly where you were.
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
  const reduced = usePrefersReducedMotion();

  const room = studioRoom(revisions, turn);
  const design = shownDesign(revisions, current?.layout ?? {}, turn);
  const note = canvasNote(entries, revisions);
  const title = design.model.title || designs.find((candidate) => candidate.id === activeId)?.title || 'Untitled design';
  const status = studioStatus(turn, working);

  // ------------------------------------------------------------ selection
  // What "this" — or "these" — means: one element, or several gathered
  // together, first chosen first.
  const [selection, setSelection] = useState<CanvasSelection[]>([]);
  useEffect(() => setSelection([]), [activeId]);
  // Something no longer on the canvas cannot be what "this" means.
  useEffect(() => {
    if (!selection.length) return;
    const model = design.model;
    const alive = selection.filter((element) =>
      element.kind === 'part' ? model.parts.some((part) => part.id === element.id && !part.retired)
        : element.kind === 'link' ? model.links.some((link) => link.id === element.id && !link.retired)
          : model.duties.some((duty) => duty.id === element.id && !duty.retired));
    if (alive.length !== selection.length) setSelection(alive);
  }, [design.model, selection]);

  // ---------------------------------------------------------------- lens
  const [lens, setLens] = useState<ChangesLens | null>(null);
  useEffect(() => setLens(null), [activeId, revisions.length]);
  const lensed = lensView(revisions, lens);
  const drawn = useMemo(() => revisions.filter((revision) => revision.model), [revisions]);
  const latest: DesignRevision | null = drawn[drawn.length - 1] ?? null;

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
  const [railOpen, setRailOpen] = useState(() => !narrow && (remembered() ?? true));
  useEffect(() => { if (narrow) setRailOpen(false); }, [narrow]);
  const setRail = useCallback((next: boolean) => {
    setRailOpen(next);
    try { window.localStorage.setItem(CONVERSATION_KEY, next ? 'open' : 'closed'); } catch { /* a convenience, not state */ }
  }, []);
  const toggleRail = () => setRail(!railOpen);
  // While the column slides, the drawing refits frame by frame with it rather
  // than easing after it — one motion, not two.
  const [sliding, setSliding] = useState(false);
  const firstRail = useRef(true);
  useEffect(() => {
    if (firstRail.current) { firstRail.current = false; return; }
    setSliding(true);
    const timer = window.setTimeout(() => setSliding(false), RAIL_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [railOpen]);

  // The edge between the conversation and the design, dragged like the
  // projects panel's: the rail follows the pointer frame by frame, nothing
  // eases behind it, and dragged to the room's edge it is put away.
  const roomBox = useRef<HTMLElement>(null);
  const [railWidth, setRailWidth] = useState(rememberedWidth);
  const [resizingRail, setResizingRail] = useState(false);
  const railFrame = useRef<number | null>(null);
  const startRailResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const room = roomBox.current;
    if (!room) return;
    setResizingRail(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let width = railWidth;
    const move = (moved: MouseEvent) => {
      if (railFrame.current) cancelAnimationFrame(railFrame.current);
      railFrame.current = requestAnimationFrame(() => {
        const box = room.getBoundingClientRect();
        const x = moved.clientX - box.left;
        if (x < RAIL_CLOSE_AT) {
          stop();
          setRail(false);
          return;
        }
        width = Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, box.width * 0.5, x)));
        setRailWidth(width);
      });
    };
    const stop = () => {
      if (railFrame.current) cancelAnimationFrame(railFrame.current);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizingRail(false);
      try { window.localStorage.setItem(RAIL_WIDTH_KEY, String(width)); } catch { /* a convenience, not state */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, [railWidth, setRail]);
  const [showDocument, setShowDocument] = useState(false);
  useEffect(() => setShowDocument(false), [activeId]);

  // ------------------------------------------------------------- compose
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [start, setStart] = useState<'code' | 'idea' | null>(null);
  const sending = useRef(false);
  const composerHandle = useRef<ComposerHandle>(null);
  const active = activeTab(desk);
  const viewing: Attachment | null = deskShown && active ? { ref: active.sourceRef, label: active.title } : null;
  const about = room === 'workspace'
    ? selection.map((element) => ({ ...element, label: elementLabel(design.model, element.kind, element.id) }))
    : [];

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
        ...(about.length === 1 ? { focus: { kind: about[0]!.kind, id: about[0]!.id } } : {}),
        ...(about.length > 1 ? { focus: about.map(({ kind, id }) => ({ kind, id })) } : {}),
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

  const ask = (question: string) => {
    setDraft(question);
    window.requestAnimationFrame(() => composerHandle.current?.focus());
  };

  // Esc peels back one layer: the evidence, the lens, then the selection.
  // With something selected, typing goes to the composer: click a part,
  // type "why?", and Vowe knows what "this" is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (deskShown) dispatch({ type: 'setOpen', open: false });
        else if (lens) setLens(null);
        else if (selection.length) setSelection([]);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
      // ⌘A on the design gathers every part.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && room === 'workspace' && !typing) {
        event.preventDefault();
        setSelection(design.model.parts.filter((part) => !part.retired).map((part) => ({ kind: 'part' as const, id: part.id })));
        return;
      }
      if (!selection.length || room !== 'workspace' || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      if (typing) return;
      if (event.key === ' ' && target?.getAttribute('role') === 'button') return;
      event.preventDefault();
      setDraft((current) => current + event.key);
      composerHandle.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deskShown, lens, selection, room, design.model]);

  // Follow the conversation's tail unless the developer has scrolled away.
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [entries, turn, room, railOpen]);
  useEffect(() => { follow.current = true; }, [activeId]);

  // ------------------------------------------------------------ becoming
  // The moment Studio comes alive: the room was a question, and now there is
  // a system. The question lifts away, and the composer travels from where
  // it was to where it will live, so the workspace forms around it.
  const openingRect = useRef<DOMRect | null>(null);
  const previousRoom = useRef(room);
  const [becoming, setBecoming] = useState(false);
  useLayoutEffect(() => {
    const was = previousRoom.current;
    previousRoom.current = room;
    if (room === 'opening') {
      openingRect.current = composerHandle.current?.element()?.getBoundingClientRect() ?? null;
      return;
    }
    if (was !== 'opening' || room !== 'workspace') return;
    setBecoming(true);
    const from = openingRect.current;
    const element = composerHandle.current?.element();
    if (from && element && !reduced) {
      const to = element.getBoundingClientRect();
      element.animate(
        [
          { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, width: `${from.width}px` },
          { transform: 'translate(0, 0)', width: `${to.width}px` },
        ],
        { duration: 680, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
  });
  useEffect(() => {
    if (!becoming) return;
    const timer = window.setTimeout(() => setBecoming(false), BECOMING_MS);
    return () => window.clearTimeout(timer);
  }, [becoming]);

  // -------------------------------------------------------------- caption
  const caption = studioCaption(entries, turn);
  // Only what is said while you are here: opening a design does not replay its last reply.
  const [fadedCaption, setFadedCaption] = useState<string | null>(null);
  const greeted = useRef<string | null>(null);
  useEffect(() => { greeted.current = null; }, [activeId]);
  useEffect(() => {
    if (greeted.current !== null || !current) return;
    greeted.current = activeId ?? '';
    const settled = studioCaption(current.entries, STUDIO_QUIET);
    if (settled) setFadedCaption(settled.key);
  }, [current, activeId]);
  useEffect(() => {
    if (!caption || caption.live) return;
    const timer = window.setTimeout(() => setFadedCaption(caption.key), CAPTION_MS);
    return () => window.clearTimeout(timer);
  }, [caption?.key, caption?.live]);
  const captionShown = caption && caption.key !== fadedCaption ? caption : null;

  // Only the composer in use answers to "focus the composer"; the docked one
  // stays mounted while the rail slides away.
  const composer = (variant: 'opening' | 'docked' | 'floating', active = true) => (
    <StudioComposer
      ref={active ? composerHandle : undefined}
      draft={draft}
      working={working}
      disabled={!available}
      error={error}
      status={status}
      viewing={viewing}
      attachments={attachments}
      about={about.map(({ id, label }) => ({ id, label }))}
      variant={variant}
      placeholder={
        variant === 'opening'
          ? entries.length > 0 ? 'Reply…' : start === 'code' ? 'Which part of the system are we changing?' : start === 'idea' ? 'Describe the idea…' : 'Describe it…'
          : askAbout(about.map((element) => element.label))
      }
      onDraft={setDraft}
      onSend={() => void send()}
      onStop={() => { if (activeId) void window.vowe.cancelDesignTurn(activeId); }}
      onClearAbout={(id) => setSelection((current) => (id === null ? [] : current.filter((element) => element.id !== id)))}
      onAttach={(item) => setAttachments((list) => list.some((other) => formatRef(other.ref) === formatRef(item.ref)) ? list : [...list, item])}
      onDetach={(item) => setAttachments((list) => list.filter((other) => formatRef(other.ref) !== formatRef(item.ref)))}
    />
  );

  const thread = (
    <StudioThread
      entries={entries}
      revisions={revisions}
      turn={turn}
      working={working}
      presence={presence}
      activity={activity}
      onOpenRef={(ref) => void openRef(ref)}
      onShowChange={(ord) => setLens({ kind: 'move', ord })}
    />
  );

  // The window's two Studio controls, at one fixed place on the band: back
  // through the door you came in, and Vowe alongside or away.
  const windowControls = (withConversation: boolean) => (
    <RoomControls>
      <button type="button" className="panel-toggle studio-back" aria-label="Back to project" title={`Back to ${project.name}`} onClick={onHome}>
        <BackIcon />
      </button>
      {withConversation && (
        <button
          type="button"
          className={`panel-toggle studio-conversation-toggle${railOpen && !narrow ? ' open' : ''}`}
          aria-label={railOpen && !narrow ? 'Hide conversation' : 'Show conversation'}
          aria-pressed={railOpen && !narrow}
          title={railOpen && !narrow ? 'Hide conversation' : 'Show conversation'}
          disabled={narrow}
          onClick={toggleRail}
        >
          <ConversationIcon open={railOpen && !narrow} />
        </button>
      )}
    </RoomControls>
  );

  // ------------------------------------------------------------- opening
  const earlier = browsable(designs, null).filter((candidate) => candidate.id !== activeId);
  if (room === 'opening') {
    const quiet = entries.length === 0 && !working;
    return (
      <main className={`studio-room opening${quiet ? '' : ' talking'}`}>
        {windowControls(false)}
        <section className="studio-surface" aria-label="Start a design">
          <div className="studio-opening" ref={scroller}>
            <div className="studio-opening-measure">
              <h2 className="studio-question">What are we designing?</h2>
              {!available ? (
                <p className="fine">Studio needs a model configured. Add a key to <code>.env</code> and restart Vowe.</p>
              ) : (
                <>
                  {!quiet && <div className="studio-opening-thread">{thread}</div>}
                  <div className="studio-opening-compose">{composer('opening')}</div>
                  {quiet && (
                    <div className="studio-starters" role="group" aria-label="How to begin">
                      <button type="button" className={start === 'code' ? 'active' : ''} aria-pressed={start === 'code'} onClick={() => setStart(start === 'code' ? null : 'code')}>start from code</button>
                      <button type="button" className={start === 'idea' ? 'active' : ''} aria-pressed={start === 'idea'} onClick={() => setStart(start === 'idea' ? null : 'idea')}>start from an idea</button>
                    </div>
                  )}
                  {quiet && earlier.length > 0 && (
                    <section className="studio-earlier" aria-label="Earlier designs">
                      <h3>Earlier designs</h3>
                      <DesignList designs={earlier.slice(0, 4)} activeId={activeId} onSelect={onSelectDesign} />
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </main>
    );
  }

  // ----------------------------------------------------------- workspace
  const checking = turn.consulting?.partId ?? null;
  const floating = !railOpen && room === 'workspace' && !showDocument;
  const canvasShown = room === 'workspace' && !showDocument;
  const focusName = about.length === 1 && about[0]!.kind !== 'link' ? about[0]!.label : null;
  const menu: StudioMenuItem[] = [
    ...(latest && room === 'workspace' ? [
      { label: 'Changes', active: lens?.kind === 'move', onSelect: () => setLens(lens?.kind === 'move' ? null : { kind: 'move', ord: latest.ord }) },
      { label: 'Compare with today’s code', active: lens?.kind === 'today', onSelect: () => setLens(lens?.kind === 'today' ? null : { kind: 'today' }) },
      { label: 'Tidy layout', disabled: working, onSelect: () => { if (activeId) void window.vowe.tidyDesign(activeId); } },
    ] : []),
    ...(revisions.length > 0 ? [{ label: room === 'legacy' ? 'Document' : 'Read as a document', active: showDocument, onSelect: () => setShowDocument(!showDocument) }] : []),
  ];

  return (
    <main
      ref={roomBox}
      className={['studio-room', 'workspace', !railOpen && 'rail-closed', narrow && 'single', becoming && 'becoming', deskShown && 'deep', resizingRail && 'resizing', sliding && 'sliding'].filter(Boolean).join(' ')}
      style={{ '--studio-rail': `${railWidth}px`, '--studio-rail-shown': railOpen && !narrow ? `${railWidth}px` : '0px' } as CSSProperties}
    >
      {windowControls(true)}

      {railOpen && !narrow && (
        <button
          className={`resize-handle studio-rail-handle${resizingRail ? ' active' : ''}`}
          type="button"
          aria-label="Resize conversation"
          title="Drag to resize · drag to the left edge to put the conversation away"
          onMouseDown={startRailResize}
        />
      )}

      {/* Always here, so putting it away and bringing it back can animate. */}
      <section className="studio-rail" aria-label="Design conversation" aria-hidden={!railOpen || narrow} inert={!railOpen || narrow}>
        <div className="studio-rail-inner">
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
          <div className="studio-composer">{composer('docked', railOpen && !narrow)}</div>
        </div>
      </section>

      <section className={`studio-surface${deskShown ? ' with-depth' : ''}`} aria-label="System design">
        {canvasShown && (
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
            inset={{ top: 64, bottom: (floating ? 132 : 36) + (lensed ? 56 : 0) }}
            depth={deskShown}
            changesOf={changesOf}
            onShowChange={(ord) => setLens({ kind: 'move', ord })}
            onRename={(id, name) => void manipulate([{ op: 'part', id, name }])}
            onRelocateDuty={(dutyId, partId) => void manipulate([{ op: 'duty', id: dutyId, part: partId }])}
            onArrange={(layout) => {
              if (!activeId) return;
              void window.vowe.setDesignLayout(activeId, layout).catch((cause) => setError(errorText(cause)));
            }}
            onRegroup={(id, group, layout) => {
              if (!activeId) return;
              // Arranged first, so the part joins or leaves the boundary where it was dropped.
              void window.vowe.setDesignLayout(activeId, layout)
                .then(() => manipulate([{ op: 'part', id, within: group }]))
                .catch((cause) => setError(errorText(cause)));
            }}
            onOpenRef={(ref) => void openRef(ref)}
            onAsk={ask}
          />
        )}

        {(showDocument || room === 'legacy') && (
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
        )}

        <header className="studio-surface-head">
          <StudioTitle
            projectName={project.name}
            title={title}
            designs={designs}
            activeId={activeId}
            onSelect={onSelectDesign}
            onNew={available && !working ? () => void newDesign() : null}
          />
        </header>

        {canvasShown && checking === null && turn.consulting && railOpen && (
          <p className="studio-surface-status" role="status">Checking current behavior…</p>
        )}

        {lensed && lens && (
          <div className={`studio-lens-bar${floating ? ' above-composer' : ''}`} role="toolbar" aria-label="Changes">
            {lens.kind === 'move' && lensed.revision ? (
              <>
                <button type="button" className="link-button" aria-label="Earlier change" disabled={lensed.index === 0} onClick={() => setLens({ kind: 'move', ord: drawn[lensed.index - 1]!.ord })}>‹</button>
                <span className="studio-lens-where">{lensed.index + 1} / {lensed.total}</span>
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

        {floating && (
          <div className="studio-float">
            {captionShown && (
              <button type="button" className={`studio-caption${captionShown.live ? ' live' : ''}`} key={captionShown.key} title="Open the conversation" onClick={toggleRail}>
                <span className="studio-caption-text">{plainText(captionShown.text)}</span>
              </button>
            )}
            {composer('floating')}
          </div>
        )}

        {deskShown && (
          <div className="studio-depth">
            <div className="studio-depth-head">
              <button type="button" className="link-button studio-depth-back" onClick={() => dispatch({ type: 'setOpen', open: false })}>
                ↑ Back to {focusName ?? 'the design'}
              </button>
            </div>
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

      {menu.length > 0 && (
        <RoomActions>
          <StudioMenu items={menu} />
        </RoomActions>
      )}
    </main>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
}

/** A reply as one line of prose for the caption: no Markdown marks, no links, just the words. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The composer's invitation, naming what is selected: one, two, or how many. */
function askAbout(labels: readonly string[]): string {
  if (labels.length === 0) return 'Ask or change…';
  if (labels.length === 1) return `Ask about ${labels[0]}…`;
  if (labels.length === 2) return `Ask about ${labels[0]} and ${labels[1]}…`;
  return `Ask about these ${labels.length}…`;
}

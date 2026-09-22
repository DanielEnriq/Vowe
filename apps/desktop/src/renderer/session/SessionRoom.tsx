import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import type {
  AgentSession,
  ContextRef,
  LiveTranscriptDelta,
  PresenceProfile,
  PresenceState,
  WorkbenchArtifact,
} from '@vowe/core';
import { formatRef } from '@vowe/core/refs';
import { attentionFor, returnCheckpoint } from '@vowe/core/projections';

import {
  useAttentionCursor,
  useInvestigation,
  useObservationStatus,
  useSessionThread,
} from '../hooks/useVoweData.js';
import { useVo } from '../components/VoPanel.js';
import { providerName } from '../components/ui.js';
import { EMPTY_WORKBENCH, workbenchReducer, deskHasUnseen } from '../state/workbench.js';
import { planSurfacing } from '../state/artifact-surfacing.js';
import { useActivityImpulse } from '../presence/index.js';
import { PanelToggle } from '../shell/PanelToggle.js';
import { Workbench } from '../workbench/Workbench.js';
import { Composer, type Attachment } from './Composer.js';
import { Conversation } from './Conversation.js';
import { ReturnCheckpoint } from './ReturnCheckpoint.js';
import { SessionHeader } from './SessionHeader.js';
import { VoiceStage } from './VoiceStage.js';

interface Props {
  session: AgentSession;
  presence: PresenceProfile;
  presenceState: PresenceState;
  userName: string;
  voiceUnavailableReason: string | null;
  sidebarOpen: boolean;
  /** The pane is too narrow to hold a reading measure beside the workbench. */
  narrow: boolean;
}

/**
 * The primary product surface.
 *
 * One conversation, one composer, one workbench, and voice as a state of this
 * room rather than a separate place to go. Everything visible is either
 * persisted state or a deterministic projection of it.
 */
export function SessionRoom({
  session,
  presence,
  presenceState,
  userName,
  voiceUnavailableReason,
  sidebarOpen,
  narrow,
}: Props): ReactElement {
  const { observing, notes } = useObservationStatus(session.id);
  const thread = useSessionThread(session.id);
  /*
   * The thread's own ids decide when the live view goes.
   *
   * Not the `finished` report: at that moment the room is holding a streamed
   * answer and the durable one has not arrived yet, and clearing there would
   * blank the text the developer is reading. Handing the entry ids in makes
   * the swap a replacement.
   */
  const entryIds = useMemo(() => thread.entries.map((entry) => entry.id), [thread.entries]);
  const investigation = useInvestigation(session.id, entryIds);
  const [workbench, dispatch] = useReducer(workbenchReducer, EMPTY_WORKBENCH);
  const [asking, setAsking] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [liveText, setLiveText] = useState<string | null>(null);
  const { deskWidth, deskResizing, startDeskResize } = useDeskResize(
    useCallback(() => dispatch({ type: 'setOpen', open: false }), []),
  );
  const vo = useVo(session.id);

  const latestSeq = thread.events.at(-1)?.seq ?? 0;
  const cursor = useAttentionCursor(session.id, latestSeq);

  // The desk belongs to the session, so switching rooms clears it.
  useEffect(() => {
    dispatch({ type: 'reset' });
    setVoiceMode(false);
    setLiveText(null);
    setAttachments([]);
  }, [session.id]);

  /*
   * Opening a session is the moment it earns a name.
   *
   * The only thing this room does about titles, and it does not wait for the
   * answer or care whether there is one: a session with no generated name
   * already renders under the deterministic one, so naming cannot delay,
   * block or fail opening. Main keeps its own once-per-session guard, so a
   * re-render or a second room on the same session asks for nothing extra.
   */
  useEffect(() => {
    void window.vowe.sessionOpened(session.id).catch(() => undefined);
  }, [session.id]);

  useEffect(
    () =>
      window.vowe.onLiveTranscript((delta: LiveTranscriptDelta) => {
        setLiveText(delta.text);
      }),
    [],
  );

  const openRef = useCallback(
    async (ref: ContextRef, level?: 'show' | 'suggest', reason?: string) => {
      try {
        const artifact = await window.vowe.openArtifact(ref);
        dispatch(
          level
            ? { type: 'surface', artifact, level, ...(reason ? { reason } : {}) }
            : { type: 'open', artifact, ...(reason ? { reason } : {}) },
        );
      } catch {
        // A ref that will not resolve is not worth a dialog; the desk simply
        // does not gain it.
      }
    },
    [],
  );

  /**
   * What an answer was grounded in goes on the desk.
   *
   * Not a ranking model: the receipt already recorded what Vowe opened, in the
   * order it opened it, and the first of those is what the answer is about.
   */
  const lastAnswerId = thread.entries.at(-1)?.id;
  useEffect(() => {
    const entry = thread.entries.at(-1);
    if (!entry || entry.role !== 'companion_answer') return;
    const plan = planSurfacing(entry);
    // Why it is here, in the developer's terms. Said only where it is true:
    // these are the refs the answer was actually grounded in.
    const because = 'Used to answer your question';
    if (plan.show) void openRef(plan.show, 'show', because);
    for (const ref of plan.suggest) void openRef(ref, 'suggest', because);
  }, [lastAnswerId, thread.entries, openRef]);

  const checkpoint = useMemo(
    () =>
      returnCheckpoint({
        sessionId: session.id,
        cursor,
        events: thread.events,
        notes,
        // The same projection the project's Needs You is built from, so the
        // ribbon can never disagree with it about whether a decision waits.
        needsAttention: session.projectId
          ? attentionFor(session, session.projectId, thread.events)
          : [],
        session,
      }),
    [session, cursor, thread.events, notes],
  );

  const attach = useCallback((attachment: Attachment) => {
    setAttachments((current) =>
      current.some((item) => formatRef(item.ref) === formatRef(attachment.ref))
        ? current
        : [...current, attachment],
    );
  }, []);

  const detach = useCallback((ref: ContextRef) => {
    setAttachments((current) =>
      current.filter((item) => formatRef(item.ref) !== formatRef(ref)),
    );
  }, []);

  const ask = (question: string, refs: ContextRef[]) => {
    setAsking(true);
    void window.vowe
      .askCompanion(session.id, question, refs)
      .catch(() => undefined)
      .finally(() => setAsking(false));
    setAttachments([]);
  };

  const instruct = (text: string) => {
    void window.vowe.sendInstruction(session.id, text).catch(() => undefined);
  };

  const toggleVoice = () => {
    if (vo.phase === 'idle' || vo.phase === 'error') {
      setVoiceMode(true);
      void vo.join();
    } else {
      void vo.end();
      setVoiceMode(false);
      setLiveText(null);
    }
  };

  const inVoice = voiceMode && (vo.phase === 'joining' || vo.phase === 'live');
  /*
   * Vowe's presence moves to Vowe's own work.
   *
   * Derived from the investigation's beat, which counts real execution events,
   * so `thinking` visibly reacts as lookups land and language is written. In a
   * call the orb belongs to the conversation instead and this stays out of it.
   */
  const thinkingActivity = useActivityImpulse(investigation.beat, investigation.active);
  const active = workbench.items.find((item) => item.id === workbench.activeId) ?? null;
  const viewing: Attachment | null = active
    ? { ref: active.sourceRef, label: active.title }
    : null;

  // Below the breakpoint the pane cannot hold a reading measure beside the
  // workbench, so evidence takes the pane rather than squeezing the prose.
  const workbenchTakesPane = workbench.open && narrow && !inVoice;
  const deskColumn = workbench.open && !workbenchTakesPane ? deskWidth : 0;

  return (
    /*
     * The room's own two columns, on the shell's model.
     *
     * `minmax(0, 1fr)` for the conversation and the desk's width — or nothing
     * at all — for the desk. A closed desk is a column of zero, so the
     * conversation takes the width back rather than leaving a gutter where the
     * panel used to be; and the desk's toggle is fixed chrome above this, so
     * neither state reserves a strip for it.
     */
    <main
      className={`session-room${workbenchTakesPane ? ' desk-takes-pane' : ''}`}
      style={
        {
          '--right-column': `${deskColumn}px`,
          '--desk-width': `${deskWidth}px`,
        } as CSSProperties
      }
    >
      {!workbenchTakesPane && (
        <div className="conversation-column">
          <SessionHeader
            session={session}
            presence={presence}
            presenceState={presenceState}
            observing={observing}
            inVoice={inVoice}
            voiceUnavailableReason={voiceUnavailableReason}
            clearTitlebar={!sidebarOpen}
            activity={inVoice ? undefined : thinkingActivity}
            onToggleVoice={toggleVoice}
          />

          {inVoice ? (
            <VoiceStage
              presence={presence}
              presenceState={presenceState}
              // Measured where the audio is: Vowe's playback while it speaks,
              // the microphone while it listens. Never simulated.
              activity={vo.level}
              muted={vo.muted}
              liveText={liveText}
              sidebandAttached={vo.status?.sidebandAttached ?? false}
              audio={vo.audio}
              onToggleMute={vo.toggleMute}
              onEnd={toggleVoice}
            />
          ) : (
            <>
              {checkpoint && (
                <ReturnCheckpoint
                  checkpoint={checkpoint}
                  presence={presence}
                  workbenchOpen={workbench.open && !narrow}
                />
              )}
              <Conversation
                entries={thread.entries}
                deliveries={thread.deliveries}
                milestones={thread.milestones}
                presence={presence}
                userName={userName}
                providerLabel={providerName(session.provider)}
                workbenchOpen={workbench.open && !narrow}
                investigating={asking || investigation.active}
                live={investigation}
                activity={thinkingActivity}
                onOpenRef={(ref) => void openRef(ref)}
              />
              <Composer
                session={session}
                providerLabel={providerName(session.provider)}
                narrow={workbench.open && !narrow}
                busy={asking}
                viewing={viewing}
                attachments={attachments}
                onAttach={attach}
                onRemoveAttachment={detach}
                onAsk={ask}
                onInstruct={instruct}
              />
            </>
          )}

          {vo.error && (
            <p className="fine" style={{ padding: '0 40px 14px' }}>
              {vo.error}
            </p>
          )}
        </div>
      )}

      {/*
        The desk's edge, invisible and draggable. Mirrors the sidebar's: no
        rule, a few transparent pixels straddling the boundary, and no width
        taken from either column.
      */}
      {workbench.open && !workbenchTakesPane && (
        <button
          className={`resize-handle right${deskResizing ? ' active' : ''}`}
          type="button"
          aria-label="Resize workbench"
          title="Drag to resize · drag to the right edge to close"
          onMouseDown={startDeskResize}
        />
      )}

      {workbench.open && (
        <Workbench
          state={workbench}
          full={workbenchTakesPane}
          onActivate={(id) => dispatch({ type: 'activate', id })}
          onTogglePin={() => dispatch({ type: 'togglePin' })}
          onAttach={(artifact: WorkbenchArtifact) =>
            // An address, not the material: the investigator opens it for
            // itself when the question is asked.
            attach({ ref: artifact.sourceRef, label: artifact.title })
          }
        />
      )}

      {/*
        The desk's control, mirroring the projects panel's: one button, both
        states, fixed to the window. It opens the desk even when the desk is
        empty, because "show me what we are looking at" is a question with an
        answer even when the answer is "nothing yet".
      */}
      <PanelToggle
        side="right"
        open={workbench.open}
        unseen={deskHasUnseen(workbench)}
        label={workbench.open ? 'Close workbench' : 'Open workbench'}
        onToggle={() => dispatch({ type: 'setOpen', open: !workbench.open })}
      />
    </main>
  );
}

/** Where the desk sits when nothing has moved it, and how far it may go. */
const DESK_DEFAULT = 380;
const DESK_MIN = 320;
const DESK_MAX = 620;
const DESK_CLOSE_AT = 180;

/**
 * The desk's width, dragged from its own edge.
 *
 * The mirror of the sidebar's, including the part that matters: dragged past
 * the point where it could still hold a readable artifact it closes, rather
 * than shrinking into a column too narrow to read. Measured from the window's
 * right edge, because that is the edge this panel is attached to.
 */
function useDeskResize(onClose: () => void) {
  const [width, setWidth] = useState(DESK_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const frame = useRef<number | null>(null);

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setResizing(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const move = (moved: MouseEvent) => {
        if (frame.current) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          const fromRight = window.innerWidth - moved.clientX;
          if (fromRight < DESK_CLOSE_AT) {
            stop();
            setWidth(DESK_MIN);
            onClose();
            return;
          }
          setWidth(Math.max(DESK_MIN, Math.min(DESK_MAX, fromRight)));
        });
      };

      const stop = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', stop);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setResizing(false);
      };

      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', stop);
    },
    [onClose],
  );

  return { deskWidth: width, deskResizing: resizing, startDeskResize: startResize };
}

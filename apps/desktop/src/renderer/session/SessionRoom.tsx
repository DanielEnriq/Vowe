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
} from '@vowe/core';
import { formatRef } from '@vowe/core/refs';
import { attentionFor, returnCheckpoint } from '@vowe/core/projections';

import {
  useAttentionCursor,
  useInvestigation,
  useObservationStatus,
  useProjectMemories,
  useSessionThread,
  useSessionWorkbench,
} from '../hooks/useVoweData.js';
import { useVo } from '../components/VoPanel.js';
import { providerName } from '../components/ui.js';
import {
  EMPTY_WORKBENCH,
  activeTab,
  deskHasUnseen,
  workbenchReducer,
  type WorkbenchTab,
} from '../state/workbench.js';
import { persistDesk, restoreTabs, restoredActiveId } from '../state/workbench-persistence.js';
import { launcherEntries, type LauncherEntry } from '../state/object-launcher.js';
import { planSurfacing } from '../state/artifact-surfacing.js';
import { useActivityImpulse } from '../presence/index.js';
import { PanelToggle } from '../shell/PanelToggle.js';
import { RoomActions } from '../shell/TopChrome.js';
import { useDeskResize } from '../hooks/useDeskResize.js';
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
    async (ref: ContextRef, how: 'open' | 'surface' = 'open', reason?: string) => {
      try {
        const artifact = await window.vowe.openArtifact(ref);
        dispatch({ type: how, artifact, ...(reason ? { reason } : {}) });
      } catch {
        // A ref that will not resolve is not worth a dialog; the desk simply
        // does not gain it.
      }
    },
    [],
  );

  /**
   * A restored tab is an address until somebody looks at it.
   *
   * Resolving every tab when the room opens would read a dozen files and run
   * `git diff` a dozen times to draw a strip that only needs their names.
   */
  const resolveTab = useCallback(async (tab: WorkbenchTab) => {
    if (tab.artifact) return;
    try {
      const artifact = await window.vowe.openArtifact(tab.sourceRef);
      dispatch({ type: 'resolved', id: tab.id, artifact });
    } catch {
      // Left unresolved, and retried the next time it is clicked. The tab
      // stays: an address that failed to resolve once is not a missing thing.
    }
  }, []);

  /*
   * The desk this session was left on, restored.
   *
   * References and their order; the artifacts themselves are read back when
   * somebody looks at them. Only the tab in front is resolved on the way in —
   * a dozen restored tabs must not mean a dozen files read to draw a strip
   * that needs their names.
   */
  const persisted = useMemo(() => persistDesk(workbench), [workbench.tabs, workbench.activeId]);
  const storedDesk = useSessionWorkbench(session.id, persisted);
  useEffect(() => {
    if (!storedDesk) return;
    const tabs = restoreTabs(storedDesk);
    if (!tabs.length) return;
    const activeId = restoredActiveId(storedDesk, tabs);
    dispatch({ type: 'hydrate', tabs, activeId });
    const front = tabs.find((tab) => tab.id === activeId);
    if (front) void resolveTab(front);
  }, [storedDesk, resolveTab]);

  /*
   * What the `+` can open, derived from what this room already holds.
   *
   * No model call and no new read: the diff has an address by construction,
   * and the rest come from the observation notes, the thread and what Vowe has
   * remembered about this project. An entry whose source is absent is omitted.
   */
  const memories = useProjectMemories(session.projectId ?? null);
  const entries = useMemo(
    () =>
      launcherEntries({
        sessionId: session.id,
        projectId: session.projectId ?? null,
        reasoningAvailable: session.capabilities.reasoning,
        events: thread.events,
        milestones: thread.milestones,
        notes,
        memories,
      }),
    [
      session.id,
      session.projectId,
      session.capabilities.reasoning,
      thread.events,
      thread.milestones,
      notes,
      memories,
    ],
  );

  /** Repository files by name. Addresses only; nothing is read to answer it. */
  const findFiles = useCallback(
    async (query: string): Promise<LauncherEntry[]> => {
      try {
        const candidates = await window.vowe.findFiles(session.id, query);
        return candidates.map((candidate) => ({
          id: formatRef(candidate.ref),
          section: 'repository' as const,
          label: candidate.label,
          ...(candidate.detail ? { detail: candidate.detail } : {}),
          ref: candidate.ref,
        }));
      } catch {
        return [];
      }
    },
    [session.id],
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
    const ref = planSurfacing(entry);
    // Why it is here, in the developer's terms. Said only where it is true:
    // this is the ref the answer was actually grounded in.
    if (ref) void openRef(ref, 'surface', 'Used to answer your question');
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
  const active = activeTab(workbench);
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
     * panel used to be; and the desk's toggle lives on the band above, so
     * neither state reserves a strip for it.
     */
    <main
      className={`session-room${workbenchTakesPane ? ' desk-takes-pane' : ''}${
        deskResizing ? ' resizing' : ''
      }`}
      style={
        {
          '--right-column': `${deskColumn}px`,
          '--desk-width': `${deskWidth}px`,
        } as CSSProperties
      }
    >
      {/*
        The room's first row, and outside the branch below, because which
        session this is does not stop being true when the desk takes the pane.
      */}
      <SessionHeader session={session} observing={observing} inVoice={inVoice} />

      {!workbenchTakesPane && (
        <div className="conversation-column">
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
                <ReturnCheckpoint checkpoint={checkpoint} presence={presence} />
              )}
              <Conversation
                entries={thread.entries}
                deliveries={thread.deliveries}
                milestones={thread.milestones}
                presence={presence}
                userName={userName}
                providerLabel={providerName(session.provider)}
                investigating={asking || investigation.active}
                live={investigation}
                activity={thinkingActivity}
                onOpenRef={(ref) => void openRef(ref)}
              />
              <Composer
                session={session}
                providerLabel={providerName(session.provider)}
                busy={asking}
                viewing={viewing}
                attachments={attachments}
                onAttach={attach}
                onRemoveAttachment={detach}
                onAsk={ask}
                onInstruct={instruct}
                presence={presence}
                presenceState={presenceState}
                inVoice={inVoice}
                voiceUnavailableReason={voiceUnavailableReason}
                activity={inVoice ? undefined : thinkingActivity}
                onToggleVoice={toggleVoice}
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
          entries={entries}
          findFiles={findFiles}
          onActivate={(id) => {
            dispatch({ type: 'activate', id });
            const tab = workbench.tabs.find((candidate) => candidate.id === id);
            if (tab) void resolveTab(tab);
          }}
          onClose={(id) => dispatch({ type: 'closeTab', id })}
          onKeep={(id) => dispatch({ type: 'keep', id })}
          onOpenRef={(ref) => void openRef(ref)}
        />
      )}

      {/*
        The desk's control, mirroring the projects panel's: one button, both
        states, on the same band at the same baseline. It opens the desk even
        when the desk is empty, because "show me what we are looking at" is a
        question with an answer even when the answer is "nothing yet".
      */}
      <RoomActions>
        <PanelToggle
          side="right"
          open={workbench.open}
          unseen={deskHasUnseen(workbench)}
          label={workbench.open ? 'Close workbench' : 'Open workbench'}
          onToggle={() => dispatch({ type: 'setOpen', open: !workbench.open })}
        />
      </RoomActions>
    </main>
  );
}

/** Where the desk sits when nothing has moved it, and how far it may go. */

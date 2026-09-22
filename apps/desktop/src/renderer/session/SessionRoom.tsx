import { useCallback, useEffect, useMemo, useReducer, useState, type ReactElement } from 'react';

import type {
  AgentSession,
  ContextRef,
  LiveTranscriptDelta,
  PresenceProfile,
  PresenceState,
  WorkbenchArtifact,
} from '@vowe/core';
import { formatRef } from '@vowe/core/refs';
import { returnCheckpoint } from '@vowe/core/projections';

import {
  useAttentionCursor,
  useObservationStatus,
  useSessionThread,
} from '../hooks/useVoweData.js';
import { useVo } from '../components/VoPanel.js';
import { providerName } from '../components/ui.js';
import { EMPTY_WORKBENCH, workbenchReducer, deskCount } from '../state/workbench.js';
import { planSurfacing } from '../state/artifact-surfacing.js';
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
  const { observing } = useObservationStatus(session.id);
  const thread = useSessionThread(session.id);
  const [workbench, dispatch] = useReducer(workbenchReducer, EMPTY_WORKBENCH);
  const [asking, setAsking] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [liveText, setLiveText] = useState<string | null>(null);
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

  useEffect(
    () =>
      window.vowe.onLiveTranscript((delta: LiveTranscriptDelta) => {
        setLiveText(delta.text);
      }),
    [],
  );

  const openRef = useCallback(async (ref: ContextRef, level?: 'show' | 'suggest') => {
    try {
      const artifact = await window.vowe.openArtifact(ref);
      dispatch(
        level ? { type: 'surface', artifact, level } : { type: 'open', artifact },
      );
    } catch {
      // A ref that will not resolve is not worth a dialog; the desk simply
      // does not gain it.
    }
  }, []);

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
    if (plan.show) void openRef(plan.show, 'show');
    for (const ref of plan.suggest) void openRef(ref, 'suggest');
  }, [lastAnswerId, thread.entries, openRef]);

  const checkpoint = useMemo(
    () =>
      returnCheckpoint({
        sessionId: session.id,
        cursor,
        events: thread.events,
        notes: [],
      }),
    [session.id, cursor, thread.events],
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
  const active = workbench.items.find((item) => item.id === workbench.activeId) ?? null;
  const viewing: Attachment | null = active
    ? { ref: active.sourceRef, label: active.title }
    : null;

  // Below the breakpoint the pane cannot hold a reading measure beside the
  // workbench, so evidence takes the pane rather than squeezing the prose.
  const workbenchTakesPane = workbench.open && narrow && !inVoice;

  return (
    <main className="session-room">
      {!workbenchTakesPane && (
        <div className="conversation-column">
          <SessionHeader
            session={session}
            presence={presence}
            presenceState={presenceState}
            observing={observing}
            inVoice={inVoice}
            voiceUnavailableReason={voiceUnavailableReason}
            deskCount={deskCount(workbench)}
            deskHasNew={workbench.newIds.length > 0}
            workbenchOpen={workbench.open}
            clearTitlebar={!sidebarOpen}
            activity={undefined}
            onToggleVoice={toggleVoice}
            onOpenWorkbench={() => dispatch({ type: 'setOpen', open: true })}
          />

          {inVoice ? (
            <VoiceStage
              presence={presence}
              presenceState={presenceState}
              activity={undefined}
              muted={vo.muted}
              liveText={liveText}
              sidebandAttached={vo.status?.sidebandAttached ?? false}
              audio={vo.audio}
              onToggleMute={vo.toggleMute}
              onEnd={toggleVoice}
            />
          ) : (
            <>
              {checkpoint && <ReturnCheckpoint checkpoint={checkpoint} />}
              <Conversation
                entries={thread.entries}
                deliveries={thread.deliveries}
                milestones={thread.milestones}
                presence={presence}
                userName={userName}
                providerLabel={providerName(session.provider)}
                workbenchOpen={workbench.open && !narrow}
                investigating={asking}
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

      {workbench.open && (
        <Workbench
          state={workbench}
          full={workbenchTakesPane}
          onActivate={(id) => dispatch({ type: 'activate', id })}
          onTogglePin={() => dispatch({ type: 'togglePin' })}
          onClose={() => dispatch({ type: 'close' })}
          onAttach={(artifact: WorkbenchArtifact) =>
            // An address, not the material: the investigator opens it for
            // itself when the question is asked.
            attach({ ref: artifact.sourceRef, label: artifact.title })
          }
        />
      )}
    </main>
  );
}

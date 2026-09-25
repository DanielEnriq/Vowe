import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { ContextRef, PresenceProfile, PresenceState, Project, ProjectBrief } from '@vowe/core';
import { resolvePresenceState } from '@vowe/core/presence';
import { useVo } from '../components/VoPanel.js';
import { useActivityImpulse } from '../presence/index.js';
import { VoweMark } from '../session/VoweMark.js';
import { SettledInvestigation } from '../session/SettledInvestigation.js';
import { LiveInvestigation } from '../session/LiveInvestigation.js';
import { planSurfacing } from '../state/artifact-surfacing.js';
import { formatRef } from '@vowe/core/refs';
import { useProjectInvestigation, useProjectMemories, useProjectThread } from '../hooks/useVoweData.js';
import { useDeskResize } from '../hooks/useDeskResize.js';
import { Fading } from '../shell/Fading.js';
import { RoomActions, RoomIdentity } from '../shell/TopChrome.js';
import { PanelToggle } from '../shell/PanelToggle.js';
import { tildePath } from '../components/ui.js';
import type { Attachment } from '../session/Composer.js';
import { activeTab, EMPTY_WORKBENCH, workbenchReducer } from '../state/workbench.js';
import type { LauncherEntry } from '../state/object-launcher.js';
import { projectChanges, projectRef } from '../state/project-home.js';
import { Workbench } from '../workbench/Workbench.js';
import { ProjectAsk } from './ProjectAsk.js';
import { ProjectConversation } from './ProjectConversation.js';
import { ProjectRoom } from './ProjectRoom.js';

interface Props {
  project: Project;
  brief: ProjectBrief | null;
  presence: PresenceProfile;
  presenceState: PresenceState;
  view: 'home' | 'conversation';
  entryId: string | undefined;
  narrow: boolean;
  onNavigate: (view: 'home' | 'conversation', entryId?: string) => void;
  onOpenSession: (sessionId: string) => void;
}

/** Home and conversation share live state, while keeping their own reading surfaces. */
export function ProjectSpace({ project, brief, presence, presenceState, view, entryId,
  narrow, onNavigate, onOpenSession }: Props): ReactElement {
  const { entries, deliveries, loaded } = useProjectThread(project.id);
  const vo = useVo({ projectId: project.id });
  const inVoice = vo.phase === 'live' || vo.phase === 'joining';
  const [caption, setCaption] = useState<string | null>(null);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [voiceAnswerId, setVoiceAnswerId] = useState<string | null>(null);
  const memories = useProjectMemories(project.id);
  const entryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const live = useProjectInvestigation(project.id, entryIds);
  const investigationActivity = useActivityImpulse(live.beat, live.active);
  const voiceState = resolvePresenceState({
    voweAvailable: inVoice || presenceState !== 'unavailable',
    liveJoining: vo.phase === 'joining', liveConnected: vo.phase === 'live',
    liveMuted: vo.muted, livePlaybackActive: vo.status?.playbackActive ?? false,
    investigating: live.active, needsAttention: presenceState === 'attention',
    following: presenceState === 'observing',
  });
  useEffect(() => {
    if (!inVoice) { setCaption(null); return; }
    const off = window.vowe.onLiveTranscript((delta) => {
      if (delta.scope?.projectId !== project.id) return;
      if (delta.speaker === 'user') setVoiceAnswerId(null);
      setCaption(delta.text);
      if (captionTimer.current) clearTimeout(captionTimer.current);
      captionTimer.current = setTimeout(() => setCaption(null), 5000);
    });
    return () => { off(); if (captionTimer.current) clearTimeout(captionTimer.current); };
  }, [inVoice, project.id]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [desk, dispatch] = useReducer(workbenchReducer, EMPTY_WORKBENCH);
  const { deskWidth, deskResizing, startDeskResize } = useDeskResize(
    useCallback(() => dispatch({ type: 'setOpen', open: false }), []),
  );
  const changes = useMemo(() => projectChanges(brief, memories), [brief, memories]);
  const active = activeTab(desk);
  const viewing = active ? {
    ref: active.sourceRef,
    label: active.artifact?.kind === 'worker_activity' ? active.artifact.subtitle ?? 'Worker activity' : active.title,
  } : null;

  const previousView = useRef(view);
  useEffect(() => {
    if (view === 'home' && previousView.current !== 'home') dispatch({ type: 'setOpen', open: false });
    previousView.current = view;
  }, [view]);

  const openRef = useCallback(async (ref: ContextRef, how: 'open' | 'surface' = 'open') => {
    try {
      const artifact = await window.vowe.openArtifact(projectRef(ref, project.repoRoot));
      dispatch({ type: how, artifact, ...(how === 'surface' ? { reason: 'Used to answer your question' } : {}) });
      setError(null);
    } catch {
      setError('That evidence could not be opened. Try opening its session.');
    }
  }, [project.repoRoot]);

  // Same preview policy for written and spoken grounded answers. Hydration
  // never reopens yesterday's evidence on the living Home.
  const seenAnswers = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (seenAnswers.current === null) { seenAnswers.current = new Set(entries.map((entry) => entry.id)); return; }
    for (const entry of entries) {
      if (seenAnswers.current.has(entry.id)) continue;
      seenAnswers.current.add(entry.id);
      if (entry.role !== 'companion_answer') continue;
      if (inVoice) setVoiceAnswerId(entry.id);
      const ref = planSurfacing(entry);
      if (ref) void openRef(ref, 'surface');
    }
  }, [entries, loaded, inVoice, openRef]);

  const send = async () => {
    const question = draft.trim();
    if (!question || pending.current || live.active) return;
    pending.current = true;
    setAsking(true);
    setError(null);
    const submitted = attachments;
    setDraft('');
    setAttachments([]);
    onNavigate('conversation');
    try {
      await window.vowe.askProject(project.id, question, submitted.map((item) => item.ref));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDraft((current) => current || question);
      setAttachments((current) => current.length ? current : submitted);
    } finally {
      pending.current = false;
      setAsking(false);
    }
  };

  const voiceAnswer = entries.find((entry) => entry.id === voiceAnswerId);
  const voiceControl = <button className="project-talk" type="button"
    aria-label={inVoice ? 'End voice conversation' : 'Talk to Vowe'} aria-pressed={inVoice}
    disabled={!inVoice && (!vo.status?.available || asking || live.active)}
    title={vo.status?.unavailableReason ?? (inVoice ? 'End voice conversation' : 'Talk to Vowe')}
    onClick={() => void (inVoice ? vo.end() : vo.join())}>
    <VoweMark profile={presence} state={voiceState} activity={vo.level} />
    <span>{inVoice ? 'End' : 'Talk'}</span>
  </button>;
  const voiceSurface = inVoice ? <div className="project-voice">
    <div className="project-voice-status">
      <span role="status">{vo.phase === 'joining' ? 'Connecting…' : vo.muted ? 'Microphone muted' :
        voiceState === 'speaking' ? 'Speaking' : live.active ? 'Looking into your question' : 'Listening'}</span>
      {vo.phase === 'live' && <button className="link-button" type="button" aria-pressed={vo.muted}
        onClick={vo.toggleMute}>{vo.muted ? 'Unmute' : 'Mute'}</button>}
      <button className="link-button" type="button" onClick={() => void vo.end()}>End voice</button>
    </div>
    {caption && <p className="project-voice-caption">{caption}</p>}
  </div> : null;
  const composer = <ProjectAsk voiceControl={voiceControl} draft={draft} asking={asking || live.active} error={error ?? vo.error}
    viewing={viewing} attachments={attachments} onDraft={setDraft} onSend={() => void send()}
    onAttach={(item) => setAttachments((current) => current.some((other) => formatRef(other.ref) === formatRef(item.ref)) ? current : [...current, item])}
    onDetach={(item) => setAttachments((current) => current.filter((other) => formatRef(other.ref) !== formatRef(item.ref)))} />;

  const objects: LauncherEntry[] = [
    { id: 'project-diff', section: 'current', label: 'Current diff', ref: { kind: 'diff', projectId: project.id } },
    ...changes.flatMap((change): LauncherEntry[] => change.ref ? [{
      id: change.id, section: 'vowe', label: change.title, detail: change.text, ref: projectRef(change.ref, project.repoRoot),
    }] : []),
  ];
  const full = desk.open && narrow;
  const count = brief?.active.filter((session) => session.status === 'working' || session.status === 'starting').length ?? 0;
  return <main className={`session-room project-space${full ? ' desk-takes-pane' : ''}${deskResizing ? ' resizing' : ''}`}
    style={{ '--right-column': `${desk.open && !full ? deskWidth : 0}px`, '--desk-width': `${deskWidth}px` } as CSSProperties}>
    <audio ref={vo.audio} autoPlay hidden />
    <RoomIdentity><div className="stack">
      <Fading as="h1">{project.name}</Fading>
      <Fading className="meta" title={tildePath(project.repoRoot)}>
        {view === 'conversation' ? 'Project conversation' : brief ? `${count} worker${count === 1 ? '' : 's'} active` : 'Reading the project…'}
      </Fading>
    </div></RoomIdentity>
    {!full && (view === 'home'
      ? <ProjectRoom brief={brief} changes={changes} presence={presence} presenceState={inVoice || live.active ? voiceState : presenceState}
          activity={live.active && !vo.status?.playbackActive ? investigationActivity : vo.level}
          voice={voiceSurface} investigation={live.active ? <div className="project-voice-investigation">
            <LiveInvestigation live={live} presence={presence} activity={investigationActivity} onOpenRef={(ref) => void openRef(ref)} />
          </div> : inVoice && (caption || vo.status?.playbackActive) && voiceAnswer?.investigation ?
            <SettledInvestigation entryId={voiceAnswer.id} receipt={voiceAnswer.investigation} onOpenRef={(ref) => void openRef(ref)} /> : null}
          composer={composer} hasConversation={entries.length > 0} investigating={asking || live.active}
          onOpenConversation={() => onNavigate('conversation')} onOpenSession={onOpenSession} onOpenRef={(ref) => void openRef(ref)} />
      : <ProjectConversation entries={entries} deliveries={deliveries} voice={voiceSurface} live={live} asking={asking} entryId={entryId} presence={presence}
          composer={composer} onHome={() => onNavigate('home')} onSelectEntry={(id) => onNavigate('conversation', id)} onOpenRef={(ref) => void openRef(ref)} />)}
    {desk.open && !full && <button className={`resize-handle right${deskResizing ? ' active' : ''}`} type="button"
      aria-label="Resize workbench" title="Drag to resize · drag to the right edge to close" onMouseDown={startDeskResize} />}
    {desk.open && <Workbench state={desk} full={full} entries={objects} findFiles={async () => []}
      onActivate={(id) => dispatch({ type: 'activate', id })} onClose={(id) => dispatch({ type: 'closeTab', id })}
      onKeep={(id) => dispatch({ type: 'keep', id })} onOpenRef={(ref) => void openRef(ref)} onOpenSession={onOpenSession} />}
    <RoomActions>{full && inVoice && <button className="link-button" type="button" onClick={() => void vo.end()}>End voice</button>}<PanelToggle side="right" open={desk.open} label={desk.open ? 'Close workbench' : 'Open workbench'}
      onToggle={() => dispatch({ type: 'setOpen', open: !desk.open })} /></RoomActions>
  </main>;
}

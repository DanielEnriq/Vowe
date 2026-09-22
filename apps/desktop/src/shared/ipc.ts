import type {
  AgentSession,
  ContextRef,
  ConversationChange,
  ConversationDelivery,
  ConversationEntry,
  InstructionResult,
  InvestigationProgress,
  InvestigationStep,
  LiveStatus,
  NormalizedEvent,
  ObservationStatus,
  PlaybackReport,
  LiveTranscriptDelta,
  LiveVoice,
  PresenceProfile,
  Project,
  ProjectBrief,
  ProjectConversationChange,
  ProjectConversationEntry,
  ProjectMemoryRecord,
  RepoIndexState,
  SessionAttentionCursor,
  TemperamentProfile,
  VoicePreference,
  SurfaceUpdate,
  TraceWindow,
  UserProfile,
  VoweRunActivity,
  WindowNote,
  WorkbenchArtifact,
} from '@vowe/core';

/**
 * The renderer's view of the main process.
 *
 * Asking and instructing are separate methods on purpose. The architectural
 * boundary between observing a worker and commanding one is not a flag on a
 * single call — it is two different paths through the application, and this is
 * where that becomes visible to the UI.
 */
export interface VoweApi {
  getStatus(): Promise<AppStatus>;

  /**
   * Every repository Vowe has seen work in.
   *
   * Sessions already carry `projectId` and are already pushed on change, so the
   * renderer groups from data it holds rather than asking again per update.
   */
  listProjects(): Promise<Project[]>;
  listSessions(): Promise<AgentSession[]>;
  getSession(sessionId: string): Promise<AgentSession | null>;
  getEvents(sessionId: string, limit?: number): Promise<NormalizedEvent[]>;
  getEventsByIds(sessionId: string, ids: string[]): Promise<NormalizedEvent[]>;
  getConversation(sessionId: string): Promise<ConversationEntry[]>;
  refreshInterpretation(sessionId: string): Promise<void>;

  /**
   * Investigated against the session, the repository and Vowe's own memory.
   *
   * The same investigator Vo delegates to — asking by typing and asking out
   * loud reach one engine. Never reaches the coding agent.
   */
  askCompanion(
    sessionId: string,
    question: string,
    contextRefs?: ContextRef[],
  ): Promise<AskResult>;

  /**
   * What was actually conveyed, for every turn in a session.
   *
   * Separate from the conversation because they are separate facts: an entry
   * holds the complete turn, a delivery records an attempt to communicate it.
   * The UI needs both to tell the truth about a reply that was cut off — the
   * text it shows is the entry's, and how much of it was heard is here.
   */
  getDeliveries(sessionId: string): Promise<ConversationDelivery[]>;

  /** Delivered to the coding agent through the provider adapter. */
  sendInstruction(sessionId: string, text: string): Promise<InstructionResult>;

  launchSession(cwd: string, prompt: string): Promise<AgentSession>;

  // ----------------------------------------------------------- observation

  /** Begin following a session's trace. Returns as soon as it has started. */
  startObserving(sessionId: string): Promise<ObservationStatus>;
  stopObserving(sessionId: string): Promise<void>;
  getObservation(sessionId: string): Promise<ObservationView>;
  /** The developer's own words about when they want to be interrupted. */
  setCommunicationPreference(
    sessionId: string,
    preference: string | null,
  ): Promise<void>;

  // ------------------------------------------------------------------- Vo

  /**
   * Exchange the renderer's SDP offer for an answer.
   *
   * The renderer owns the microphone and the audio; the credential stays in
   * the main process, which is the only reason this is an IPC call at all.
   */
  startLive(sessionId: string, sdpOffer: string): Promise<LiveStartResult>;
  stopLive(): Promise<void>;
  getLiveStatus(): Promise<LiveStatus>;
  /**
   * What the renderer measured about the audio it played.
   *
   * The renderer owns the audio, so it is the only part of Vowe that can say
   * what a person actually heard — the voice provider declares no playback
   * lifecycle at all. This carries that measurement across and stops there:
   * what it means for the conversation, and whether anything is written down,
   * is decided in the main process.
   *
   * Fire-and-forget on purpose. A measurement nobody is waiting on must not be
   * able to stall the audio loop that produced it.
   */
  reportLivePlayback(report: PlaybackReport): void;
  /** Native folder picker for choosing where a new session runs. */
  chooseFolder(): Promise<string | null>;
  /** Native file picker, for attaching a file to a question. */
  chooseFile(): Promise<string | null>;

  // ----------------------------------------------------- project knowledge

  /**
   * How far a Project's code knowledge has got.
   *
   * Reading this never starts an index: the room shows what is known, and only
   * a repository question commits the machine to building anything.
   */
  getProjectKnowledge(projectId: string): Promise<RepoIndexState>;

  /**
   * Everything the Project Room shows, already reconciled.
   *
   * One call rather than several, because the room's synthesis has to agree
   * with itself: a headline computed in the renderer from three separately
   * fetched stores can say "everything is moving" beside a session that has
   * finished. Deterministic aggregation, no project agent, no model call.
   */
  getProjectBrief(projectId: string): Promise<ProjectBrief>;

  /**
   * Ask about the repository and the work going on in it.
   *
   * The same investigator as `askCompanion`, at a wider scope — not a second
   * engine and not a project agent. It can see the repository, what Vowe has
   * learned about it and what Vowe understood about each session; it cannot
   * see raw trace, which is reached by opening one of the answer's citations.
   */
  askProject(
    projectId: string,
    question: string,
    contextRefs?: ContextRef[],
  ): Promise<ProjectAskResult>;

  /** The project's own durable thread, kept apart from every session's. */
  getProjectConversation(projectId: string): Promise<ProjectConversationEntry[]>;

  /**
   * What Vowe has worked out about this project and kept.
   *
   * A read, not a search: the developer is looking at what is there rather
   * than asking a question, so nothing is scored and nothing is admitted.
   */
  listProjectMemories(projectId: string): Promise<ProjectMemoryRecord[]>;

  // ------------------------------------------------------------- identity

  /**
   * Local, and local only. No account, no sign-in, no OS-user inference —
   * these are display settings, and Vowe has nothing to authenticate to.
   *
   * The setters return what was actually stored: validation may adjust a
   * value, and the caller should not have to read back to find out.
   */
  getUserProfile(): Promise<UserProfile>;
  setUserProfile(profile: UserProfile): Promise<UserProfile>;

  /** One appearance for one Vowe, shared by every place it is drawn. */
  getPresenceProfile(): Promise<PresenceProfile>;
  setPresenceProfile(profile: PresenceProfile): Promise<PresenceProfile>;

  /**
   * How Vowe behaves, kept deliberately apart from how it looks.
   *
   * Changing a material must never change how much Vowe interrupts, so
   * temperament is a separate document with a separate call. Every dial here
   * reaches real runtime behaviour: interruption moves the communication
   * policy, the other two compose into the prompts Vowe runs.
   */
  getTemperament(): Promise<TemperamentProfile>;
  setTemperament(profile: TemperamentProfile): Promise<TemperamentProfile>;

  /**
   * Which voice Vo speaks in, and which ones there are to choose from.
   *
   * The list comes from the transport rather than a constant, so a picker can
   * never offer a voice the provider would refuse mid-call.
   */
  getVoicePreference(): Promise<VoicePreference>;
  setVoicePreference(preference: VoicePreference): Promise<VoicePreference>;
  listVoices(): Promise<LiveVoice[]>;

  // --------------------------------------------------------- attention

  /**
   * Where the developer's understanding of a session got to.
   *
   * One mark per session, which is all "while you were away" needs: what
   * changed since is derived from it rather than stored.
   */
  getAttentionCursor(sessionId: string): Promise<SessionAttentionCursor | null>;
  markSessionViewed(sessionId: string, seq: number): Promise<void>;

  /**
   * A person has opened this session.
   *
   * Reported rather than inferred, and deliberately not folded into reading
   * the conversation. It is the one moment at which naming an existing
   * session is warranted, and the distinction it protects is that listing,
   * discovering or polling a session must never reach a model. Sending it
   * again for a session already open costs nothing and asks nothing.
   *
   * Resolves as soon as the main process has been told. Whether a name is
   * produced, and whether producing one fails, is invisible from here: the
   * room opens either way.
   */
  sessionOpened(sessionId: string): Promise<void>;

  /**
   * What Vowe itself is executing right now.
   *
   * The execution lane already records every model call Vowe makes on its own
   * behalf, so this publishes that rather than adding a second notion of
   * busy — and it carries kinds, because following a worker and answering a
   * person are different things to be doing and the UI must not merge them.
   */
  getRunActivity(): Promise<VoweRunActivity>;

  // ------------------------------------------------------------- workbench

  /**
   * One reference, resolved into something a person can look at.
   *
   * Deliberately one call rather than `openDiff` / `openSource` / `openMemory`:
   * a ref already says what it addresses, and the renderer has no business
   * knowing which store answers. Reading a repository, reconstructing a diff
   * and finding what Vowe remembered all stay on the other side of this line.
   */
  openArtifact(ref: ContextRef): Promise<WorkbenchArtifact>;

  // ----------------------------------------------------------- investigation

  /**
   * What Vowe did before writing one answer, read back after the fact.
   *
   * The live column shows the investigation while it happens; this is the same
   * sequence once it has settled, joined in the main process from the two
   * lanes that already hold it — the answer's receipt and the trace of the
   * `VoweRun` whose `outputEntryId` is this entry. Nothing is recomputed, and
   * nothing new is stored: see `investigationChronology`.
   *
   * An answer with no run behind it degrades to its receipt, and one with
   * neither returns nothing, which is the truth about it.
   */
  getInvestigationSteps(entryId: string): Promise<InvestigationStep[]>;

  onSessionsChanged(listener: () => void): () => void;
  onSessionEvent(listener: (event: NormalizedEvent) => void): () => void;
  onObservationChanged(listener: (sessionId: string) => void): () => void;
  onProjectKnowledgeChanged(listener: (projectId: string) => void): () => void;
  onLiveStatus(listener: (status: LiveStatus) => void): () => void;
  /**
   * What is being said on the call right now.
   *
   * The provider's own in-flight transcript, forwarded for the caption on the
   * voice stage. It arrives only while the backend is attached to the call —
   * when it is not, the stage says so rather than showing silence.
   */
  onLiveTranscript(listener: (delta: LiveTranscriptDelta) => void): () => void;

  /**
   * Whether the window is in macOS fullscreen.
   *
   * Real state rather than a CSS guess. In fullscreen the traffic lights are
   * gone and the space reserved to clear them becomes a dead band at the top
   * of the sidebar; only the main process knows which it is.
   */
  isFullscreen(): Promise<boolean>;
  onFullscreenChanged(listener: (fullscreen: boolean) => void): () => void;
  /**
   * An investigation, as it happens.
   *
   * So a room can show Vowe working rather than a frozen column for half a
   * minute. Each check forwarded here is the same object that lands in the
   * persisted receipt, so the live trail and the record cannot disagree.
   */
  onInvestigationProgress(
    listener: (progress: InvestigationProgress) => void,
  ): () => void;
  /** Vowe started or finished executing something. */
  onRunActivity(listener: (activity: VoweRunActivity) => void): () => void;
  /**
   * A session's persisted conversation has changed — typed answer, answer
   * delegated from Vo, or an instruction and its result. Carries the session,
   * not the entry: the renderer re-reads, so there is one source of truth.
   */
  onConversationChanged(listener: (change: ConversationChange) => void): () => void;
  /** A project's own thread has changed. Its own event, for its own table. */
  onProjectConversationChanged(
    listener: (change: ProjectConversationChange) => void,
  ): () => void;
}

/**
 * A completed project investigation.
 *
 * Same shape as `AskResult` and deliberately a different type: the entry
 * belongs to the project thread, not to a session, and nothing that renders
 * one should be able to pass it where the other is expected.
 */
export interface ProjectAskResult {
  entry: ProjectConversationEntry;
  refs: ContextRef[];
  failed: boolean;
}

/** Everything the observation panel needs, in one round trip. */
export interface ObservationView {
  status: ObservationStatus;
  windows: TraceWindow[];
  notes: WindowNote[];
  surfaceUpdates: SurfaceUpdate[];
}

export interface LiveStartResult {
  sdpAnswer: string;
  status: LiveStatus;
}

export interface AppStatus {
  /** False when no LLM credential is configured. */
  llmConfigured: boolean;
  /** False when no voice credential is configured; Vo cannot join. */
  voiceConfigured: boolean;
  /** Why voice is unavailable, in words the UI can show directly. */
  voiceUnavailableReason: string | null;
  /** False when no decision model is configured; fallbacks are used. */
  decisionsConfigured: boolean;
  /** False when no code graph can be built; repo search is `git grep` alone. */
  codeKnowledgeConfigured: boolean;
  /** Why code knowledge is unavailable, in words the UI can show directly. */
  codeKnowledgeUnavailableReason: string | null;
  storeRoot: string;
  providers: string[];
}

/**
 * A completed investigation, as the typed UI sees it.
 *
 * Note what is absent: `spokenAnswer`. That form exists for a voice channel,
 * where a 1,200-token technical account is the wrong thing to hear. The typed UI
 * wants the full answer, so the short one is dropped in the main process rather
 * than left here to be ignored.
 *
 * The question entry is not returned either. The renderer re-reads the whole
 * conversation once the answer lands, and both sides are already persisted.
 */
export interface AskResult {
  /** The persisted full answer, with the refs it was grounded in. */
  entry: ConversationEntry;
  refs: ContextRef[];
  /** The investigation could not be carried out; the answer says so. */
  failed: boolean;
}

export const IPC = {
  status: 'vowe:status',
  listProjects: 'vowe:projects:list',
  listSessions: 'vowe:sessions:list',
  getSession: 'vowe:session:get',
  getEvents: 'vowe:session:events',
  getEventsByIds: 'vowe:session:events-by-ids',
  getConversation: 'vowe:session:conversation',
  refreshInterpretation: 'vowe:session:refresh-interpretation',
  ask: 'vowe:companion:ask',
  sendInstruction: 'vowe:agent:send-instruction',
  launch: 'vowe:agent:launch',
  startObserving: 'vowe:observe:start',
  stopObserving: 'vowe:observe:stop',
  getObservation: 'vowe:observe:state',
  setPreference: 'vowe:observe:preference',
  startLive: 'vowe:live:start',
  stopLive: 'vowe:live:stop',
  liveStatus: 'vowe:live:status',
  livePlayback: 'vowe:live:playback',
  chooseFolder: 'vowe:dialog:choose-folder',
  getProjectKnowledge: 'vowe:knowledge:state',
  getProjectBrief: 'vowe:project:brief',
  getUserProfile: 'vowe:profile:get',
  setUserProfile: 'vowe:profile:set',
  getPresenceProfile: 'vowe:presence:get',
  setPresenceProfile: 'vowe:presence:set',
  openArtifact: 'vowe:artifact:open',
  getInvestigationSteps: 'vowe:investigation:steps',
  getDeliveries: 'vowe:session:deliveries',
  askProject: 'vowe:project:ask',
  getProjectConversation: 'vowe:project:conversation',
  listProjectMemories: 'vowe:project:memories',
  getTemperament: 'vowe:temperament:get',
  setTemperament: 'vowe:temperament:set',
  getVoicePreference: 'vowe:voice:get',
  setVoicePreference: 'vowe:voice:set',
  listVoices: 'vowe:voice:list',
  getAttentionCursor: 'vowe:attention:get',
  markSessionViewed: 'vowe:attention:mark',
  sessionOpened: 'vowe:session:opened',
  chooseFile: 'vowe:dialog:choose-file',
  getRunActivity: 'vowe:runs:activity',
  sessionsChanged: 'vowe:sessions:changed',
  sessionEvent: 'vowe:session:event',
  observationChanged: 'vowe:observe:changed',
  projectKnowledgeChanged: 'vowe:knowledge:changed',
  liveStatusChanged: 'vowe:live:status-changed',
  liveTranscript: 'vowe:live:transcript',
  investigationProgress: 'vowe:investigation:progress',
  isFullscreen: 'vowe:window:fullscreen',
  fullscreenChanged: 'vowe:window:fullscreen-changed',
  conversationChanged: 'vowe:session:conversation-changed',
  runActivityChanged: 'vowe:runs:activity-changed',
  projectConversationChanged: 'vowe:project:conversation-changed',
} as const;

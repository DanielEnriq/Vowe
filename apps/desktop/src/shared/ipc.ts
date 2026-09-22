import type {
  AgentSession,
  ContextRef,
  ConversationChange,
  ConversationEntry,
  InstructionResult,
  LiveStatus,
  NormalizedEvent,
  ObservationStatus,
  PlaybackReport,
  PresenceProfile,
  Project,
  ProjectBrief,
  RepoIndexState,
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
  askCompanion(sessionId: string, question: string): Promise<AskResult>;

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

  onSessionsChanged(listener: () => void): () => void;
  onSessionEvent(listener: (event: NormalizedEvent) => void): () => void;
  onObservationChanged(listener: (sessionId: string) => void): () => void;
  onProjectKnowledgeChanged(listener: (projectId: string) => void): () => void;
  onLiveStatus(listener: (status: LiveStatus) => void): () => void;
  /** Vowe started or finished executing something. */
  onRunActivity(listener: (activity: VoweRunActivity) => void): () => void;
  /**
   * A session's persisted conversation has changed — typed answer, answer
   * delegated from Vo, or an instruction and its result. Carries the session,
   * not the entry: the renderer re-reads, so there is one source of truth.
   */
  onConversationChanged(listener: (change: ConversationChange) => void): () => void;
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
  getRunActivity: 'vowe:runs:activity',
  sessionsChanged: 'vowe:sessions:changed',
  sessionEvent: 'vowe:session:event',
  observationChanged: 'vowe:observe:changed',
  projectKnowledgeChanged: 'vowe:knowledge:changed',
  liveStatusChanged: 'vowe:live:status-changed',
  conversationChanged: 'vowe:session:conversation-changed',
  runActivityChanged: 'vowe:runs:activity-changed',
} as const;

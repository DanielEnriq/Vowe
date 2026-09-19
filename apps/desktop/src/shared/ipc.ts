import type {
  AgentSession,
  ConversationEntry,
  InstructionResult,
  LiveStatus,
  NormalizedEvent,
  ObservationStatus,
  SurfaceUpdate,
  TraceWindow,
  WindowNote,
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

  listSessions(): Promise<AgentSession[]>;
  getSession(sessionId: string): Promise<AgentSession | null>;
  getEvents(sessionId: string, limit?: number): Promise<NormalizedEvent[]>;
  getEventsByIds(sessionId: string, ids: string[]): Promise<NormalizedEvent[]>;
  getConversation(sessionId: string): Promise<ConversationEntry[]>;
  refreshInterpretation(sessionId: string): Promise<void>;

  /** Answered from observed state. Never reaches the coding agent. */
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

  onSessionsChanged(listener: () => void): () => void;
  onSessionEvent(listener: (event: NormalizedEvent) => void): () => void;
  onObservationChanged(listener: (sessionId: string) => void): () => void;
  onLiveStatus(listener: (status: LiveStatus) => void): () => void;
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
  storeRoot: string;
  providers: string[];
}

export interface AskResult {
  question: ConversationEntry;
  answer: ConversationEntry;
  llmBacked: boolean;
}

export const IPC = {
  status: 'vowe:status',
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
  sessionsChanged: 'vowe:sessions:changed',
  sessionEvent: 'vowe:session:event',
  observationChanged: 'vowe:observe:changed',
  liveStatusChanged: 'vowe:live:status-changed',
} as const;

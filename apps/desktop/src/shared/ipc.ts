import type {
  AgentSession,
  ConversationEntry,
  InstructionResult,
  NormalizedEvent,
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

  /** Native folder picker for choosing where a new session runs. */
  chooseFolder(): Promise<string | null>;

  onSessionsChanged(listener: () => void): () => void;
  onSessionEvent(listener: (event: NormalizedEvent) => void): () => void;
}

export interface AppStatus {
  /** False when no LLM credential is configured. */
  llmConfigured: boolean;
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
  chooseFolder: 'vowe:dialog:choose-folder',
  sessionsChanged: 'vowe:sessions:changed',
  sessionEvent: 'vowe:session:event',
} as const;

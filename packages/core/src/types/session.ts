/**
 * Provider-independent session model.
 *
 * Nothing in this file may name a concrete provider, a fixed number of
 * sessions, or a role ("frontend agent"). A session's identity, task, status
 * and capabilities are all discovered at runtime.
 */

/** Coarse, provider-independent lifecycle state. */
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'idle'
  | 'finished'
  | 'unknown';

/**
 * How Vowe is attached to a session. This is what makes capabilities dynamic:
 * the same provider yields different control affordances depending on how the
 * session came to exist and whether its process is currently alive.
 *
 * - `managed`       Vowe launched it and holds the live control handle.
 * - `external-live` Discovered, currently running under a process we do not own.
 * - `external-idle` Discovered, not currently running; can be resumed.
 */
export type AttachMode = 'managed' | 'external-live' | 'external-idle';

/**
 * What we can actually do with this session right now. Capabilities are
 * computed per session on every discovery pass, never declared per provider.
 */
export interface SessionCapabilities {
  /** We can read this session's event stream. */
  observe: boolean;
  /** We can deliver a new instruction to the underlying worker. */
  sendInstruction: boolean;
  /** We can interrupt work in progress. */
  interrupt: boolean;
  /** We can restart/continue the session after it has stopped. */
  resume: boolean;
}

export interface AgentSession {
  /** Durable Vowe-side identity: `${provider}:${providerSessionId}`. */
  id: string;
  /** Adapter that owns this session, e.g. `claude-code`. */
  provider: string;
  /** The provider's own identifier. Only the adapter interprets this. */
  providerSessionId: string;
  attachMode: AttachMode;
  /**
   * What we understand the worker to be trying to accomplish, derived from
   * observation. `null` when nothing has been observed yet.
   */
  task: string | null;
  /**
   * Best available human label. Falls back through provider name / working
   * directory / short id, but the durable identity is always `id`.
   */
  displayLabel: string;
  /** Working directory, when the provider exposes one. */
  cwd: string | null;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  capabilities: SessionCapabilities;
  /** Populated by the interpretation layer, not by the adapter. */
  semanticState: SemanticState | null;
}

export interface SemanticState {
  task: string | null;
  /** e.g. exploring, editing, running, debugging, testing, waiting. */
  phase: string;
  currentActivity: string;
  recentProgress: string[];
  lastMeaningfulUpdate: string;
  source: 'heuristic' | 'llm';
  /**
   * Which observed evidence produced this state. Required on every write so a
   * derived description can always be traced back to raw events.
   */
  provenance: SemanticProvenance;
  updatedAt: string;
}

export interface SemanticProvenance {
  /** Normalized event ids that informed this state. */
  eventIds: string[];
  /** Highest event sequence number considered. */
  throughSeq: number;
}

export const NO_CAPABILITIES: SessionCapabilities = {
  observe: false,
  sendInstruction: false,
  interrupt: false,
  resume: false,
};

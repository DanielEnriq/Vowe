/**
 * Provider-independent session model.
 *
 * Nothing in this file may name a concrete provider, a fixed number of
 * sessions, or a role ("frontend agent"). A session's identity, task, status
 * and capabilities are all discovered at runtime.
 */

/**
 * Coarse, provider-independent lifecycle state.
 *
 * **`waiting` does not mean the session is waiting on you.** It is the
 * ordinary between-turn state — a worker that is not currently busy — and a
 * provider reports it for any lull at all. Nothing about it says a person
 * could help.
 *
 * Human attention is carried by *evidence events*, never by this field: a
 * `permission_requested` event, or a `session_waiting` event the adapter
 * marked with `detail.awaitingHuman === true` because it knows that
 * particular stop was a question for a person. Status answers "is this
 * session alive?"; those events answer "can you do something about it?".
 *
 * Conflating the two is what makes an attention list unreadable, so the
 * `Needs You` projection admits only the events and ignores this field except
 * as a liveness gate. See `product/attention.ts`.
 */
export type SessionStatus =
  | 'starting'
  | 'working'
  /** Between turns. Ordinary idleness — see the note above, not attention. */
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
  /**
   * A short name for this work, produced once from the task.
   *
   * Stored beside the provider's own metadata rather than over it: `task` and
   * `displayLabel` remain exactly what the adapter reported, and this is
   * Vowe's reading of them. Absent until generated, which is why every display
   * path goes through `displayTitle`.
   */
  generatedTitle?: string;
  /** Working directory, when the provider exposes one. */
  cwd: string | null;
  /**
   * The repository this session is working in.
   *
   * Assigned by the project layer from `cwd`, not by the adapter — a provider
   * reports where a session is, and Vowe decides what that means. `null` only
   * when no working directory is known at all; such a session is still listed,
   * never dropped.
   */
  projectId: string | null;
  /**
   * This session's own worktree, when it is not the repository's main one.
   *
   * Present only when it differs from the project's root, so an ordinary
   * session does not look like it is somewhere unusual.
   */
  worktree?: string;
  branch?: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  capabilities: SessionCapabilities;
  /**
   * When the developer put this session away, if they have.
   *
   * Attention, not data: an archived session keeps every event, window and
   * answer it had, and simply stops appearing in the places that are meant to
   * show what is going on now. It comes back by being opened again.
   */
  archivedAt?: string;
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

/**
 * Provider-independent session model.
 *
 * Nothing in this file may name a concrete provider, a fixed number of
 * sessions, or a role ("frontend agent"). A session's identity, task, status
 * and capabilities are all discovered at runtime.
 */

import type { ContextRef } from '../context/refs.js';

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
  /**
   * We can start a brand-new session with this session's provider.
   *
   * A property of the provider rather than of this particular session, but it
   * is reported here because it is environment-bound: an adapter whose CLI is
   * not installed cannot launch anything, however well documented its flags.
   */
  launch: boolean;
  /**
   * The worker's own reasoning is recorded *and readable by us*.
   *
   * False covers three different situations that look identical from outside,
   * and deliberately does not distinguish them: the provider records no
   * reasoning, or records it and we chose not to carry it, or records it in a
   * form we cannot read (an encrypted blob, a bare signature). What the
   * product needs from this flag is only ever the same question — may a
   * surface claim that an empty reasoning area means the worker did not think?
   * It may not.
   *
   * Reasoning is *supporting evidence only*. Nothing in observation,
   * interpretation or milestones may depend on it, because most providers do
   * not offer it and Vowe has to understand those sessions just as well.
   */
  reasoning: boolean;
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

/**
 * One thing that changed what the developer should believe about a worker.
 *
 * Durable in a way `currentActivity` is not: activity is replaced constantly
 * and nobody scrolls back through it, whereas these accumulate and are meant to
 * be readable after looking away. Every one carries the refs of the evidence it
 * was drawn from, so a claim can always be descended into.
 */
export interface MeaningfulUpdate {
  /** The note or anchoring event id, so a recompute yields the same item. */
  id: string;
  text: string;
  at: string;
  refs: ContextRef[];
}

/** How many durable updates are worth carrying. Beyond this it is a log. */
export const MEANINGFUL_UPDATE_LIMIT = 5;

export interface SemanticState {
  task: string | null;
  /** e.g. exploring, editing, running, debugging, testing, waiting. */
  phase: string;
  currentActivity: string;
  /**
   * Raw recent progress, from the deterministic interpreter.
   *
   * The floor, not the product contract: these are event summaries, and what a
   * developer reads is `meaningfulUpdates`. Kept because the companion's
   * model-free description and the question prompts are built on it.
   */
  recentProgress: string[];
  lastMeaningfulUpdate: string;
  /**
   * Where the work stands, as the observer currently understands it.
   *
   * Present-state orientation rather than history — one to three sentences
   * about what is done and what is unresolved. What happened earlier lives in
   * `meaningfulUpdates`, where it keeps its evidence.
   *
   * `null` whenever no observation model has interpreted this session. There is
   * deliberately no deterministic stand-in: unlike an activity label, there is
   * no honest prose a rule could produce for "what does this worker believe
   * now?", and inventing one would be the first step in a chain that ends with
   * a confident wrong answer.
   */
  currentUnderstanding: string | null;
  /** Newest last, capped. Only what should change a developer's mental model. */
  meaningfulUpdates: MeaningfulUpdate[];
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
  launch: false,
  reasoning: false,
};

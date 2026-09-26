import type { EvidenceSource } from '../evidence/types.js';
import type { AdapterEvent } from './events.js';
import type { AgentSession } from './session.js';

export type Unsubscribe = () => void;

export interface InstructionResult {
  delivered: boolean;
  /** How the instruction reached the worker, for the audit trail. */
  via: string;
  /** Present when the provider echoes an id for the delivered instruction. */
  providerMessageId?: string;
  note?: string;
}

export interface LaunchOptions {
  cwd: string;
  prompt: string;
}

/**
 * The boundary between Vowe and one coding-agent provider.
 *
 * Everything provider-specific — identifiers, transport, event shapes, file
 * layouts — stays behind this interface. The rest of the application only ever
 * sees normalized sessions and normalized events.
 *
 * Providers differ in what they can do, so an adapter reports capabilities per
 * session rather than promising every operation. Optional methods may be
 * absent entirely; present methods must still throw
 * `CapabilityUnsupportedError` when a particular session cannot support them.
 */
export interface AgentAdapter {
  readonly provider: string;

  /** Current best view of every session this adapter can see. */
  discoverSessions(): Promise<AgentSession[]>;

  getSession(providerSessionId: string): Promise<AgentSession | null>;

  /** Observation sources compose independently from worker control. */
  evidenceSources?(providerSessionId: string): EvidenceSource[];

  /**
   * Stream observable activity. Implementations should replay from
   * `fromRawRefSource`-independent internal offsets so no event is lost across
   * restarts; ordering must be stable.
   */
  subscribeToEvents(
    providerSessionId: string,
    onEvent: (event: AdapterEvent) => void,
  ): Unsubscribe;

  /** Deliver an instruction to the actual worker. */
  sendInstruction(
    providerSessionId: string,
    text: string,
  ): Promise<InstructionResult>;

  /** Optional: providers that can start new work on our behalf. */
  launchSession?(options: LaunchOptions): Promise<AgentSession>;

  /**
   * Whether launching would actually work *here, now*.
   *
   * Separate from whether `launchSession` exists, because the two answers
   * differ: an adapter can implement launching perfectly against a documented
   * CLI that is not installed on this machine. Implementing the method is a
   * claim about the provider; this is a claim about the environment, and only
   * the second one may reach a button. Absent means "yes, whenever the method
   * exists".
   */
  canLaunch?(): boolean;

  /** Optional: providers that can interrupt work in progress. */
  interrupt?(providerSessionId: string): Promise<void>;

  /** Release watchers, subprocesses and handles. */
  dispose?(): Promise<void>;
}

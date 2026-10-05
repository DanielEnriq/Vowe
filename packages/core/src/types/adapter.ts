import type { EvidenceSource } from '../evidence/types.js';
import type { WorkerOutcome, WorkerQuestionEvent } from '../fleet/types.js';
import type { TranscriptDelta, TranscriptPage } from '../fleet/transcript.js';
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
  /**
   * Withhold the provider's file-writing tools. For a worker whose job is to
   * read and answer, such as a captain; not a sandbox.
   */
  readOnly?: boolean;
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

  /**
   * Optional: questions a worker put to a person and is blocked on.
   *
   * Only for questions the adapter is actually holding open, so that
   * `answerQuestion` can settle them in place. A question that merely appears
   * in a transcript is evidence, not this.
   */
  onQuestion?(listener: (event: WorkerQuestionEvent) => void): Unsubscribe;

  /**
   * Answer a held question in place. False when it is no longer held — the
   * caller decides whether to send the answer some other way.
   */
  answerQuestion?(providerSessionId: string, questionId: string, answer: string): Promise<boolean>;

  /** Optional: how a worker's turns end, for workers whose turns it can see. */
  onOutcome?(listener: (outcome: WorkerOutcome) => void): Unsubscribe;
  outcomeOf?(providerSessionId: string): WorkerOutcome | null;

  /**
   * Optional: Fleet's transcript feed, a reading surface separate from
   * `subscribeToEvents`. A page's `sessionId` and every delta's `sessionId`
   * are Vowe's session id, not the provider's.
   */
  readTranscript?(
    providerSessionId: string,
    options?: { before?: string; limit?: number },
  ): Promise<TranscriptPage>;
  onTranscriptDelta?(listener: (delta: TranscriptDelta) => void): Unsubscribe;

  /** Release watchers, subprocesses and handles. */
  dispose?(): Promise<void>;
}

/**
 * The fleet's own records: a worker asking something, a captain answering it,
 * and what a worker's last turn came to.
 *
 * Types only, so the renderer can import them. Nothing here is session
 * conversation state — a captain exchange is its own fact, committed in its
 * own table, and never appears in either session's thread.
 */

/**
 * A worker stopped to ask a person something, and is blocked until answered.
 *
 * Surfaced by an adapter that can hold the question open (see
 * `AgentAdapter.onQuestion`). `id` is the adapter's handle for answering it in
 * place; `toolUseId` correlates it with the transcript's own record, when the
 * provider has one.
 */
export interface WorkerQuestion {
  id: string;
  /** Vowe session id of the worker that asked. */
  sessionId: string;
  toolUseId?: string;
  question: string;
  options?: string[];
  askedAt: string;
}

/** A held question was settled, by the host or by something else. */
export interface WorkerQuestionSettled {
  id: string;
  sessionId: string;
  /** What the worker received, or `null` when the question was abandoned. */
  answer: string | null;
  /**
   * `host`: answered through `answerQuestion`. `instruction`: an ordinary
   * instruction arrived while it was held and was taken as the answer.
   * `aborted`: the turn ended without an answer.
   */
  by: 'host' | 'instruction' | 'aborted';
  at: string;
}

export type WorkerQuestionEvent =
  | { type: 'asked'; question: WorkerQuestion }
  | { type: 'settled'; settled: WorkerQuestionSettled };

/**
 * What a worker's most recent turn came to, as the provider reported it.
 *
 * `working` a turn is in flight; `completed` the last turn ended successfully
 * with nothing queued; `failed` the last turn ended in an error result, or the
 * worker's process failed; `ended` the provider closed the session cleanly.
 * Known only for workers whose turns the adapter can see end — a session
 * observed from its transcript alone has none.
 */
export type WorkerOutcomeState = 'working' | 'completed' | 'failed' | 'ended';

export interface WorkerOutcome {
  sessionId: string;
  state: WorkerOutcomeState;
  at: string;
  /** The turn's final text, when the provider reports one. */
  text?: string;
  /** Why it failed, in the provider's words. */
  error?: string;
}

/**
 * One question from a worker, and where it went.
 *
 * `route` says who is answering it: `captain` while a wired captain has it or
 * once the captain answered; `you` when nothing is wired, or when the captain
 * passed it on. `status` is where that answer stands:
 *
 *  - captain / pending  — relayed, the captain is working on it
 *  - captain / answered — the captain answered (`captainAnswer`)
 *  - you / pending      — no captain may take it; waiting for you
 *  - you / passed       — the captain passed it to you (`passedToYouReason`)
 *  - you / answered     — you answered (`userAnswer`)
 *
 * Needs you is exactly `route === 'you' && status !== 'answered'`.
 */
export interface CaptainExchange {
  id: string;
  projectId: string;
  askerSessionId: string;
  /** The adapter's handle for the held question. */
  questionId: string;
  toolUseId?: string;
  captainSessionId: string | null;
  question: string;
  options?: string[];
  captainAnswer: string | null;
  route: CaptainRoute;
  passedToYouReason?: string;
  userAnswer: string | null;
  status: CaptainExchangeStatus;
  /** How the answer reached the asking worker; `null` until it has. */
  delivery: CaptainDelivery | null;
  askedAt: string;
  answeredAt: string | null;
}

export type CaptainRoute = 'captain' | 'you';
export type CaptainExchangeStatus = 'pending' | 'answered' | 'passed';
/**
 * `in-place`: answered the held question, so the worker continues its turn.
 * `instruction`: the question was no longer held, so the answer went as the
 * worker's next turn. `failed`: neither was possible.
 */
export type CaptainDelivery = 'in-place' | 'instruction' | 'failed';

export interface CaptainExchangeChange {
  exchangeId: string;
  projectId: string;
}

/** Persistence for captain exchanges, beside the event store. */
export interface CaptainExchangeStore {
  saveCaptainExchange(exchange: CaptainExchange): Promise<CaptainExchange>;
  getCaptainExchange(exchangeId: string): CaptainExchange | null;
  /** Newest first. */
  listCaptainExchanges(projectId: string): CaptainExchange[];
  /** After commit. */
  onCaptainExchangeChanged(listener: (change: CaptainExchangeChange) => void): () => void;
}

/** Status is a dot and a word; the renderer picks the token. */
export type FleetStatus = 'running' | 'needs-you' | 'done' | 'failed' | 'idle';

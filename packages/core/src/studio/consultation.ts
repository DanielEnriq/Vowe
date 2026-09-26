import type { ContextRef } from '../context/refs.js';

/**
 * A bounded, read-only question put to a coding harness about a repository.
 *
 * Vowe does not try to be the expert on a repository's code: coding harnesses
 * already search, read and understand it far better. When a design depends on
 * what the implementation actually does, Vowe asks one of them — and only
 * asks. A consultation cannot edit, run commands, reach a worker Vowe is
 * observing, or leave a session behind.
 *
 * Deliberately separate from both other ways Vowe touches the outside world:
 *
 *  - **Worker control** (`SessionRegistry` / `AgentAdapter`) makes a coding
 *    agent do work. A consultant is never registered there.
 *  - **Investigation** (`DelegatedQuestionRunner` / `ContextNavigator`) reads
 *    what Vowe has already observed. A consultation asks a harness to go and
 *    look at the repository itself.
 *
 * `main` constructs one and hands it to `StudioService` and nothing else.
 */
export interface RepositoryConsultant {
  /** Human name of the harness, for the receipt's secondary detail. */
  readonly provider: string;
  consult(request: ConsultationRequest): Promise<ConsultationFinding>;
}

export interface ConsultationRequest {
  /** The repository to inspect. The harness cannot read outside it. */
  repoRoot: string;
  /** One self-contained question. */
  question: string;
  /** Why it matters to the design, so the harness knows what to look for. */
  context?: string;
  signal: AbortSignal;
  /**
   * What the harness is doing now — "Reading observer-runner.ts" — derived
   * from its actual tool calls. Never awaited; a view concern only.
   */
  onActivity?: (activity: { label: string }) => void;
}

/**
 * What came back.
 *
 * `unavailable`, `failed` and `cancelled` are *expected* outcomes — no
 * sign-in, a budget reached, the developer pressing stop — and are reported
 * rather than thrown so a design turn can say honestly that it could not
 * check. An unexpected fault still throws.
 */
export type ConsultationFinding =
  | {
      status: 'answered';
      answer: string;
      /** How far the harness got: it confirmed, partly established, or found nothing. */
      confidence: 'confirmed' | 'partial' | 'not_found';
      /** Verified `repo:` refs inside the repository, the files it opened first. */
      refs: ContextRef[];
      provider: string;
      durationMs: number;
      /** Repository-relative paths the harness actually read or searched. */
      inspected: string[];
      /** As the harness reported it; an estimate, not an invoice. */
      costUsd?: number;
    }
  | {
      status: 'unavailable' | 'failed' | 'cancelled';
      reason: string;
      provider: string;
      durationMs: number;
    };

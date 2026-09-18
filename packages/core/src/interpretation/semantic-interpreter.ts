import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession, SemanticState } from '../types/session.js';

export interface InterpretationInput {
  session: AgentSession;
  previous: SemanticState | null;
  /** Evidence window, oldest first. */
  events: NormalizedEvent[];
}

/**
 * Derives an evolving semantic view of a session from its observed events.
 *
 * Implementations must stamp provenance pointing at the events they used, so
 * any derived description can be traced back to raw evidence.
 */
export interface SemanticInterpreter {
  readonly source: SemanticState['source'];
  interpret(input: InterpretationInput): Promise<SemanticState>;
}

export function provenanceFor(events: NormalizedEvent[]) {
  return {
    eventIds: events.map((e) => e.id),
    throughSeq: events.length ? events[events.length - 1]!.seq : 0,
  };
}

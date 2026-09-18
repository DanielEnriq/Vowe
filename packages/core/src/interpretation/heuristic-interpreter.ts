import type { NormalizedEvent } from '../types/events.js';
import type { SemanticState } from '../types/session.js';
import {
  provenanceFor,
  type InterpretationInput,
  type SemanticInterpreter,
} from './semantic-interpreter.js';

const PHASE_BY_KIND: Partial<Record<NormalizedEvent['kind'], string>> = {
  session_started: 'starting',
  user_instruction: 'reading the request',
  agent_message: 'explaining',
  tool_started: 'exploring',
  tool_finished: 'exploring',
  command_started: 'running commands',
  command_finished: 'running commands',
  file_changed: 'editing',
  test_started: 'testing',
  test_finished: 'testing',
  permission_requested: 'waiting for permission',
  session_waiting: 'waiting',
  session_finished: 'finished',
};

/**
 * Deterministic interpretation. Always available, needs no credentials, and
 * is the floor the product degrades to when no LLM is configured.
 */
export class HeuristicInterpreter implements SemanticInterpreter {
  readonly source = 'heuristic' as const;

  async interpret(input: InterpretationInput): Promise<SemanticState> {
    const { session, events } = input;
    // An unclassified record is kept as evidence, but it makes a poor
    // description of what a session is doing, so prefer the last record we
    // actually understood.
    const last =
      [...events].reverse().find((event) => event.kind !== 'unknown') ??
      events[events.length - 1] ??
      null;
    const now = new Date().toISOString();

    return {
      task: session.task,
      phase: last ? (PHASE_BY_KIND[last.kind] ?? 'working') : 'no activity yet',
      currentActivity: last ? last.summary : 'Nothing observed yet.',
      recentProgress: progressFrom(events),
      lastMeaningfulUpdate: last?.at ?? session.lastActivityAt,
      source: this.source,
      provenance: provenanceFor(events),
      updatedAt: now,
    };
  }
}

/** The most recent distinct things that actually happened, oldest first. */
function progressFrom(events: NormalizedEvent[], limit = 6): string[] {
  const interesting = new Set<NormalizedEvent['kind']>([
    'agent_message',
    'file_changed',
    'command_finished',
    'test_finished',
    'user_instruction',
    'session_finished',
  ]);
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const event = events[i]!;
    if (!interesting.has(event.kind)) continue;
    if (out.includes(event.summary)) continue;
    out.push(event.summary);
  }
  return out.reverse();
}

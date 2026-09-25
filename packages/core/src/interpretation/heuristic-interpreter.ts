import { PHASE_BY_KIND, workerActivity } from '../product/worker-activity.js';
import type { NormalizedEvent } from '../types/events.js';
import type { SemanticState } from '../types/session.js';
import {
  provenanceFor,
  type InterpretationInput,
  type SemanticInterpreter,
} from './semantic-interpreter.js';


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

    /*
     * The same derivation the fast path publishes between interpretation
     * passes. Calling it here rather than falling back to the last event's raw
     * summary means the two halves of observation never disagree about what a
     * worker is doing — and it is why a debounced pass can no longer overwrite
     * a specific label with a generic one.
     */
    const activity = workerActivity(events);

    return {
      task: session.task,
      phase:
        activity?.phase ??
        (last ? (PHASE_BY_KIND[last.kind] ?? 'working') : 'no activity yet'),
      currentActivity: activity?.label ?? input.previous?.currentActivity ?? '',
      recentProgress: progressFrom(events),
      lastMeaningfulUpdate: last?.at ?? session.lastActivityAt,
      // The deterministic interpreter reaches no understanding and records no
      // durable updates; both belong to the observer. Whatever it established
      // is carried through untouched so a heuristic pass never erases it.
      currentUnderstanding: input.previous?.currentUnderstanding ?? null,
      meaningfulUpdates: input.previous?.meaningfulUpdates ?? [],
      source: this.source,
      provenance: provenanceFor(events),
      updatedAt: now,
    };
  }
}

/** The most recent distinct things that actually happened, oldest first. */
function progressFrom(events: NormalizedEvent[], limit = 6): string[] {
  // `agent_reasoning` is not here on purpose: what a session is doing has to
  // be derivable from what it did, so that a provider which records no
  // thinking is understood exactly as well as one that does.
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

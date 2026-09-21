import type { NormalizedEvent } from '../types/events.js';
import type { SemanticState } from '../types/session.js';

/**
 * What Vowe observed, described without a model.
 *
 * This is the floor a question degrades to when no model is configured. It is
 * deliberately not an answer — it does not read the question — but reporting
 * the session's phase, its current activity and its last few events is far more
 * use than saying only that nothing is configured.
 *
 * Observation has no equivalent floor, on purpose: there is no deterministic
 * prose that could stand in for having understood a window, so an uninterpreted
 * window says so plainly instead.
 */
export function describeObservedState(
  semanticState: SemanticState | null,
  events: NormalizedEvent[],
): string {
  const lines: string[] = [];
  if (semanticState) {
    lines.push(`Phase: ${semanticState.phase}`);
    lines.push(`Current activity: ${semanticState.currentActivity}`);
    if (semanticState.recentProgress.length) {
      lines.push('Recent progress:');
      for (const item of semanticState.recentProgress) lines.push(`- ${item}`);
    }
  }
  const recent = events.slice(-8);
  if (recent.length) {
    lines.push('', 'Most recent observed events:');
    for (const event of recent) lines.push(`- [${event.kind}] ${event.summary}`);
  }
  return lines.length ? lines.join('\n') : 'Nothing has been observed yet.';
}

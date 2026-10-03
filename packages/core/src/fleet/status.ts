import type { AttentionItem } from '../product/attention.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import type { CaptainExchange, FleetStatus, WorkerOutcome } from './types.js';

export interface FleetStatusInput {
  session: AgentSession;
  /** `attentionFor` over the session's full history. */
  attention: readonly AttentionItem[];
  /** The session's events, to tie attention items to exchanges. */
  events?: readonly NormalizedEvent[];
  /** How the provider says the latest turn ended, where it can tell. */
  outcome?: WorkerOutcome | null;
  /** Exchanges this session asked. */
  exchanges?: readonly CaptainExchange[];
}

/**
 * One word for a node on the fleet canvas. First match wins:
 *
 *  - `needs-you`: a question routed to the developer is unanswered, or the
 *    session has attention the relay is not handling. A question a wired
 *    captain has is not needs-you — that is the point of the wire.
 *  - `failed`: the provider said the latest turn ended in an error, or the
 *    worker's process failed; or the session's last event is a finish marked
 *    failed.
 *  - `running`: a turn is in flight (by the provider's own signal, or, where
 *    there is none, the session's status).
 *  - `done`: the latest turn completed with nothing queued, the provider
 *    closed the session cleanly, or the session finished.
 *  - `idle`: none of the above — observed, not working, nothing pending.
 */
export function fleetStatusOf(input: FleetStatusInput): FleetStatus {
  const { session, attention, events = [], outcome = null, exchanges = [] } = input;
  const mine = exchanges.filter((exchange) => exchange.askerSessionId === session.id);

  if (mine.some((exchange) => exchange.route === 'you' && exchange.status !== 'answered')) {
    return 'needs-you';
  }
  if (attention.length) {
    const handled = new Set(mine.map((exchange) => exchange.toolUseId).filter(Boolean));
    const byId = new Map(events.map((event) => [event.id, event]));
    const unhandled = attention.some((item) => {
      const ref = item.refs.find((r) => r.kind === 'event');
      const event = ref && ref.kind === 'event' ? byId.get(ref.eventId) : undefined;
      const toolUseId = event?.detail?.['toolUseId'];
      return !(typeof toolUseId === 'string' && handled.has(toolUseId));
    });
    if (unhandled) return 'needs-you';
  }

  const finished = lastFinish(events);
  if (outcome?.state === 'failed') return 'failed';
  if (!outcome && finished?.detail?.['failed'] === true) return 'failed';

  if (outcome) {
    if (outcome.state === 'working') return 'running';
    return 'done';
  }
  if (session.status === 'working' || session.status === 'starting') return 'running';
  if (session.status === 'finished' || finished) return 'done';
  return 'idle';
}

/** The session's finish, if its last meaningful event is one. */
function lastFinish(events: readonly NormalizedEvent[]): NormalizedEvent | null {
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at]!;
    if (event.kind === 'unknown' || event.kind === 'agent_reasoning') continue;
    return event.kind === 'session_finished' ? event : null;
  }
  return null;
}

import type { ContextRef } from '../context/refs.js';
import { isActiveSession } from '../projects/project.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import { plainText } from './session-display.js';

/**
 * `Needs You` — work that is actually waiting on a person.
 *
 * The meaning is narrow on purpose: **if the developer opens this item, there
 * is a decision, answer, approval or intervention they can provide.** A list
 * that also contains "this session is idle" and "this one finished" is a list
 * nobody reads, and the moment it stops being read the one real permission
 * request in it is lost too.
 *
 * This is stricter than the current `SessionDetail` behaviour, which flags
 * every waiting-ish event. It is a pure projection: no model, no persisted
 * attention log, no state to invalidate — recompute it and you get the same
 * answer from the same events.
 */

/**
 * Only the two kinds the evidence can actually produce.
 *
 * `blocked` and `risk` are real product concepts and will likely earn a place
 * here, but nothing in the event model distinguishes them today and a kind
 * that cannot be produced is a promise the UI would have to fake.
 */
export type AttentionKind = 'permission' | 'decision';

export interface AttentionItem {
  /** Deterministic, so the same state always yields the same item. */
  id: string;
  projectId: string;
  sessionId: string;
  kind: AttentionKind;
  summary: string;
  refs: ContextRef[];
  createdAt: string;
}

/**
 * Detail flag an adapter sets when a wait is explicitly for a human decision.
 *
 * The distinction this projection rests on is **event kind versus session
 * status**. A session whose status is `waiting` is merely idle between turns —
 * that is ordinary and is never attention. A `session_waiting` *event* is the
 * worker stopping and asking, but only an adapter knows whether a given stop
 * was a question for a person or a pause of its own; so the adapter says so,
 * in a word that names no provider, and core believes it rather than guessing.
 *
 * Absent, the event is not admitted. That is the conservative direction, and
 * it means trace recorded before an adapter learned to set this flag simply
 * does not raise attention rather than raising it wrongly.
 */
const AWAITING_HUMAN = 'awaitingHuman';

/**
 * Unresolved human waits in one session.
 *
 * `events` should be the session's full history. Attention is about whether
 * something is *still* unanswered, and a window over recent events could cut
 * between a request and its answer — which would either resurrect a settled
 * question or hide a live one. Correctness first; this is a handful of
 * array passes over data the store already holds in memory.
 */
export function attentionFor(
  session: AgentSession,
  projectId: string,
  events: NormalizedEvent[],
): AttentionItem[] {
  // A dead session cannot receive an answer, so nothing in it can need you.
  // This is also what retires stale items: no separate expiry rule, no clock.
  if (!isActiveSession(session)) return [];

  const answeredAt = lastSeqByToolUse(events);
  const items: AttentionItem[] = [];

  for (const event of events) {
    const kind = attentionKindOf(event);
    if (!kind) continue;
    if (isAnswered(event, answeredAt)) continue;

    items.push({
      id: `${session.id}#${event.id}`,
      projectId,
      sessionId: session.id,
      kind,
      summary: plainText(event.summary, 140),
      refs: [{ kind: 'event', sessionId: session.id, eventId: event.id }],
      createdAt: event.at,
    });
  }

  return items;
}

function attentionKindOf(event: NormalizedEvent): AttentionKind | null {
  // Declared in the event model, emitted by no adapter yet. Admitted anyway:
  // the rule is what matters, and the day a provider reports one it works.
  if (event.kind === 'permission_requested') return 'permission';

  if (event.kind === 'session_waiting' && event.detail?.[AWAITING_HUMAN] === true) {
    return 'decision';
  }

  return null;
}

/**
 * Whether the thing that was waiting has since been answered.
 *
 * Only matching evidence counts — the result carrying the same `toolUseId` as
 * the request. Anything looser is a guess: a developer typing an unrelated
 * instruction has not approved the plan they were shown, and treating that as
 * an answer would quietly drop the one item that needed them.
 *
 * A request with no `toolUseId` is therefore never resolvable by evidence. It
 * stays until the session stops being live, which is the honest outcome.
 */
function isAnswered(
  request: NormalizedEvent,
  answeredAt: Map<string, number>,
): boolean {
  const toolUseId = correlationId(request);
  if (!toolUseId) return false;
  const latest = answeredAt.get(toolUseId);
  return latest !== undefined && latest > request.seq;
}

/** Highest sequence at which each tool call was mentioned. One pass. */
function lastSeqByToolUse(events: NormalizedEvent[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const event of events) {
    const toolUseId = correlationId(event);
    if (!toolUseId) continue;
    const current = seen.get(toolUseId);
    if (current === undefined || event.seq > current) seen.set(toolUseId, event.seq);
  }
  return seen;
}

function stringDetail(event: NormalizedEvent, key: string): string | null {
  const value = event.detail?.[key];
  return typeof value === 'string' && value ? value : null;
}

/** The adapters' existing call/result correlation fields. */
function correlationId(event: NormalizedEvent): string | null {
  return stringDetail(event, 'toolUseId') ?? stringDetail(event, 'toolCallId') ?? stringDetail(event, 'callId');
}

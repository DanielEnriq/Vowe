import { parseRef, type ContextRef } from '../context/refs.js';
import type { EventStore } from '../store/event-store.js';

/** Current eligibility, not a rewrite of the historical object a citation opens. */
export function hasCurrentSupport(store: EventStore, value: ContextRef | string): boolean {
  const ref = parseRef(value);
  if (!ref) return false;
  if (ref.kind === 'event' || ref.kind === 'transcript') {
    const event = store.getEventsByIds(ref.sessionId, [ref.eventId])[0];
    return !!event && event.supportStatus !== 'superseded';
  }
  if (ref.kind === 'window') {
    const window = store.getWindow(ref.sessionId, ref.windowId);
    return !!window && !window.stale;
  }
  if (ref.kind === 'trace')
    // Only the cited range, without payloads: this runs for every citation shown.
    return !store
      .getEvents(ref.sessionId, {
        sinceSeq: ref.startSeq - 1,
        untilSeq: ref.endSeq,
        audit: true,
        omitRaw: true,
      })
      .some((e) => e.supportStatus === 'superseded');
  return true;
}

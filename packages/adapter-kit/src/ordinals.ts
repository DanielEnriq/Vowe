import type { AdapterEvent } from '@vowe/core';

/**
 * Stamp each event with its position among its record's own output.
 *
 * Applied once, where a record becomes events, so every adapter and the replay
 * path get it without having to remember to. A record that produced a single
 * event is left alone: its ordinal is `0` either way, and not writing one keeps
 * the common case's `rawRef` exactly as it was.
 *
 * This is what lets the store tell "four events from one line" apart from "one
 * line read four times". Before it, a pi assistant record holding reasoning and
 * three tool calls stored only its first event and silently dropped the rest.
 */
export function withOrdinals(events: AdapterEvent[]): AdapterEvent[] {
  if (events.length <= 1) return events;
  return events.map((event, ordinal) => ({
    ...event,
    rawRef: { ...event.rawRef, ordinal },
  }));
}

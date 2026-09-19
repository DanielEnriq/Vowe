import { describe, expect, it } from 'vitest';

import { WindowBuilder, approxTokensOf } from '../src/observation/window-builder.js';
import { DEFAULT_WINDOW_POLICY } from '../src/observation/trace-window.js';
import { makeEvents, steadyEvents, TEST_SESSION } from './helpers.js';
import type { NormalizedEvent } from '../src/types/events.js';

/** Windowing operates on stored events, so give them identity and order. */
function normalize(events: ReturnType<typeof makeEvents>): NormalizedEvent[] {
  return events.map((event, index) => ({
    ...event,
    id: `event-${index}`,
    seq: index + 1,
  }));
}

describe('WindowBuilder — acceptance 1: windowing', () => {
  it('divides a trace deterministically: same input, same windows', () => {
    const events = normalize(steadyEvents(95));
    const policy = { maxEvents: 20 };

    const first = new WindowBuilder({ sessionId: TEST_SESSION, policy }).push(events);
    const second = new WindowBuilder({ sessionId: TEST_SESSION, policy }).push(events);

    // Ids are random per window; everything that describes the *division* must
    // match exactly, or replay-based tuning is meaningless.
    const shape = (windows: typeof first) =>
      windows.map((w) => [w.index, w.startSeq, w.endSeq, w.eventCount, w.closedBy]);
    expect(shape(first)).toEqual(shape(second));
    expect(first.length).toBe(4); // 95 events / 20, with the tail left open
  });

  it('never skips trace material: windows are ordered and contiguous', () => {
    const events = normalize(steadyEvents(130));
    const builder = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxEvents: 17 },
    });
    const windows = [...builder.push(events)];
    const tail = builder.flush();
    if (tail) windows.push(tail);

    expect(windows[0]!.startSeq).toBe(1);
    expect(windows[windows.length - 1]!.endSeq).toBe(130);

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.index).toBe(windows[i - 1]!.index + 1);
      // The invariant that matters: no gap, no overlap.
      expect(windows[i]!.startSeq).toBe(windows[i - 1]!.endSeq + 1);
    }

    const total = windows.reduce((sum, w) => sum + w.eventCount, 0);
    expect(total).toBe(130);
  });

  it('recovers the source range: seq range and byte range both survive', () => {
    const events = normalize(steadyEvents(10));
    const [window] = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxEvents: 10 },
    }).push(events);

    expect(window).toBeDefined();
    expect(window!.startSeq).toBe(1);
    expect(window!.endSeq).toBe(10);
    // The physical address, so the original transcript can be re-read directly.
    expect(window!.source).toBe('/fixtures/test.jsonl');
    expect(window!.startOffset).toBe(events[0]!.rawRef.byteOffset);
    expect(window!.endOffset).toBe(events[9]!.rawRef.byteOffset);
  });

  it('closes on each configured bound', () => {
    const byEvents = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxEvents: 5, maxApproxTokens: 1e9, maxElapsedMs: 1e9 },
    }).push(normalize(steadyEvents(5)));
    expect(byEvents[0]?.closedBy).toBe('maxEvents');

    const fat = normalize(
      makeEvents([
        { kind: 'command_finished', summary: 'x'.repeat(4000), atSeconds: 0 },
      ]),
    );
    const byTokens = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxApproxTokens: 100, maxEvents: 1000, maxElapsedMs: 1e9 },
    }).push(fat);
    expect(byTokens[0]?.closedBy).toBe('maxApproxTokens');

    const slow = normalize(
      makeEvents([
        { kind: 'tool_started', atSeconds: 0 },
        { kind: 'tool_finished', atSeconds: 30 },
      ]),
    );
    const byTime = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxElapsedMs: 20_000, maxEvents: 1000, maxApproxTokens: 1e9 },
    }).push(slow);
    expect(byTime[0]?.closedBy).toBe('maxElapsedMs');
  });

  it('closes on natural boundaries: a developer turn and a long silence', () => {
    const turn = normalize(
      makeEvents([
        { kind: 'agent_message', atSeconds: 0 },
        { kind: 'agent_message', atSeconds: 1 },
        { kind: 'user_instruction', atSeconds: 2 },
        { kind: 'agent_message', atSeconds: 3 },
      ]),
    );
    const windows = new WindowBuilder({ sessionId: TEST_SESSION }).push(turn);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.closedBy).toBe('userTurn');
    // The turn starts the next window rather than ending the previous one.
    expect(windows[0]!.endSeq).toBe(2);

    const gap = normalize(
      makeEvents([
        { kind: 'tool_started', atSeconds: 0 },
        { kind: 'tool_started', atSeconds: 600 },
      ]),
    );
    const idle = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { idleGapMs: 60_000 },
    }).push(gap);
    expect(idle[0]?.closedBy).toBe('idleGap');
  });

  it('measures elapsed time from the trace, not the wall clock', () => {
    // Events far apart in trace time, replayed instantly. If the builder read
    // the clock, this would produce one window instead of several — which is
    // exactly the bug that would make replay-based tuning unreproducible.
    const events = normalize(
      Array.from({ length: 6 }, (_, index) => index).flatMap((index) =>
        makeEvents([{ kind: 'tool_started', atSeconds: index * 60 }]),
      ),
    );
    const windows = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxElapsedMs: 90_000, maxEvents: 1000, maxApproxTokens: 1e9 },
    }).push(events);
    expect(windows.length).toBeGreaterThan(1);
  });

  it('reshapes windows when the policy changes, without breaking invariants', () => {
    const events = normalize(steadyEvents(60));
    const small = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxEvents: 10 },
    }).push(events);
    const large = new WindowBuilder({
      sessionId: TEST_SESSION,
      policy: { maxEvents: 30 },
    }).push(events);

    expect(small.length).toBeGreaterThan(large.length);
    for (const set of [small, large]) {
      expect(set[0]!.startSeq).toBe(1);
      for (let i = 1; i < set.length; i++) {
        expect(set[i]!.startSeq).toBe(set[i - 1]!.endSeq + 1);
      }
    }
  });

  it('resumes numbering after a restart', () => {
    const builder = new WindowBuilder({
      sessionId: TEST_SESSION,
      startIndex: 41,
      policy: { maxEvents: 3 },
    });
    const windows = builder.push(normalize(steadyEvents(6)));
    expect(windows.map((w) => w.index)).toEqual([42, 43]);
  });

  it('estimates size without a tokenizer', () => {
    const [small] = normalize(makeEvents([{ kind: 'tool_started', summary: 'ab' }]));
    const [big] = normalize(
      makeEvents([{ kind: 'tool_started', summary: 'x'.repeat(400) }]),
    );
    expect(approxTokensOf(small!)).toBeLessThan(approxTokensOf(big!));
  });

  it('ships defaults rather than hardcoding sizes at the call site', () => {
    expect(DEFAULT_WINDOW_POLICY.maxEvents).toBeGreaterThan(0);
    expect(DEFAULT_WINDOW_POLICY.maxApproxTokens).toBeGreaterThan(0);
    expect(DEFAULT_WINDOW_POLICY.closeOnUserTurn).toBe(true);
  });
});

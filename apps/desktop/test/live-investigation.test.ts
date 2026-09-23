import { describe, expect, it } from 'vitest';

import type { InvestigationProgress } from '@vowe/core';
import {
  NOTHING_STREAMED,
  QUIET,
  checksOf,
  commitStreamed,
  gather,
  isReplaced,
  liveInvestigationReducer,
  openThought,
  turnPhase,
  type LiveInvestigation,
  type StreamedText,
} from '../src/renderer/state/live-investigation.js';

const SCOPE = { sessionId: 'claude-code:abc' };
const AT = '2026-09-22T12:00:00.000Z';

const started: InvestigationProgress = { phase: 'started', scope: SCOPE, at: AT };
const answer = (delta: string): InvestigationProgress => ({
  phase: 'answer',
  scope: SCOPE,
  delta,
  at: AT,
});
const reasoning = (delta: string): InvestigationProgress => ({
  phase: 'reasoning',
  scope: SCOPE,
  delta,
  at: AT,
});

const check = (label: string, at = AT): InvestigationProgress => ({
  phase: 'check',
  scope: SCOPE,
  check: { kind: 'search', label, refs: [] },
  at,
});

/** Deltas in, one frame's commit out — the way the hook does it. */
function stream(
  from: LiveInvestigation,
  deltas: InvestigationProgress[],
  framesEvery = deltas.length,
  now = 0,
): LiveInvestigation {
  let state = from;
  let pending: StreamedText = NOTHING_STREAMED;
  deltas.forEach((delta, index) => {
    pending = gather(pending, delta);
    if ((index + 1) % framesEvery === 0) {
      state = commitStreamed(state, pending, now);
      pending = NOTHING_STREAMED;
    }
  });
  return commitStreamed(state, pending, now);
}

/** The text of every thought so far, in order. */
function thoughts(state: LiveInvestigation): string[] {
  return state.steps.flatMap((step) => (step.kind === 'thought' ? [step.text] : []));
}

describe('Live investigation — the answer only ever grows', () => {
  /**
   * The regression this file exists to prevent. Text used to be rendered as a
   * fixed-length tail, so earlier words left the screen as later ones arrived
   * and a steadily-growing answer looked like it was sliding.
   */
  it('is monotonically append-only, whatever the frame boundaries', () => {
    const words = ['The', ' latest', ' thing', ' the', ' agent', ' did'];
    const deltas = words.map((word) => answer(word));

    // Every possible commit cadence must produce the same growing prefix.
    for (const every of [1, 2, 3, 6]) {
      let state: LiveInvestigation = { ...QUIET, active: true };
      const seen: string[] = [];
      for (let i = 0; i < deltas.length; i += 1) {
        state = stream(state, [deltas[i]!], every === 1 ? 1 : every);
        seen.push(state.answer);
      }

      // Never shrinks, never rewrites: each reading starts with the one before.
      for (let i = 1; i < seen.length; i += 1) {
        expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
        expect(seen[i]!.length).toBeGreaterThanOrEqual(seen[i - 1]!.length);
      }
      expect(state.answer).toBe(words.join(''));
    }
  });

  it('keeps every character the provider sent, in order', () => {
    const state = stream({ ...QUIET, active: true }, [
      answer('# Heading\n\n'),
      answer('A para'),
      answer('graph with `code`.'),
    ]);
    expect(state.answer).toBe('# Heading\n\nA paragraph with `code`.');
  });

  it('coalescing a frame changes nothing but the number of commits', () => {
    const deltas = [answer('one '), answer('two '), answer('three')];
    const perDelta = stream({ ...QUIET, active: true }, deltas, 1);
    const oneFrame = stream({ ...QUIET, active: true }, deltas, deltas.length);
    expect(perDelta.answer).toBe(oneFrame.answer);
    // Fewer commits, same text: that is rendering coalescing, not chunking.
    expect(oneFrame.beat).toBeLessThan(perDelta.beat);
  });

  it('keeps the two lanes apart', () => {
    const state = stream({ ...QUIET, active: true }, [
      reasoning('looking at the reconnect path'),
      answer('It retries twice.'),
    ]);
    expect(thoughts(state)).toEqual(['looking at the reconnect path']);
    expect(state.answer).toBe('It retries twice.');
  });

  /** The same append-only rule, applied to the working rather than the answer. */
  it('grows the open thought rather than replacing it', () => {
    let state: LiveInvestigation = { ...QUIET, active: true };
    const seen: string[] = [];
    for (const word of ['the reconnect', ' path retries', ' twice']) {
      state = stream(state, [reasoning(word)], 1);
      seen.push(thoughts(state).join(''));
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
    }
    // One span, not three: it is one uninterrupted stretch of thinking.
    expect(thoughts(state)).toHaveLength(1);
  });
});

describe('Live investigation — one chronological timeline', () => {
  /**
   * The regression this describes: reasoning used to accumulate into a single
   * separate string, so a session that looked, thought, looked and thought
   * again rendered as two lookups beside one undifferentiated blur.
   */
  it('interleaves lookups and thinking in the order they happened', () => {
    let state: LiveInvestigation = { ...QUIET, active: true };
    state = liveInvestigationReducer(state, check('Searched session context'), 1_000);
    state = stream(state, [reasoning('the trace is the place')], 1, 1_100);
    state = liveInvestigationReducer(state, check('Read the exchange'), 3_200);
    state = stream(state, [reasoning('so it retries')], 1, 3_300);

    expect(state.steps.map((step) => step.kind)).toEqual([
      'check',
      'thought',
      'check',
      'thought',
    ]);
    expect(checksOf(state).map((item) => item.label)).toEqual([
      'Searched session context',
      'Read the exchange',
    ]);
  });

  it('closes a thought the moment something else happens, and times it', () => {
    let state: LiveInvestigation = { ...QUIET, active: true };
    state = stream(state, [reasoning('considering')], 1, 1_000);
    expect(openThought(state)?.endedAt).toBe(null);

    // A lookup is the end of the thought that preceded it.
    state = liveInvestigationReducer(state, check('Opened the current diff'), 3_400);
    const thought = state.steps[0]!;
    expect(thought.kind).toBe('thought');
    expect(thought.kind === 'thought' && thought.endedAt).toBe(3_400);
    // `Thought for 2.4s` — both ends are real timestamps on one clock.
    expect(thought.kind === 'thought' && thought.endedAt! - thought.at).toBe(2_400);
    expect(openThought(state)).toBe(null);
  });

  it('the answer starting ends the thinking', () => {
    let state: LiveInvestigation = { ...QUIET, active: true };
    state = stream(state, [reasoning('nearly there')], 1, 1_000);
    state = stream(state, [answer('It retries twice.')], 1, 2_500);
    expect(openThought(state)).toBe(null);
    expect(state.answer).toBe('It retries twice.');
  });

  it('finishing ends the thinking without clearing it', () => {
    let state: LiveInvestigation = { ...QUIET, active: true };
    state = stream(state, [reasoning('still looking')], 1, 1_000);
    state = liveInvestigationReducer(
      state,
      { phase: 'finished', scope: SCOPE, entryId: 'e', failed: false, at: AT },
      4_000,
    );
    expect(state.active).toBe(false);
    expect(openThought(state)).toBe(null);
    expect(thoughts(state)).toEqual(['still looking']);
  });

  /** A provider that exposes nothing must produce no thought at all. */
  it('opens no thought where no reasoning is exposed', () => {
    let state: LiveInvestigation = { ...QUIET, active: true };
    state = liveInvestigationReducer(state, check('Searched the repository'), 1_000);
    state = stream(state, [answer('Twice.')], 1, 1_100);
    expect(thoughts(state)).toEqual([]);
    expect(state.steps.map((step) => step.kind)).toEqual(['check']);
  });
});

describe('Live investigation — the hand-over', () => {
  it('starts from silence', () => {
    const dirty: LiveInvestigation = { ...QUIET, answer: 'old', beat: 4, active: false };
    expect(liveInvestigationReducer(dirty, started)).toEqual({ ...QUIET, active: true });
  });

  it('settles without clearing what is on screen', () => {
    const streaming = stream({ ...QUIET, active: true }, [answer('Done.')]);
    const finished = liveInvestigationReducer(streaming, {
      phase: 'finished',
      scope: SCOPE,
      entryId: 'entry-1',
      failed: false,
      at: AT,
    });

    expect(finished.active).toBe(false);
    // The answer is still there: the durable entry has not arrived yet.
    expect(finished.answer).toBe('Done.');
    expect(isReplaced(finished, [])).toBe(false);
    expect(isReplaced(finished, ['entry-1'])).toBe(true);
  });

  /** A frame that lands after the finish must not restart the thinking. */
  it('a late frame does not revive a finished investigation', () => {
    const finished = liveInvestigationReducer(
      { ...QUIET, active: true },
      { phase: 'finished', scope: SCOPE, entryId: 'e', failed: false, at: AT },
    );
    const late = commitStreamed(finished, { reasoning: '', answer: '!', events: 1 });
    expect(late.active).toBe(false);
    expect(late.answer).toBe('!');
  });

  it('a lookup lands immediately, because it is what is being waited for', () => {
    const state = liveInvestigationReducer(
      { ...QUIET, active: true },
      {
        phase: 'check',
        scope: SCOPE,
        check: { kind: 'search', label: 'Searched session context', refs: [] },
        at: AT,
      },
    );
    expect(checksOf(state)).toHaveLength(1);
    expect(state.beat).toBe(1);
  });
});

describe('Live investigation — the turn is not the thought', () => {
  const running: LiveInvestigation = { ...QUIET, active: true };

  it('is investigating while alive with no answer, whether or not a thought is open', () => {
    expect(turnPhase(running)).toBe('investigating');
    const between = liveInvestigationReducer(running, check('Searched session context'));
    expect(openThought(between)).toBeNull();
    expect(turnPhase(between)).toBe('investigating');
  });

  it('is answering once the reply has started, and finished once it has settled', () => {
    expect(turnPhase({ ...running, answer: 'Here is' })).toBe('answering');
    expect(turnPhase({ ...running, answer: 'Here is', settledEntryId: 'entry-1' })).toBe('finished');
    expect(turnPhase({ ...running, answer: 'Here is', active: false })).toBe('finished');
    expect(turnPhase(QUIET)).toBe('finished');
  });
});

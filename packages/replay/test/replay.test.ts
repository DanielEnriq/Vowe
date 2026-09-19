import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { CommunicationPolicy, HeuristicDecisionRouter } from '@vowe/core';

import { replayFixture } from '../src/harness.ts';
import { ScriptedObserver } from '../src/scripted-observer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures');
const REAL = path.join(fixtures, 'vowe-session.sanitized.jsonl');
const SYNTHETIC = path.join(fixtures, 'repeated-failures.synthetic.jsonl');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function replay(fixture: string, options: Parameters<typeof replayFixture>[0] extends infer T ? Partial<T> : never = {}) {
  const result = await replayFixture({
    fixture,
    observer: new ScriptedObserver({ surfaceOnRepeatedFailure: true }),
    ...options,
  } as Parameters<typeof replayFixture>[0]);
  roots.push(result.storeRoot);
  return result;
}

describe('replay — acceptance 1 and 3, against a structurally real session', () => {
  it('ingests a real transcript through the production normalizer', async () => {
    const result = await replay(REAL);

    expect(result.recordsRead).toBeGreaterThan(100);
    expect(result.eventsStored).toBeGreaterThan(50);

    // The trace shape a hand-written fixture would not reproduce.
    const kinds = new Set(result.store.getEvents(result.sessionId).map((e) => e.kind));
    expect(kinds.has('session_started')).toBe(true);
    expect(kinds.has('command_started')).toBe(true);
    expect(kinds.has('command_finished')).toBe(true);
  });

  it('divides it into ordered, contiguous windows with recoverable ranges', async () => {
    const result = await replay(REAL);
    const windows = result.store.getWindows(result.sessionId);

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]!.startSeq).toBe(1);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.startSeq).toBe(windows[i - 1]!.endSeq + 1);
    }
    // Every window points back at the fixture, by byte offset.
    for (const window of windows) {
      expect(window.source).toContain('vowe-session.sanitized.jsonl');
      expect(window.startOffset).toBeGreaterThanOrEqual(0);
    }
    // No trace material is skipped.
    const covered = windows.reduce((sum, w) => sum + w.eventCount, 0);
    expect(covered).toBe(result.eventsStored);
  });

  it('produces one L1 note per window, each traceable to its L0 range', async () => {
    const result = await replay(REAL);
    const windows = result.store.getWindows(result.sessionId);
    const notes = result.store.getWindowNotes(result.sessionId);

    expect(notes).toHaveLength(windows.length);
    for (const window of windows) {
      const note = result.store.getWindowNoteForWindow(result.sessionId, window.id);
      expect(note).not.toBeNull();
      expect(note!.refs).toContainEqual({
        kind: 'trace',
        sessionId: result.sessionId,
        startSeq: window.startSeq,
        endSeq: window.endSeq,
      });
    }
  });

  it('is deterministic: the same fixture and policy give the same division', async () => {
    const a = await replay(REAL, { windowPolicy: { maxEvents: 12 } });
    const b = await replay(REAL, { windowPolicy: { maxEvents: 12 } });

    const shape = (result: typeof a) =>
      result.store
        .getWindows(result.sessionId)
        .map((w) => [w.index, w.startSeq, w.endSeq, w.closedBy]);
    expect(shape(a)).toEqual(shape(b));
  });

  it('reshapes when window sizing changes, which is the point of the harness', async () => {
    const small = await replay(REAL, { windowPolicy: { maxEvents: 8, maxApproxTokens: 1e9 } });
    const large = await replay(REAL, { windowPolicy: { maxEvents: 40, maxApproxTokens: 1e9 } });

    expect(small.store.getWindows(small.sessionId).length).toBeGreaterThan(
      large.store.getWindows(large.sessionId).length,
    );
  });

  it('answers a delegated question from the replayed context', async () => {
    const result = await replay(REAL);
    const answer = await result.delegated.answer({
      sessionId: result.sessionId,
      question: 'What command did it run?',
    });

    expect(answer.spokenAnswer.length).toBeGreaterThan(0);
    expect(answer.fullAnswer).toContain('Question:');
    expect(answer.refs.length).toBeGreaterThan(0);
    // Persisted for reading, not just spoken.
    const conversation = result.store.getConversation(result.sessionId);
    expect(conversation.some((entry) => entry.role === 'companion_answer')).toBe(true);
  });

  it('raises nothing for a session of ordinary progress', async () => {
    const result = await replay(REAL);
    expect(result.store.getSurfaceUpdates(result.sessionId)).toHaveLength(0);
  });
});

describe('replay — acceptance 4, against the synthetic failure trace', () => {
  it('surfaces a candidate when the same assertion keeps failing', async () => {
    const result = await replay(SYNTHETIC, {
      communicationPreference: 'Only tell me if something looks weird.',
    });

    const candidates = result.store.getSurfaceUpdates(result.sessionId);
    expect(candidates.length).toBeGreaterThan(0);

    const candidate = candidates[0]!;
    expect(candidate.message).toMatch(/same failing assertion/i);
    expect(candidate.whyNow).toMatch(/failed/i);
    expect(candidate.urgency).toBe('high');
    // It keeps the references to the material that produced it.
    expect(candidate.refs.some((ref) => ref.kind === 'trace')).toBe(true);
  });

  it('carries the candidate through the policy to an approval', async () => {
    const result = await replay(SYNTHETIC, {
      communicationPreference: 'Only tell me if something looks weird.',
    });
    // The harness evaluates inline; give that a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const candidate = result.store.getSurfaceUpdates(result.sessionId)[0]!;
    expect(candidate.decision).toBeDefined();
    expect(candidate.decision!.action).toBe('speak_now');
  });

  it('can be resolved back to the failing assertion in the raw trace', async () => {
    const result = await replay(SYNTHETIC);
    const candidate = result.store.getSurfaceUpdates(result.sessionId)[0]!;
    const traceRef = candidate.refs.find((ref) => ref.kind === 'trace')!;

    const opened = await result.navigator.openContext({ ref: traceRef });
    expect(opened.notFound).toBeUndefined();
    expect(opened.content).toMatch(/test/i);

    // And the underlying evidence is findable from the session.
    const hits = await result.navigator.searchContext({
      sessionId: result.sessionId,
      query: 'expected 2 to be 1',
      sources: ['trace'],
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('stays quiet when the observer is not looking for repeated failure', async () => {
    const result = await replayFixture({
      fixture: SYNTHETIC,
      observer: new ScriptedObserver({ surfaceOnRepeatedFailure: false }),
    });
    roots.push(result.storeRoot);
    expect(result.store.getSurfaceUpdates(result.sessionId)).toHaveLength(0);
  });
});

describe('replay — the policy seam holds without any decision model', () => {
  it('approves a weird development from the deterministic floor alone', async () => {
    const result = await replay(SYNTHETIC);
    const candidate = result.store.getSurfaceUpdates(result.sessionId)[0]!;

    const policy = new CommunicationPolicy({ router: new HeuristicDecisionRouter() });
    const decision = await policy.evaluate(candidate, 'Only tell me if something looks weird.');
    expect(decision.action).toBe('speak_now');
    expect(decision.source).toBe('default');
  });
});

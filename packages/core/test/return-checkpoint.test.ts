import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AttentionCursorStore,
  MAX_TRACKED_SESSIONS,
  checkpointNeedsDecision,
  normalizeAttentionCursors,
  returnCheckpoint,
  type AttentionItem,
  type NormalizedEvent,
  type SessionAttentionCursor,
  type WindowNote,
} from '../src/index.js';
import { TEST_SESSION } from './helpers.js';

const LOOKED_AT = '2026-09-22T12:00:00.000Z';
const NOW = new Date('2026-09-22T12:20:00.000Z');

const cursor: SessionAttentionCursor = {
  sessionId: TEST_SESSION,
  lastMeaningfullyViewedAt: LOOKED_AT,
  lastViewedSeq: 10,
};

function event(
  seq: number,
  kind: NormalizedEvent['kind'],
  summary: string,
  detail: Record<string, unknown> = {},
): NormalizedEvent {
  return {
    id: `e${seq}`,
    sessionId: TEST_SESSION,
    seq,
    at: new Date(Date.UTC(2026, 8, 22, 12, 5, seq)).toISOString(),
    kind,
    summary,
    detail,
    raw: {},
    rawRef: { source: 't.jsonl', byteOffset: seq, line: seq },
  };
}

function note(at: string, notableChange?: string): WindowNote {
  return {
    id: `n-${at}`,
    sessionId: TEST_SESSION,
    windowId: `w-${at}`,
    windowIndex: 1,
    summary: 'A window.',
    ...(notableChange ? { notableChange } : {}),
    refs: [],
    investigated: false,
    createdAt: at,
  };
}

const ATTENTION: AttentionItem = {
  id: `${TEST_SESSION}#e99`,
  projectId: 'git:abc',
  sessionId: TEST_SESSION,
  kind: 'decision',
  summary: 'It wants to change the public API.',
  refs: [],
  createdAt: '2026-09-22T12:10:00.000Z',
};

const base = { sessionId: TEST_SESSION, cursor, events: [], notes: [], at: NOW };

describe('Return checkpoint — only when the mental model went stale', () => {
  it('says nothing when the developer never looked away', () => {
    expect(returnCheckpoint({ ...base, cursor: null })).toBeNull();
  });

  it('says nothing for a brief glance elsewhere', () => {
    const brief: SessionAttentionCursor = {
      ...cursor,
      lastMeaningfullyViewedAt: '2026-09-22T12:19:00.000Z',
    };
    expect(
      returnCheckpoint({
        ...base,
        cursor: brief,
        events: [event(11, 'session_finished', 'Session finished')],
      }),
    ).toBeNull();
  });

  it('says nothing when nothing happened, however long they were away', () => {
    expect(returnCheckpoint(base)).toBeNull();
  });

  it('ignores a cursor with an unreadable timestamp rather than throwing', () => {
    expect(
      returnCheckpoint({
        ...base,
        cursor: { ...cursor, lastMeaningfullyViewedAt: 'the other day' },
      }),
    ).toBeNull();
  });
});

describe('Return checkpoint — what it actually reports', () => {
  it('reports only what happened after the cursor', () => {
    const checkpoint = returnCheckpoint({
      ...base,
      events: [
        event(9, 'session_started', 'Task: old news'),
        event(11, 'test_finished', 'Tests passed or completed', {
          failed: false,
          output: 'Tests 177 passed',
        }),
      ],
    });

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.milestones).toHaveLength(1);
    expect(checkpoint!.milestones[0]!.text).toBe('test suite passed 177 / 177');
    expect(checkpoint!.awayMs).toBe(20 * 60_000);
    expect(checkpoint!.since).toBe(LOOKED_AT);
  });

  /**
   * The design writes a paragraph here. Producing one would mean a model call
   * and a story nobody asked for, so the checkpoint carries the observer's own
   * words — which are real prose Vowe already wrote — and nothing else.
   */
  it('carries the observer’s own words, newest first, and never invents any', () => {
    const checkpoint = returnCheckpoint({
      ...base,
      notes: [
        note('2026-09-22T12:05:00.000Z', 'The first fix still duplicated messages.'),
        note('2026-09-22T12:12:00.000Z', 'It changed the replay insertion path.'),
        note('2026-09-22T12:14:00.000Z'),
        note('2026-09-22T11:50:00.000Z', 'Before they looked away.'),
      ],
    });

    expect(checkpoint!.notableChanges.map((change) => change.text)).toEqual([
      'It changed the replay insertion path.',
      'The first fix still duplicated messages.',
    ]);
  });

  it('caps what it reports so a long absence is still readable', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      event(11 + i, 'test_finished', 'Tests passed or completed', { failed: false }),
    );
    const notes = Array.from({ length: 6 }, (_, i) =>
      note(`2026-09-22T12:1${i}:00.000Z`, `change ${i}`),
    );

    const checkpoint = returnCheckpoint({ ...base, events, notes });
    expect(checkpoint!.milestones.length).toBeLessThanOrEqual(6);
    expect(checkpoint!.notableChanges.length).toBeLessThanOrEqual(2);
  });

  it('is the amber variant exactly when a decision is waiting', () => {
    const quiet = returnCheckpoint({
      ...base,
      events: [event(11, 'session_finished', 'Session finished')],
    });
    expect(checkpointNeedsDecision(quiet!)).toBe(false);

    const waiting = returnCheckpoint({ ...base, needsAttention: [ATTENTION] });
    expect(waiting).not.toBeNull();
    expect(checkpointNeedsDecision(waiting!)).toBe(true);
  });

  it('exists for an open decision even when the worker did nothing visible', () => {
    const checkpoint = returnCheckpoint({ ...base, needsAttention: [ATTENTION] });
    expect(checkpoint!.milestones).toEqual([]);
    expect(checkpoint!.needsAttention).toHaveLength(1);
  });
});

describe('Attention cursors — the mark itself', () => {
  it('drops entries it cannot trust rather than failing to load', () => {
    const cursors = normalizeAttentionCursors({
      good: { lastMeaningfullyViewedAt: LOOKED_AT, lastViewedSeq: 4 },
      noDate: { lastViewedSeq: 4 },
      badDate: { lastMeaningfullyViewedAt: 'yesterday', lastViewedSeq: 4 },
      notAnObject: 7,
    });
    expect(Object.keys(cursors)).toEqual(['good']);
    expect(cursors['good']!.lastViewedSeq).toBe(4);
  });

  it('defaults a missing or silly seq to zero', () => {
    const cursors = normalizeAttentionCursors({
      a: { lastMeaningfullyViewedAt: LOOKED_AT },
      b: { lastMeaningfullyViewedAt: LOOKED_AT, lastViewedSeq: -3 },
    });
    expect(cursors['a']!.lastViewedSeq).toBe(0);
    expect(cursors['b']!.lastViewedSeq).toBe(0);
  });

  it('keeps the most recently viewed sessions when there are too many', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 25; i += 1) {
      many[`s${i}`] = {
        lastMeaningfullyViewedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        lastViewedSeq: i,
      };
    }
    const cursors = normalizeAttentionCursors(many);
    expect(Object.keys(cursors)).toHaveLength(MAX_TRACKED_SESSIONS);
    // The newest survived; the oldest did not.
    expect(cursors[`s${MAX_TRACKED_SESSIONS + 24}`]).toBeDefined();
    expect(cursors['s0']).toBeUndefined();
  });
});

describe('AttentionCursorStore — marks never move backwards', () => {
  async function store() {
    const root = await mkdtemp(path.join(tmpdir(), 'vowe-attention-'));
    return {
      cursors: new AttentionCursorStore({ root }),
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it('records a mark and reads it back', async () => {
    const { cursors, cleanup } = await store();
    try {
      await cursors.mark(TEST_SESSION, { at: LOOKED_AT, seq: 12 });
      expect(await cursors.get(TEST_SESSION)).toEqual({
        sessionId: TEST_SESSION,
        lastMeaningfullyViewedAt: LOOKED_AT,
        lastViewedSeq: 12,
      });
    } finally {
      await cleanup();
    }
  });

  it('is null for a session nobody has looked at', async () => {
    const { cursors, cleanup } = await store();
    try {
      expect(await cursors.get('claude-code:never-opened')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  /**
   * Two windows on one session, or a renderer reporting late, must not be able
   * to make Vowe think the developer saw less than they did — that would
   * resurrect a checkpoint they already dismissed.
   */
  it('never regresses when a stale report arrives late', async () => {
    const { cursors, cleanup } = await store();
    try {
      await cursors.mark(TEST_SESSION, { at: '2026-09-22T12:10:00.000Z', seq: 40 });
      const after = await cursors.mark(TEST_SESSION, { at: LOOKED_AT, seq: 12 });

      expect(after.lastViewedSeq).toBe(40);
      expect(after.lastMeaningfullyViewedAt).toBe('2026-09-22T12:10:00.000Z');
    } finally {
      await cleanup();
    }
  });

  it('survives a restart', async () => {
    const { cursors, root, cleanup } = await store();
    try {
      await cursors.mark(TEST_SESSION, { at: LOOKED_AT, seq: 7 });
      const reopened = new AttentionCursorStore({ root });
      expect((await reopened.get(TEST_SESSION))?.lastViewedSeq).toBe(7);
    } finally {
      await cleanup();
    }
  });
});

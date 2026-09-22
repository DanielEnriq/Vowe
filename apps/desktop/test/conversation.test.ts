import { describe, expect, it } from 'vitest';

import type { ConversationDelivery, ConversationEntry, WorkerMilestone } from '@vowe/core';
import {
  buildTimeline,
  deliveredPortion,
  deliveryFor,
  isGroundedAnswer,
  speakerOf,
} from '../src/renderer/state/conversation.js';

const SESSION = 'claude-code:s1';

function entry(
  id: string,
  role: ConversationEntry['role'],
  text: string,
  at: string,
): ConversationEntry {
  return { id, sessionId: SESSION, at, role, text };
}

function delivery(
  overrides: Partial<ConversationDelivery> & Pick<ConversationDelivery, 'entryId' | 'status'>,
): ConversationDelivery {
  return {
    id: `d-${overrides.entryId}-${overrides.status}`,
    sessionId: SESSION,
    modality: 'voice',
    startedAt: '2026-09-22T09:00:00.000Z',
    ...overrides,
  };
}

describe('Conversation — speaker runs', () => {
  it('knows who is speaking from the role alone', () => {
    expect(speakerOf('user_question')).toBe('user');
    expect(speakerOf('user_message')).toBe('user');
    expect(speakerOf('user_instruction')).toBe('user');
    expect(speakerOf('companion_answer')).toBe('vowe');
    expect(speakerOf('companion_message')).toBe('vowe');
    expect(speakerOf('instruction_result')).toBe('vowe');
  });

  it('keeps consecutive turns from one speaker together', () => {
    const items = buildTimeline({
      entries: [
        entry('1', 'user_message', 'one', '2026-09-22T09:00:00.000Z'),
        entry('2', 'user_message', 'two', '2026-09-22T09:00:01.000Z'),
        entry('3', 'companion_message', 'three', '2026-09-22T09:00:02.000Z'),
      ],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'turn', speaker: 'user' });
    expect((items[0] as { entries: unknown[] }).entries).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: 'turn', speaker: 'vowe' });
  });

  it('interleaves worker milestones by time', () => {
    const milestone: WorkerMilestone = {
      id: 'm1',
      sessionId: SESSION,
      at: '2026-09-22T09:00:01.500Z',
      kind: 'tests_finished',
      text: 'test suite passed 177 / 177',
      eventIds: ['e1'],
      refs: [],
    };

    const items = buildTimeline({
      entries: [
        entry('1', 'user_message', 'one', '2026-09-22T09:00:01.000Z'),
        entry('2', 'companion_message', 'two', '2026-09-22T09:00:02.000Z'),
      ],
      milestones: [milestone],
    });

    expect(items.map((item) => item.kind)).toEqual(['turn', 'milestone', 'turn']);
  });

  it('only calls an answer grounded when it actually checked something', () => {
    const plain = entry('1', 'companion_answer', 'Yes.', '2026-09-22T09:00:00.000Z');
    expect(isGroundedAnswer(plain)).toBe(false);

    const grounded: ConversationEntry = {
      ...plain,
      investigation: {
        durationMs: 4000,
        checks: [{ kind: 'open', label: 'ask.ts', refs: [] }],
      },
    };
    expect(isGroundedAnswer(grounded)).toBe(true);

    const ordinary: ConversationEntry = {
      ...grounded,
      role: 'companion_message',
    };
    expect(isGroundedAnswer(ordinary)).toBe(false);
  });
});

describe('Conversation — what was actually heard', () => {
  const answer = entry(
    'a1',
    'companion_answer',
    'The reconnect path is failing because both branches feed one insert.',
    '2026-09-22T09:00:00.000Z',
  );

  it('shows the whole turn when nothing was cut off', () => {
    expect(deliveredPortion(answer, null)).toMatchObject({
      interrupted: false,
      heard: answer.text,
      unheard: null,
    });

    expect(
      deliveredPortion(answer, delivery({ entryId: 'a1', status: 'completed' })),
    ).toMatchObject({ interrupted: false });
  });

  it('splits at the boundary when the delivered prefix is known', () => {
    const portion = deliveredPortion(
      answer,
      delivery({
        entryId: 'a1',
        status: 'interrupted',
        deliveredText: 'The reconnect path is failing because both',
      }),
    );

    expect(portion.interrupted).toBe(true);
    expect(portion.heard).toBe('The reconnect path is failing because both');
    expect(portion.unheard).toBe('branches feed one insert.');
    expect(portion.boundaryUnknown).toBe(false);
  });

  /**
   * The one case where `deliveredText` is deliberately not a prefix: Vo speaks
   * a short form of a grounded answer that was written in full. Showing that
   * as a truncation would claim the rest was cut off when it was never spoken
   * at all.
   */
  it('distinguishes a spoken form from a truncation', () => {
    const portion = deliveredPortion(
      answer,
      delivery({
        entryId: 'a1',
        status: 'interrupted',
        deliveredText: 'Both paths feed the same insert.',
      }),
    );

    expect(portion.spokenFormDiffers).toBe(true);
    expect(portion.heard).toBe('Both paths feed the same insert.');
    expect(portion.unheard).toBe(answer.text);
  });

  /** Better than fabricated precision. */
  it('reports a cut it cannot locate without inventing a boundary', () => {
    const portion = deliveredPortion(
      answer,
      delivery({ entryId: 'a1', status: 'interrupted' }),
    );

    expect(portion.interrupted).toBe(true);
    expect(portion.boundaryUnknown).toBe(true);
    expect(portion.heard).toBeNull();
    expect(portion.unheard).toBeNull();
  });

  it('treats a cancelled delivery as cut off too', () => {
    expect(
      deliveredPortion(answer, delivery({ entryId: 'a1', status: 'cancelled' })).interrupted,
    ).toBe(true);
  });

  it('takes the newest delivery of an entry', () => {
    const deliveries = [
      delivery({ entryId: 'a1', status: 'started', startedAt: '2026-09-22T09:00:00.000Z' }),
      delivery({
        entryId: 'a1',
        status: 'interrupted',
        startedAt: '2026-09-22T09:05:00.000Z',
        deliveredText: 'The reconnect path',
      }),
      delivery({ entryId: 'other', status: 'completed' }),
    ];

    expect(deliveryFor('a1', deliveries)?.status).toBe('interrupted');
    expect(deliveryFor('missing', deliveries)).toBeNull();
  });
});

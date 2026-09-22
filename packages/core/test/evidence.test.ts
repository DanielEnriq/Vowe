import { describe, expect, it } from 'vitest';

import type { ContextRef } from '../src/context/refs.js';
import { evidenceFor, type EvidenceEvent } from '../src/product/evidence.js';

const SESSION = 'claude-code:abc';
const PROJECT = 'git:vowe';

const event = (id: string, seq: number, kind: string, summary?: string): EvidenceEvent => ({
  id,
  seq,
  kind,
  ...(summary ? { summary } : {}),
});

/** Every item, flattened, so a test can talk about the list on screen. */
const titles = (refs: ContextRef[], events?: EvidenceEvent[]): string[] =>
  evidenceFor(refs, events ? { events } : {}).groups.flatMap((group) =>
    group.items.map(() => group.title),
  );

describe('Supporting evidence — the count is the list', () => {
  /**
   * The regression this file exists to prevent.
   *
   * The conversation said `4 supporting items` and rendered three rows, all
   * three reading `worker activity`: the number described the refs and the
   * rows described a slice of them, filtered by ref kind. One projection means
   * the two cannot disagree.
   */
  it('counts exactly what it renders', () => {
    const refs: ContextRef[] = [
      { kind: 'event', sessionId: SESSION, eventId: 'e1' },
      { kind: 'event', sessionId: SESSION, eventId: 'e2' },
      { kind: 'event', sessionId: SESSION, eventId: 'e3' },
      { kind: 'diff', sessionId: SESSION },
    ];
    const evidence = evidenceFor(refs, {
      events: [
        event('e1', 12, 'user_instruction'),
        event('e2', 540, 'agent_message'),
        event('e3', 551, 'test_finished'),
      ],
    });

    expect(evidence.total).toBe(4);
    const rendered = evidence.groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(rendered).toBe(evidence.total);
  });

  it('names records from the events they point at, not from their addresses', () => {
    const refs: ContextRef[] = [
      { kind: 'event', sessionId: SESSION, eventId: 'e1' },
      { kind: 'event', sessionId: SESSION, eventId: 'e2' },
      { kind: 'event', sessionId: SESSION, eventId: 'e3' },
      { kind: 'diff', sessionId: SESSION },
    ];

    expect(
      titles(refs, [
        event('e1', 12, 'user_instruction'),
        event('e2', 540, 'agent_message'),
        event('e3', 551, 'test_finished'),
      ]),
    ).toEqual(['Task instruction', 'Worker update', 'Test run', 'Current diff']);
  });

  /** No primary label may be a ref kind, a provider kind or a sequence number. */
  it('never labels an item with an implementation detail', () => {
    const refs: ContextRef[] = [
      { kind: 'event', sessionId: SESSION, eventId: 'e1' },
      { kind: 'transcript', sessionId: SESSION, eventId: 'e9' },
      { kind: 'trace', sessionId: SESSION, startSeq: 120, endSeq: 160 },
      { kind: 'window', sessionId: SESSION, windowId: 'w3' },
      { kind: 'lesson', projectId: PROJECT, recordId: 'r1' },
      { kind: 'symbol', projectId: PROJECT, nodeId: 'src/ask.ts#answerQuestion' },
      { kind: 'repo', path: 'packages/core/src/ask.ts', line: 84 },
    ];

    for (const group of evidenceFor(refs, { events: [event('e1', 9, 'agent_message')] }).groups) {
      expect(group.title).not.toMatch(/agent_message|user_instruction|worker_activity/);
      expect(group.title).not.toMatch(/^\[?\d+\]?$/);
      expect(group.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the raw address on the member, where it belongs', () => {
    const evidence = evidenceFor([
      { kind: 'event', sessionId: SESSION, eventId: 'e1' },
      { kind: 'event', sessionId: SESSION, eventId: 'e2' },
    ], {
      events: [event('e1', 540, 'agent_message'), event('e2', 549, 'agent_message')],
    });

    const [group] = evidence.groups;
    expect(group?.title).toBe('Worker update');
    expect(group?.items.map((item) => item.detail)).toEqual([
      '540 · agent_message',
      '549 · agent_message',
    ]);
    // And the address itself is the id, so a click opens the right one.
    expect(group?.items.map((item) => item.id)).toEqual([
      `event:${SESSION}:e1`,
      `event:${SESSION}:e2`,
    ]);
  });
});

describe('Supporting evidence — grouping', () => {
  it('groups by name and states the size of each group', () => {
    const many: ContextRef[] = [
      ...Array.from({ length: 14 }, (_, i) => ({
        kind: 'event' as const,
        sessionId: SESSION,
        eventId: `a${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        kind: 'event' as const,
        sessionId: SESSION,
        eventId: `t${i}`,
      })),
      { kind: 'event', sessionId: SESSION, eventId: 'instruction' },
      { kind: 'diff', sessionId: SESSION },
    ];
    const events = [
      ...Array.from({ length: 14 }, (_, i) => event(`a${i}`, 500 + i, 'agent_message')),
      ...Array.from({ length: 5 }, (_, i) => event(`t${i}`, 600 + i, 'test_finished')),
      event('instruction', 3, 'user_instruction'),
    ];

    const evidence = evidenceFor(many, { events });
    expect(evidence.total).toBe(21);
    expect(
      evidence.groups.map((group) => [group.title, group.items.length]),
    ).toEqual([
      ['Worker update', 14],
      ['Test run', 5],
      ['Task instruction', 1],
      ['Current diff', 1],
    ]);
    // Twenty-one items are all still reachable, as members of four names.
    const reachable = evidence.groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(reachable).toBe(21);
  });

  it('is in the order the investigation first touched each kind of thing', () => {
    const evidence = evidenceFor(
      [
        { kind: 'diff', sessionId: SESSION },
        { kind: 'event', sessionId: SESSION, eventId: 'e1' },
        { kind: 'repo', path: 'src/ask.ts' },
      ],
      { events: [event('e1', 1, 'agent_message')] },
    );
    expect(evidence.groups.map((group) => group.title)).toEqual([
      'Current diff',
      'Worker update',
      'ask.ts',
    ]);
  });

  it('the same address twice is one piece of evidence', () => {
    const ref: ContextRef = { kind: 'event', sessionId: SESSION, eventId: 'e1' };
    const evidence = evidenceFor([ref, { ...ref }], { events: [event('e1', 1, 'agent_message')] });
    expect(evidence.total).toBe(1);
    expect(evidence.groups[0]?.items).toHaveLength(1);
  });

  /**
   * A project answer cites material from sessions this caller never loaded.
   * That must still be named, and must not be named specifically.
   */
  it('names a record it cannot resolve by what it certainly is', () => {
    const evidence = evidenceFor([
      { kind: 'event', sessionId: SESSION, eventId: 'gone' },
      { kind: 'transcript', sessionId: SESSION, eventId: 'also-gone' },
    ]);
    expect(evidence.groups.map((group) => group.title)).toEqual([
      'Worker record',
      'Exchange with the worker',
    ]);
    expect(evidence.total).toBe(2);
  });

  it('no refs is no evidence, not an empty heading', () => {
    expect(evidenceFor([])).toEqual({ total: 0, groups: [] });
  });
});

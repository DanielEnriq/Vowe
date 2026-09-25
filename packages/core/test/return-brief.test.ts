import { describe, expect, it } from 'vitest';

import type { NormalizedEvent, WindowNote } from '../src/index.js';
import { returnBrief } from '../src/product/return-brief.js';

const SINCE = '2026-09-22T12:00:00.000Z';

function event(
  seq: number,
  kind: NormalizedEvent['kind'],
  detail: Record<string, unknown> = {},
): NormalizedEvent {
  return {
    id: `e${seq}`,
    sessionId: 's',
    seq,
    at: new Date(Date.UTC(2026, 8, 22, 12, 5, seq)).toISOString(),
    kind,
    summary: kind,
    detail,
    raw: {},
    rawRef: { source: 't.jsonl', byteOffset: seq, line: seq },
  } as NormalizedEvent;
}

/** A command's start and finish, joined by the tool call they share. */
function run(
  seq: number,
  kind: 'test' | 'command',
  command: string,
  output: string,
  failed = false,
): NormalizedEvent[] {
  const id = `tool-${seq}`;
  return [
    event(seq, `${kind}_started`, { toolUseId: id, input: { command } }),
    event(seq + 1, `${kind}_finished`, { toolUseId: id, output, failed }),
  ];
}

function edit(seq: number, path: string): NormalizedEvent {
  return event(seq, 'file_changed', { input: { file_path: path } });
}

function note(createdAt: string, notableChange: string | undefined, summary = 'Working.'): WindowNote {
  return {
    id: createdAt,
    sessionId: 's',
    windowId: createdAt,
    windowIndex: 0,
    summary,
    ...(notableChange ? { notableChange } : {}),
    refs: [],
    investigated: false,
    createdAt,
  };
}

describe('returnBrief', () => {
  it('groups checks by what was run and keeps only how each last finished', () => {
    const brief = returnBrief({
      since: SINCE,
      notes: [],
      needsAttention: [],
      events: [
        ...run(1, 'test', 'pnpm test', 'Tests  3 failed | 598 passed', true),
        ...run(3, 'test', 'npx vitest run apps/desktop/test/patch.test.ts', 'Tests  3 passed'),
        ...run(5, 'command', 'pnpm typecheck 2>&1 | tail -5', 'apps/desktop typecheck: Done'),
        ...run(7, 'test', 'pnpm test 2>&1 | grep Tests', 'Test Files  59 passed\n      Tests  601 passed'),
        ...run(9, 'command', 'git status', 'clean'),
      ],
    });

    expect(brief.verified).toEqual([
      { kind: 'tests', label: 'patch tests', passed: true, result: '3 / 3', runs: 1 },
      { kind: 'typecheck', label: 'typecheck', passed: true, result: 'clean', runs: 1 },
      { kind: 'tests', label: 'full suite', passed: true, result: '601 / 601', runs: 2 },
    ]);
  });

  it('believes the output over a clean exit status', () => {
    const brief = returnBrief({
      since: SINCE,
      notes: [],
      needsAttention: [],
      events: [
        ...run(1, 'command', 'pnpm typecheck | tail', 'src/a.ts(1,1): error TS2304\nsrc/b.ts(2,2): error TS2322'),
        ...run(3, 'test', 'pnpm test | tail', 'Tests  1 failed | 600 passed'),
      ],
    });
    expect(brief.verified.map((check) => [check.label, check.passed, check.result])).toEqual([
      ['typecheck', false, '2 errors'],
      ['full suite', false, '1 of 601 failed'],
    ]);
  });

  it('lists each touched file once, the most edited first', () => {
    const brief = returnBrief({
      since: SINCE,
      notes: [],
      needsAttention: [],
      events: [edit(1, 'src/a.ts'), edit(2, 'src/b.ts'), edit(3, 'src/b.ts'), edit(4, 'src/c.ts')],
    });
    expect(brief.touched).toEqual(['src/b.ts', 'src/c.ts', 'src/a.ts']);
  });

  it('says what changed from the observer’s notes, and only notes written since', () => {
    const brief = returnBrief({
      since: SINCE,
      needsAttention: [],
      events: [],
      notes: [
        note('2026-09-22T11:00:00.000Z', 'Old news.'),
        note('2026-09-22T12:10:00.000Z', 'The checkpoint became a ribbon.'),
        note('2026-09-22T12:20:00.000Z', 'The ribbon gained a brief.'),
      ],
    });
    expect(brief.changed).toEqual(['The checkpoint became a ribbon.', 'The ribbon gained a brief.']);

    const quiet = returnBrief({
      since: SINCE,
      needsAttention: [],
      events: [],
      notes: [note('2026-09-22T12:10:00.000Z', undefined, 'The worker is refactoring the parser.')],
    });
    expect(quiet.changed).toEqual(['The worker is refactoring the parser.']);
  });

  it('describes where the session is, with recent interpretation only', () => {
    const idle = returnBrief({
      since: SINCE,
      notes: [],
      needsAttention: [],
      events: [],
      session: {
        status: 'idle',
        semanticState: {
          task: null,
          phase: 'testing',
          currentActivity: 'Running the full suite',
          recentProgress: [],
          lastMeaningfulUpdate: '',
          currentUnderstanding: null,
          meaningfulUpdates: [],
          source: 'llm',
          provenance: { eventIds: [], throughSeq: 0 },
          updatedAt: '2026-09-22T12:30:00.000Z',
        },
      },
    });
    expect(idle.state).toEqual({
      status: 'idle',
      text: 'The worker has stopped and is idle.',
      activity: 'Running the full suite',
    });

    const unknown = returnBrief({ since: SINCE, notes: [], needsAttention: [], events: [] });
    expect(unknown.state.activity).toBeUndefined();
    expect(unknown.state.status).toBe('unknown');
  });
});

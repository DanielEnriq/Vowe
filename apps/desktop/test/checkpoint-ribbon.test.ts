import { describe, expect, it } from 'vitest';

import type { ReturnBrief, ReturnCheckpoint } from '@vowe/core';
import { awayFor, ribbonCopy, shortPaths } from '../src/renderer/state/checkpoint-ribbon.js';

function checkpoint(brief: Partial<ReturnBrief> = {}): ReturnCheckpoint {
  return {
    sessionId: 's',
    since: '2026-09-22T09:00:00Z',
    awayMs: 42 * 60_000,
    milestones: [],
    notableChanges: [],
    needsAttention: [],
    brief: {
      changed: [],
      verified: [],
      state: { status: 'idle', text: 'The worker has stopped and is idle.' },
      needsYou: [],
      touched: [],
      ...brief,
    },
  };
}

const green = { kind: 'tests', label: 'full suite', passed: true, result: '601 / 601', runs: 2 } as const;
const red = { ...green, passed: false, result: '1 of 601 failed' } as const;
const clean = { kind: 'typecheck', label: 'typecheck', passed: true, result: 'clean', runs: 1 } as const;

describe('ribbonCopy', () => {
  it('says the work stayed on track when files changed and every check passed', () => {
    expect(ribbonCopy(checkpoint({ touched: ['a.ts', 'b.ts'], verified: [green, clean] }))).toEqual({
      summary: 'Everything stayed on track.',
      facts: ['nothing needs you', '2 files changed', 'tests green', 'typecheck clean'],
    });
  });

  it('puts a failure ahead of the work finishing', () => {
    const copy = ribbonCopy(
      checkpoint({
        touched: ['a.ts'],
        verified: [red],
        state: { status: 'finished', text: 'The session has finished.' },
      }),
    );
    expect(copy.summary).toBe('The tests went red.');
    expect(copy.facts).toEqual(['nothing needs you', '1 file changed', 'tests red', 'worker finished']);
  });

  it('names a failing check that is not the tests', () => {
    const copy = ribbonCopy(checkpoint({ verified: [{ ...clean, passed: false, result: '2 errors' }] }));
    expect(copy.summary).toBe('The typecheck is failing.');
    expect(copy.facts).toContain('typecheck failing');
  });

  it('puts a decision ahead of a failure', () => {
    const copy = ribbonCopy(checkpoint({ verified: [red], needsYou: ['Approve the migration?'] }));
    expect(copy.summary).toBe('Something is waiting on you.');
    expect(copy.facts[0]).toBe('1 thing needs you');
  });

  it('falls back to keeping watch, and counts Vowe’s own notes when that is all there is', () => {
    expect(ribbonCopy(checkpoint({ changed: ['The plan changed.'] }))).toEqual({
      summary: 'Vowe kept watch.',
      facts: ['nothing needs you', '1 note from Vowe'],
    });
  });
});

describe('shortPaths', () => {
  it('uses the file name, and the folder only to tell two apart', () => {
    expect(shortPaths(['/r/src/a/index.ts', '/r/src/b/index.ts', '/r/src/Ribbon.tsx'])).toEqual([
      'a/index.ts',
      'b/index.ts',
      'Ribbon.tsx',
    ]);
  });
});

describe('awayFor', () => {
  it('reads as minutes, then hours and minutes', () => {
    expect(awayFor(42 * 60_000)).toBe('42m');
    expect(awayFor(125 * 60_000)).toBe('2h 5m');
    expect(awayFor(120 * 60_000)).toBe('2h');
  });
});

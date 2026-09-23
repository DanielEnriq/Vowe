import { describe, expect, it } from 'vitest';

import type { AgentSession } from '@vowe/core';

import {
  RECENT_DAYS,
  currentSessions,
  isArchived,
  isCurrent,
  isRecent,
  searchSessions,
} from '../src/renderer/state/session-visibility.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function session(id: string, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    provider: 'claude-code',
    providerSessionId: id,
    attachMode: 'observe',
    task: null,
    displayLabel: id,
    cwd: '/repo',
    projectId: 'p1',
    status: 'idle',
    createdAt: daysAgo(30),
    lastActivityAt: daysAgo(1),
    capabilities: {} as AgentSession['capabilities'],
    semanticState: null,
    ...extra,
  };
}

describe('Which sessions are going on now', () => {
  it('keeps work touched inside the week', () => {
    expect(isRecent(session('a', { lastActivityAt: daysAgo(RECENT_DAYS - 1) }), NOW)).toBe(true);
    expect(isRecent(session('b', { lastActivityAt: daysAgo(RECENT_DAYS + 1) }), NOW)).toBe(false);
  });

  /**
   * A session started weeks ago but worked in yesterday is current work. Age
   * is about when something last happened, not when it began.
   */
  it('judges by the last thing that happened, not by when it started', () => {
    const old = session('a', { createdAt: daysAgo(90), lastActivityAt: daysAgo(1) });
    expect(isCurrent(old, { now: NOW })).toBe(true);
  });

  it('puts away what the developer put away, however recent', () => {
    const archived = session('a', { lastActivityAt: daysAgo(0), archivedAt: daysAgo(0) });
    expect(isArchived(archived)).toBe(true);
    expect(isCurrent(archived, { now: NOW })).toBe(false);
  });

  /**
   * The panel must not lie about where you are: a session you have open is in
   * the list beside it, and opening one is what "look it up and open it"
   * means.
   */
  it('always shows the session being looked at', () => {
    const buried = session('a', { lastActivityAt: daysAgo(90), archivedAt: daysAgo(3) });
    expect(isCurrent(buried, { now: NOW })).toBe(false);
    expect(isCurrent(buried, { now: NOW, openSessionId: 'a' })).toBe(true);
  });

  /** An unreadable date is not evidence of age, so it hides nothing. */
  it('does not hide a session whose date makes no sense', () => {
    expect(isRecent(session('a', { lastActivityAt: 'not a date' }), NOW)).toBe(true);
  });

  it('filters a list down to current work', () => {
    const kept = currentSessions(
      [
        session('recent', { lastActivityAt: daysAgo(2) }),
        session('stale', { lastActivityAt: daysAgo(40) }),
        session('put-away', { lastActivityAt: daysAgo(1), archivedAt: daysAgo(1) }),
      ],
      { now: NOW },
    );
    expect(kept.map((item) => item.id)).toEqual(['recent']);
  });
});

describe('Finding a session the panel is not showing', () => {
  const all = [
    session('a', { generatedTitle: 'Migrate event store', lastActivityAt: daysAgo(40) }),
    session('b', { generatedTitle: 'Fix the ribbon', lastActivityAt: daysAgo(1), archivedAt: daysAgo(1) }),
    session('c', { generatedTitle: 'Align text sizes', lastActivityAt: daysAgo(5) }),
  ];

  /**
   * The whole point of the search is to reach what the rule put away, so it
   * must not apply the rule.
   */
  it('offers everything, including the old and the put-away', () => {
    expect(searchSessions(all, '').map((item) => item.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('is newest first, so today is at the top', () => {
    expect(searchSessions(all, '').map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('matches what a person can read, not the id', () => {
    expect(searchSessions(all, 'ribbon').map((item) => item.id)).toEqual(['b']);
    expect(searchSessions(all, 'RIBBON').map((item) => item.id)).toEqual(['b']);
    expect(searchSessions(all, 'nothing here')).toEqual([]);
  });

  it('matches the branch a session is on', () => {
    const onBranch = [session('x', { branch: 'slice-6-ui-transplant' })];
    expect(searchSessions(onBranch, 'slice-6').map((item) => item.id)).toEqual(['x']);
  });
});

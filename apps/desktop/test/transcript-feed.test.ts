import type { TranscriptItem, TranscriptPage } from '@vowe/core';
import { describe, expect, it } from 'vitest';

import {
  emptyTranscriptFeed,
  feedWithDelta,
  feedWithOlder,
  feedWithPage,
} from '../src/renderer/state/transcript-feed.js';

const AT = '2026-01-01T00:00:00.000Z';
const say = (id: string, text = id): TranscriptItem => ({ kind: 'assistant', id, at: AT, text });
const page = (sessionId: string, items: TranscriptItem[], before: string | null = null): TranscriptPage => ({
  sessionId,
  items,
  before,
  live: true,
});

describe('transcript feed', () => {
  it("ignores deltas and pages for another session", () => {
    const feed = emptyTranscriptFeed('s1');
    expect(feedWithDelta(feed, { type: 'items', sessionId: 's2', items: [say('x')] })).toBe(feed);
    expect(feedWithDelta(feed, { type: 'stream', sessionId: 's2', itemId: 'x', kind: 'assistant', textDelta: 'hi' })).toBe(feed);
    expect(feedWithPage(feed, page('s2', [say('x')]))).toBe(feed);
    expect(feedWithOlder(feed, page('s2', [say('x')]))).toBe(feed);
    const none = emptyTranscriptFeed(null);
    expect(feedWithDelta(none, { type: 'items', sessionId: 's1', items: [say('x')] })).toBe(none);
  });

  it('lays the first page under deltas that arrived before it', () => {
    let feed = emptyTranscriptFeed('s1');
    feed = feedWithDelta(feed, { type: 'items', sessionId: 's1', items: [say('b', 'b, updated'), say('d')] });
    feed = feedWithDelta(feed, { type: 'stream', sessionId: 's1', itemId: 'e', kind: 'assistant', textDelta: 'typing' });
    feed = feedWithPage(feed, page('s1', [say('a'), say('b'), say('c')], 'a'));
    expect(feed.items).toEqual([say('a'), say('b', 'b, updated'), say('c'), say('d')]);
    expect(feed.streaming).toEqual({ e: { kind: 'assistant', text: 'typing' } });
    expect(feed).toMatchObject({ loaded: true, live: true, before: 'a' });
  });

  it('prepends older pages and moves the cursor', () => {
    let feed = feedWithPage(emptyTranscriptFeed('s1'), page('s1', [say('c'), say('d')], 'c'));
    feed = feedWithOlder(feed, page('s1', [say('a'), say('b')], null));
    expect(feed.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(feed.before).toBeNull();
  });
});

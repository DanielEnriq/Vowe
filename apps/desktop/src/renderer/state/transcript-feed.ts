import type { StreamingText, TranscriptDelta, TranscriptItem, TranscriptPage } from '@vowe/core';
import { applyTranscriptDelta, prependTranscriptItems } from '@vowe/core/fleet-transcript';

/**
 * One session's transcript as the agent view holds it: the pages read so far
 * plus every delta since subscribing. Deltas can land before the first page
 * does; they are kept and laid over it rather than lost.
 */
export interface TranscriptFeed {
  sessionId: string | null;
  items: TranscriptItem[];
  streaming: Record<string, StreamingText>;
  /** Cursor for the next older page; null once the start is reached. */
  before: string | null;
  live: boolean;
  loaded: boolean;
}

export function emptyTranscriptFeed(sessionId: string | null): TranscriptFeed {
  return { sessionId, items: [], streaming: {}, before: null, live: false, loaded: false };
}

/** A delta for this feed's session; anything else leaves it as it was. */
export function feedWithDelta(feed: TranscriptFeed, delta: TranscriptDelta): TranscriptFeed {
  if (!feed.sessionId || delta.sessionId !== feed.sessionId) return feed;
  const next = applyTranscriptDelta(feed.items, feed.streaming, delta);
  if (next.items === feed.items && next.streaming === feed.streaming) return feed;
  return { ...feed, ...next };
}

/**
 * The newest page arrived. It is the base; what deltas already delivered is
 * newer, so it is upserted over the page rather than replaced by it.
 */
export function feedWithPage(feed: TranscriptFeed, page: TranscriptPage): TranscriptFeed {
  if (!feed.sessionId || page.sessionId !== feed.sessionId) return feed;
  const next = applyTranscriptDelta(page.items, feed.streaming, {
    type: 'items',
    sessionId: page.sessionId,
    items: feed.items,
  });
  return { ...feed, ...next, before: page.before, live: page.live, loaded: true };
}

/** An older page goes in front, without repeating anything already held. */
export function feedWithOlder(feed: TranscriptFeed, page: TranscriptPage): TranscriptFeed {
  if (!feed.sessionId || page.sessionId !== feed.sessionId) return feed;
  return { ...feed, items: prependTranscriptItems(page.items, feed.items), before: page.before };
}

/**
 * Fleet's transcript feed: what a worker said, thought and did, in order.
 *
 * Separate from Vowe's `NormalizedEvent` pipeline on purpose. Events are
 * evidence for observation and interpretation and leave thinking out; this is
 * a reading surface for a person watching an agent work, so it keeps
 * thinking, full assistant text and tool output. Nothing here is stored, and
 * nothing in Vowe's observation reads it.
 *
 * Browser-safe and import-free: the renderer applies deltas with the same
 * function the tests check.
 */

export type TranscriptItem =
  | { kind: 'user'; id: string; at: string; text: string; origin: 'task' | 'you' | 'captain' | 'relay' }
  | { kind: 'assistant'; id: string; at: string; text: string }
  | { kind: 'thinking'; id: string; at: string; text: string; redacted?: boolean }
  | {
      kind: 'tool';
      id: string;
      at: string;
      toolUseId: string;
      name: string;
      input: unknown;
      summary: string;
      status: 'running' | 'ok' | 'error';
      output?: string;
      outputTruncated?: boolean;
      endedAt?: string;
    }
  | {
      kind: 'question';
      id: string;
      at: string;
      toolUseId?: string;
      question: string;
      options?: string[];
      answer?: string | null;
    }
  | {
      kind: 'turn';
      id: string;
      at: string;
      state: 'completed' | 'failed' | 'interrupted';
      durationMs?: number;
      costUsd?: number;
      error?: string;
    }
  | { kind: 'system'; id: string; at: string; text: string };

/** One page of a session's transcript, oldest first. */
export interface TranscriptPage {
  sessionId: string;
  items: TranscriptItem[];
  /** Pass as `before` to read the page older than this one; null at the start. */
  before: string | null;
  /** Whether deltas for this session can still arrive. */
  live: boolean;
}

export type TranscriptDelta =
  /** Upsert by id: a tool's status/output update reuses its id. */
  | { type: 'items'; sessionId: string; items: TranscriptItem[] }
  /** Partial tokens; the final item with the same id replaces the streamed text. */
  | { type: 'stream'; sessionId: string; itemId: string; kind: 'assistant' | 'thinking'; textDelta: string };

export interface StreamingText {
  kind: 'assistant' | 'thinking';
  text: string;
}

/**
 * Fold one delta into a feed. Pure: inputs are never mutated, and a delta
 * that changes nothing returns the same objects.
 *
 * Items upsert by id, keeping an existing item's position. A stream delta
 * accumulates until an item with its id arrives, which ends the stream; a
 * late stream delta for an item already final is dropped. A turn item ends
 * every stream.
 */
export function applyTranscriptDelta(
  items: TranscriptItem[],
  streaming: Record<string, StreamingText>,
  delta: TranscriptDelta,
): { items: TranscriptItem[]; streaming: Record<string, StreamingText> } {
  if (delta.type === 'stream') {
    if (!delta.textDelta || items.some((item) => item.id === delta.itemId)) return { items, streaming };
    const previous = streaming[delta.itemId];
    return {
      items,
      streaming: {
        ...streaming,
        [delta.itemId]: { kind: delta.kind, text: (previous?.text ?? '') + delta.textDelta },
      },
    };
  }

  if (!delta.items.length) return { items, streaming };
  const next = items.slice();
  const index = new Map(next.map((item, position) => [item.id, position]));
  let nextStreaming = streaming;
  for (const item of delta.items) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = item;
    }
    if (item.id in nextStreaming) {
      if (nextStreaming === streaming) nextStreaming = { ...streaming };
      delete nextStreaming[item.id];
    }
    // Nothing streams past the end of a turn; a stream whose final item never
    // came (or came under another id) must not hang there.
    if (item.kind === 'turn' && Object.keys(nextStreaming).length) nextStreaming = {};
  }
  return { items: next, streaming: nextStreaming };
}

/** Older items ahead of a feed, without duplicating any it already holds. */
export function prependTranscriptItems(older: TranscriptItem[], items: TranscriptItem[]): TranscriptItem[] {
  if (!older.length) return items;
  const held = new Set(items.map((item) => item.id));
  return [...older.filter((item) => !held.has(item.id)), ...items];
}

/**
 * The page of `items` ending just before the item `before` (or at the end),
 * at most `limit` long. An unknown cursor reads nothing rather than guessing.
 */
export function pageTranscript(
  items: TranscriptItem[],
  options: { before?: string; limit?: number } = {},
): { items: TranscriptItem[]; before: string | null } {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_TRANSCRIPT_PAGE));
  let end = items.length;
  if (options.before !== undefined) {
    end = items.findIndex((item) => item.id === options.before);
    if (end < 0) return { items: [], before: null };
  }
  const start = Math.max(0, end - limit);
  return { items: items.slice(start, end), before: start > 0 ? items[start]!.id : null };
}

export const DEFAULT_TRANSCRIPT_PAGE = 200;

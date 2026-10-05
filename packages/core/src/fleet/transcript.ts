/**
 * A fleet agent's transcript: what it was told, what it said and thought, and
 * what it did — separate from Vowe's own event pipeline.
 *
 * Browser-safe and import-free, so the renderer can apply deltas itself.
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

export interface TranscriptPage {
  sessionId: string;
  items: TranscriptItem[];
  before: string | null;
  live: boolean;
}

export type TranscriptDelta =
  | { type: 'items'; sessionId: string; items: TranscriptItem[] }
  | { type: 'stream'; sessionId: string; itemId: string; kind: 'assistant' | 'thinking'; textDelta: string };

type TranscriptStreaming = Record<string, { kind: 'assistant' | 'thinking'; text: string }>;

/**
 * Items upsert by id, in place; new ones are appended. A streamed item's
 * partial text is dropped once its final item arrives.
 */
export function applyTranscriptDelta(
  items: TranscriptItem[],
  streaming: TranscriptStreaming,
  delta: TranscriptDelta,
): { items: TranscriptItem[]; streaming: TranscriptStreaming } {
  if (delta.type === 'stream') {
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
  }
  return { items: next, streaming: nextStreaming };
}

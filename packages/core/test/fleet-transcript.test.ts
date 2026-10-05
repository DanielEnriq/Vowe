import { afterEach, describe, expect, it } from 'vitest';

import { relayMessage, relayOriginOf } from '../src/fleet/fleet-relay.js';
import {
  applyTranscriptDelta,
  pageTranscript,
  prependTranscriptItems,
  type StreamingText,
  type TranscriptDelta,
  type TranscriptItem,
  type TranscriptPage,
} from '../src/fleet/transcript.js';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { AgentAdapter, InstructionResult, Unsubscribe } from '../src/types/adapter.js';
import type { AgentSession } from '../src/types/session.js';
import { temporaryStore, testSession } from './helpers.js';

const AT = '2026-01-01T00:00:00.000Z';
const S = 'claude-code:one';

function text(id: string, body = id): TranscriptItem {
  return { kind: 'assistant', id, at: AT, text: body };
}

function tool(id: string, status: 'running' | 'ok' | 'error', output?: string): TranscriptItem {
  return {
    kind: 'tool',
    id,
    at: AT,
    toolUseId: `toolu_${id}`,
    name: 'Bash',
    input: { command: 'pnpm test' },
    summary: 'Bash · pnpm test',
    status,
    ...(output !== undefined ? { output, endedAt: AT } : {}),
  };
}

function items(...list: TranscriptItem[]): TranscriptDelta {
  return { type: 'items', sessionId: S, items: list };
}

function stream(itemId: string, textDelta: string, kind: 'assistant' | 'thinking' = 'assistant'): TranscriptDelta {
  return { type: 'stream', sessionId: S, itemId, kind, textDelta };
}

function fold(deltas: TranscriptDelta[]) {
  let state: { items: TranscriptItem[]; streaming: Record<string, StreamingText> } = { items: [], streaming: {} };
  for (const delta of deltas) state = applyTranscriptDelta(state.items, state.streaming, delta);
  return state;
}

describe('applyTranscriptDelta', () => {
  it('appends new items and upserts known ids in place', () => {
    const state = fold([items(text('a'), text('b')), items(text('c')), items(text('a', 'A again'))]);
    expect(state.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(state.items[0]).toMatchObject({ text: 'A again' });
  });

  it("updates a tool's status and output under the same id", () => {
    const state = fold([items(tool('t', 'running'), text('after')), items(tool('t', 'error', 'boom'))]);
    expect(state.items.map((item) => item.id)).toEqual(['t', 'after']);
    expect(state.items[0]).toMatchObject({ status: 'error', output: 'boom', endedAt: AT });
  });

  it('accumulates a stream, then lets the final item replace it', () => {
    let state = fold([stream('m:0', 'Hel'), stream('m:0', 'lo'), stream('m:1', 'hmm', 'thinking')]);
    expect(state.items).toEqual([]);
    expect(state.streaming).toEqual({
      'm:0': { kind: 'assistant', text: 'Hello' },
      'm:1': { kind: 'thinking', text: 'hmm' },
    });
    state = applyTranscriptDelta(state.items, state.streaming, items(text('m:0', 'Hello, world')));
    expect(state.items).toEqual([text('m:0', 'Hello, world')]);
    expect(state.streaming).toEqual({ 'm:1': { kind: 'thinking', text: 'hmm' } });
  });

  it('drops a late stream for an item already final', () => {
    const before = fold([items(text('m:0', 'done'))]);
    const after = applyTranscriptDelta(before.items, before.streaming, stream('m:0', ' more'));
    expect(after.items).toBe(before.items);
    expect(after.streaming).toBe(before.streaming);
  });

  it('ends every stream when a turn ends', () => {
    const state = fold([
      stream('m:0', 'never finalised'),
      items({ kind: 'turn', id: 'turn:1', at: AT, state: 'interrupted' }),
    ]);
    expect(state.streaming).toEqual({});
    expect(state.items.map((item) => item.kind)).toEqual(['turn']);
  });

  it('never mutates its inputs', () => {
    const start = fold([items(text('a')), stream('s', 'x')]);
    const frozenItems = Object.freeze([...start.items]);
    const frozenStreaming = Object.freeze({ ...start.streaming });
    const next = applyTranscriptDelta(frozenItems as TranscriptItem[], frozenStreaming, items(text('a', 'b'), text('s')));
    expect(frozenItems[0]).toEqual(text('a'));
    expect(next.items).toEqual([text('a', 'b'), text('s')]);
    expect(next.streaming).toEqual({});
  });
});

describe('transcript paging', () => {
  const all = ['a', 'b', 'c', 'd', 'e'].map((id) => text(id));

  it('reads the newest page, then older pages by cursor', () => {
    const newest = pageTranscript(all, { limit: 2 });
    expect(newest.items.map((item) => item.id)).toEqual(['d', 'e']);
    expect(newest.before).toBe('d');
    const older = pageTranscript(all, { before: 'd', limit: 2 });
    expect(older.items.map((item) => item.id)).toEqual(['b', 'c']);
    const oldest = pageTranscript(all, { before: older.before!, limit: 2 });
    expect(oldest).toEqual({ items: [text('a')], before: null });
  });

  it('reads nothing for an unknown cursor', () => {
    expect(pageTranscript(all, { before: 'zz' })).toEqual({ items: [], before: null });
  });

  it('prepends an older page without repeating held items', () => {
    expect(prependTranscriptItems([text('a'), text('b')], [text('b', 'newer'), text('c')])).toEqual([
      text('a'),
      text('b', 'newer'),
      text('c'),
    ]);
  });
});

describe('relayOriginOf', () => {
  it("recognises the relay's own messages and nothing else", () => {
    const asked = relayMessage(null, {
      id: 'x',
      projectId: 'p',
      askerSessionId: 'a',
      questionId: 'q',
      question: 'Which?',
      askedAt: AT,
      status: 'pending',
    } as Parameters<typeof relayMessage>[1]);
    expect(relayOriginOf(asked)).toBe('relay');
    expect(relayOriginOf('Answer to your earlier question (Which?):\nThis one.')).toBe('captain');
    expect(relayOriginOf('please fix the build')).toBeNull();
  });
});

/** A provider without a transcript feed, and one with. */
class PlainAdapter implements AgentAdapter {
  readonly sent: string[] = [];
  constructor(readonly provider: string) {}
  async discoverSessions(): Promise<AgentSession[]> {
    return [this.session()];
  }
  async getSession(): Promise<AgentSession | null> {
    return this.session();
  }
  subscribeToEvents(): Unsubscribe {
    return () => undefined;
  }
  async sendInstruction(_id: string, body: string): Promise<InstructionResult> {
    this.sent.push(body);
    return { delivered: true, via: this.provider };
  }
  protected session(): AgentSession {
    return testSession({
      id: `${this.provider}:one`,
      provider: this.provider,
      providerSessionId: 'one',
      capabilities: { ...testSession().capabilities, sendInstruction: true },
    });
  }
}

class FeedAdapter extends PlainAdapter {
  listener: ((delta: TranscriptDelta) => void) | null = null;
  asked: Array<{ id: string; options: unknown }> = [];
  async readTranscript(id: string, options?: { before?: string; limit?: number }): Promise<TranscriptPage> {
    this.asked.push({ id, options });
    return { sessionId: `feed:${id}`, items: [text('x')], before: null, live: true };
  }
  onTranscriptDelta(listener: (delta: TranscriptDelta) => void): Unsubscribe {
    this.listener = listener;
    return () => (this.listener = null);
  }
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe('SessionRegistry transcript feed', () => {
  it('maps ids to the provider, and is empty for a provider without a feed', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    const registry = new SessionRegistry({ store: opened.store, reconcileIntervalMs: 60_000 });
    const plain = new PlainAdapter('plain');
    const feed = new FeedAdapter('feed');
    registry.registerAdapter(plain);
    registry.registerAdapter(feed);
    await registry.start();

    expect(await registry.getTranscript('plain:one')).toEqual({
      sessionId: 'plain:one',
      items: [],
      before: null,
      live: false,
    });
    expect(await registry.getTranscript('nobody:none')).toMatchObject({ items: [], live: false });

    const page = await registry.getTranscript('feed:one', { before: 'y', limit: 5 });
    expect(feed.asked).toEqual([{ id: 'one', options: { before: 'y', limit: 5 } }]);
    expect(page).toEqual({ sessionId: 'feed:one', items: [text('x')], before: null, live: true });

    const deltas: TranscriptDelta[] = [];
    registry.on('transcript', (delta) => deltas.push(delta));
    feed.listener?.({ type: 'stream', sessionId: 'feed:one', itemId: 'm:0', kind: 'assistant', textDelta: 'hi' });
    expect(deltas).toHaveLength(1);
    await registry.stop();
    expect(feed.listener).toBeNull();
  });

  it('sends to an agent over the relay path without a conversation entry', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    const registry = new SessionRegistry({ store: opened.store, reconcileIntervalMs: 60_000 });
    const feed = new FeedAdapter('feed');
    registry.registerAdapter(feed);
    await registry.start();

    // What the desktop's sendToAgent handler calls.
    const result = await registry.relayToWorker('feed:one', 'run the tests');
    expect(result).toEqual({ delivered: true, via: 'feed' });
    expect(feed.sent).toEqual(['run the tests']);
    expect(opened.store.getConversation('feed:one')).toEqual([]);
    await registry.stop();
  });
});

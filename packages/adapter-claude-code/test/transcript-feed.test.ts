import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  applyTranscriptDelta,
  type StreamingText,
  type TranscriptDelta,
  type TranscriptItem,
  type WorkerOutcome,
} from '@vowe/core';
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../src/adapter.js';
import { defaultPaths } from '../src/paths.js';
import { TOOL_OUTPUT_LIMIT, TranscriptBuilder, toolSummary } from '../src/transcript-feed.js';

const FIXTURE = new URL('./fixtures/transcript-feed.jsonl', import.meta.url).pathname;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A Claude home with one project directory, removed after the test. */
async function claudeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vowe-feed-'));
  const dir = path.join(home, 'projects', '-work-demo');
  await mkdir(dir, { recursive: true });
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return { paths: defaultPaths(home), dir };
}

function adapterFor(paths: ReturnType<typeof defaultPaths>, extra: Partial<ConstructorParameters<typeof ClaudeCodeAdapter>[0]> = {}) {
  const adapter = new ClaudeCodeAdapter({ paths, pollIntervalMs: 20, ...extra });
  cleanups.push(() => adapter.dispose());
  return adapter;
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

describe('Claude Code transcript history', () => {
  it('reads every block type from a transcript into items', async () => {
    const { paths, dir } = await claudeHome();
    await copyFile(FIXTURE, path.join(dir, 'feed-session.jsonl'));
    const page = await adapterFor(paths).readTranscript('feed-session');

    expect(page.sessionId).toBe('claude-code:feed-session');
    expect(page.before).toBeNull();
    expect(page.live).toBe(false);
    const read = page.items.find((item) => item.id === 'msg_2:3');
    expect(read).toMatchObject({ kind: 'tool', outputTruncated: true });
    expect(read?.kind === 'tool' ? read.output?.length : 0).toBe(TOOL_OUTPUT_LIMIT);

    expect(page.items.map(({ at: _at, ...item }) => (item.kind === 'tool' ? { ...item, output: item.output?.slice(0, 20), input: undefined } : item))).toEqual([
      { kind: 'user', id: 'u-task', text: 'Add a health check endpoint', origin: 'task' },
      { kind: 'thinking', id: 'msg_1:0', text: 'Look at the server first.' },
      { kind: 'assistant', id: 'msg_1:1', text: 'I will check the server.' },
      {
        kind: 'tool',
        id: 'msg_1:2',
        toolUseId: 'toolu_bash',
        name: 'Bash',
        input: undefined,
        summary: 'Bash · pnpm test',
        status: 'ok',
        output: '12 passed',
        endedAt: '2026-01-01T00:00:07.000Z',
      },
      { kind: 'thinking', id: 'msg_2:0', text: '', redacted: true },
      { kind: 'thinking', id: 'msg_2:1', text: '', redacted: true },
      {
        kind: 'tool',
        id: 'msg_2:2',
        toolUseId: 'toolu_edit',
        name: 'Edit',
        input: undefined,
        summary: 'Edit · src/server.ts',
        status: 'error',
        output: 'String not found',
        endedAt: '2026-01-01T00:00:12.000Z',
      },
      {
        kind: 'tool',
        id: 'msg_2:3',
        toolUseId: 'toolu_read',
        name: 'Read',
        input: undefined,
        summary: 'Read · /elsewhere/notes.md',
        status: 'ok',
        output: 'x'.repeat(20),
        outputTruncated: true,
        endedAt: '2026-01-01T00:00:13.000Z',
      },
      {
        kind: 'question',
        id: 'msg_3:0',
        toolUseId: 'toolu_ask',
        question: 'Which port?',
        options: ['3000', '8080'],
        answer: '8080',
      },
      { kind: 'assistant', id: 'msg_4:0', text: 'Added **/health**.' },
      { kind: 'turn', id: 'turn:s-1', state: 'completed', durationMs: 4200 },
      { kind: 'user', id: 'u-relay', text: '[Vowe relay] A question from api agent.\n\nWhich port?', origin: 'relay' },
      { kind: 'user', id: 'u-captain', text: 'Answer to your earlier question (Which port?):\n8080, see src/config.ts:4', origin: 'captain' },
      { kind: 'user', id: 'u-you', text: 'Also add a readiness probe', origin: 'you' },
      { kind: 'user', id: 'u-cmd', text: '/review src', origin: 'you' },
      { kind: 'turn', id: 'turn:u-int', state: 'interrupted' },
      { kind: 'system', id: 's-3', text: 'Conversation compacted' },
    ]);
    expect(page.items[0]!.at).toBe('2026-01-01T00:00:02.000Z');
  });

  it('pages backwards by item id', async () => {
    const { paths, dir } = await claudeHome();
    await copyFile(FIXTURE, path.join(dir, 'feed-session.jsonl'));
    const adapter = adapterFor(paths);

    const newest = await adapter.readTranscript('feed-session', { limit: 5 });
    expect(newest.items.map((item) => item.id)).toEqual(['u-captain', 'u-you', 'u-cmd', 'turn:u-int', 's-3']);
    expect(newest.before).toBe('u-captain');
    const older = await adapter.readTranscript('feed-session', { before: newest.before!, limit: 5 });
    expect(older.items.map((item) => item.id)).toEqual(['msg_2:3', 'msg_3:0', 'msg_4:0', 'turn:s-1', 'u-relay']);
    expect(older.before).toBe('msg_2:3');
    const rest = await adapter.readTranscript('feed-session', { before: older.before!, limit: 100 });
    expect(rest.before).toBeNull();
    expect(rest.items.length + older.items.length + newest.items.length).toBe(17);
  });

  it('is empty for a session with no transcript', async () => {
    const { paths } = await claudeHome();
    expect(await adapterFor(paths).readTranscript('nowhere')).toEqual({
      sessionId: 'claude-code:nowhere',
      items: [],
      before: null,
      live: false,
    });
  });

  it("tails an external session's transcript into item deltas", async () => {
    const { paths, dir } = await claudeHome();
    const file = path.join(dir, 'tail.jsonl');
    await writeFile(file, line({ type: 'user', uuid: 'u1', timestamp: 'T1', message: { content: 'Go' } }));
    const adapter = adapterFor(paths);
    const deltas: TranscriptDelta[] = [];
    adapter.onTranscriptDelta((delta) => deltas.push(delta));

    const page = await adapter.readTranscript('tail');
    expect(page.items.map((item) => item.id)).toEqual(['u1']);
    expect(deltas).toEqual([]); // history is a page, not a delta

    await appendFile(
      file,
      line({ type: 'assistant', uuid: 'a1', timestamp: 'T2', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } }] } }) +
        line({ type: 'user', uuid: 'r1', timestamp: 'T3', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'a.ts' }] } }),
    );
    await vi.waitFor(() => expect(deltas.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(deltas[0]).toEqual({
      type: 'items',
      sessionId: 'claude-code:tail',
      items: [
        {
          kind: 'tool',
          id: 'm:0',
          at: 'T2',
          toolUseId: 'tu',
          name: 'Bash',
          input: { command: 'ls' },
          summary: 'Bash · ls',
          status: 'ok',
          output: 'a.ts',
          endedAt: 'T3',
        },
      ],
    });
  });
});

describe('toolSummary', () => {
  it('names the tool and its subject in one line', () => {
    expect(toolSummary('Bash', { command: '\n  pnpm test -- --run\nsecond' })).toBe('Bash · pnpm test -- --run');
    expect(toolSummary('Edit', { file_path: '/r/src/x.ts' }, '/r')).toBe('Edit · src/x.ts');
    expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('Grep · TODO');
    expect(toolSummary('TodoWrite', { todos: [] })).toBe('TodoWrite');
  });
});

/** The SDK's `query()`, scripted: a session id first, then whatever is pushed. */
function fakeQuery() {
  const pending: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let options: Options | undefined;
  const push = (message: Record<string, unknown>) => {
    pending.push({ session_id: 'sess-1', parent_tool_use_id: null, ...message } as unknown as SDKMessage);
    wake?.();
  };
  const query = ((args: { prompt: unknown; options?: Options }) => {
    options = args.options;
    push({ type: 'system', subtype: 'init', uuid: 'init' });
    const iterator = (async function* () {
      while (true) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => undefined,
      close: () => {
        done = true;
        wake?.();
      },
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
  return { query, push, options: () => options! };
}

const MSG = 'msg_live';
const blocks = [
  { type: 'thinking', thinking: '', signature: 's' },
  { type: 'text', text: 'Running the tests.' },
  { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
];

function streamEvent(event: Record<string, unknown>) {
  return { type: 'stream_event', uuid: `se-${Math.random()}`, event };
}

describe('Claude Code live transcript tee', () => {
  it('streams under the final ids, replaces streams with final items, and agrees with history', async () => {
    const { paths, dir } = await claudeHome();
    const fake = fakeQuery();
    const adapter = adapterFor(paths, { query: fake.query });
    const deltas: TranscriptDelta[] = [];
    const outcomes: WorkerOutcome[] = [];
    adapter.onTranscriptDelta((delta) => deltas.push(delta));
    adapter.onOutcome((outcome) => outcomes.push(outcome));

    await adapter.launchSession({ cwd: '/work/demo', prompt: 'Test it' });
    expect(fake.options().includePartialMessages).toBe(true);

    fake.push(streamEvent({ type: 'message_start', message: { id: MSG } }));
    fake.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    fake.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Tests ' } }));
    fake.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first.' } }));
    fake.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } }));
    fake.push({ type: 'assistant', uuid: 'sdk-a0', message: { id: MSG, role: 'assistant', content: [blocks[0]] } });
    fake.push(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Running ' } }));
    fake.push(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the tests.' } }));
    fake.push({ type: 'assistant', uuid: 'sdk-a1', message: { id: MSG, role: 'assistant', content: [blocks[1]] } });
    fake.push({ type: 'assistant', uuid: 'sdk-a2', message: { id: MSG, role: 'assistant', content: [blocks[2]] } });
    // A subagent's frames are not this session's transcript.
    fake.push({ type: 'assistant', uuid: 'sub', parent_tool_use_id: 'toolu_task', message: { id: 'msg_sub', content: [{ type: 'text', text: 'sub' }] } });
    fake.push({
      type: 'user',
      uuid: 'sdk-u1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'all passed', is_error: false }] },
    });
    fake.push({
      type: 'result',
      subtype: 'success',
      uuid: 'res-1',
      is_error: false,
      result: 'Done.',
      duration_ms: 900,
      total_cost_usd: 0.25,
      errors: [],
    });
    await vi.waitFor(() => expect(outcomes.at(-1)?.state).toBe('completed'));

    const streams = deltas.filter((delta) => delta.type === 'stream');
    expect(streams.map((delta) => [delta.itemId, delta.kind, delta.textDelta])).toEqual([
      [`${MSG}:0`, 'thinking', 'Tests '],
      [`${MSG}:0`, 'thinking', 'first.'],
      [`${MSG}:1`, 'assistant', 'Running '],
      [`${MSG}:1`, 'assistant', 'the tests.'],
    ]);
    expect(deltas.every((delta) => delta.sessionId === 'claude-code:sess-1')).toBe(true);

    // What a reader holding every delta ends up with.
    let state: { items: TranscriptItem[]; streaming: Record<string, StreamingText> } = { items: [], streaming: {} };
    const seen: Array<Record<string, StreamingText>> = [];
    for (const delta of deltas) {
      state = applyTranscriptDelta(state.items, state.streaming, delta);
      seen.push(state.streaming);
    }
    expect(seen.some((streaming) => streaming[`${MSG}:1`]?.text === 'Running the tests.')).toBe(true);
    expect(state.streaming).toEqual({});
    expect(state.items.map(({ at: _at, ...item }) => item)).toEqual([
      // The SDK recorded the thought without its words; the stream had them.
      { kind: 'thinking', id: `${MSG}:0`, text: 'Tests first.' },
      { kind: 'assistant', id: `${MSG}:1`, text: 'Running the tests.' },
      {
        kind: 'tool',
        id: `${MSG}:2`,
        toolUseId: 'toolu_1',
        name: 'Bash',
        input: { command: 'pnpm test' },
        summary: 'Bash · pnpm test',
        status: 'ok',
        output: 'all passed',
        endedAt: expect.any(String),
      },
      { kind: 'turn', id: 'turn:res-1', state: 'completed', durationMs: 900, costUsd: 0.25 },
    ]);

    // Before the CLI flushes its transcript, a page is what the SDK delivered.
    const early = await adapter.readTranscript('sess-1');
    expect(early.live).toBe(true);
    expect(early.items.map((item) => item.id)).toEqual([`${MSG}:0`, `${MSG}:1`, `${MSG}:2`, 'turn:res-1']);

    // The CLI writes the same message one block per record. History names
    // each block exactly as the stream did, and the SDK's fuller thinking wins.
    await writeFile(
      path.join(dir, 'sess-1.jsonl'),
      line({ type: 'user', uuid: 'u-prompt', timestamp: 'T0', message: { content: 'Test it' } }) +
        blocks.map((block, i) => line({ type: 'assistant', uuid: `rec-${i}`, timestamp: `T${i + 1}`, message: { id: MSG, content: [block] } })).join(''),
    );
    const history = await adapter.readTranscript('sess-1');
    expect(history.items.map((item) => item.id)).toEqual(['u-prompt', `${MSG}:0`, `${MSG}:1`, `${MSG}:2`, 'turn:res-1']);
    expect(history.items[1]).toMatchObject({ kind: 'thinking', text: 'Tests first.' });
    expect(history.items[0]).toMatchObject({ kind: 'user', origin: 'task' });
  });

  it('reports an interrupted turn as interrupted, and a turn its own share of the cost', async () => {
    const { paths } = await claudeHome();
    const fake = fakeQuery();
    const adapter = adapterFor(paths, { query: fake.query });
    const deltas: TranscriptDelta[] = [];
    adapter.onTranscriptDelta((delta) => deltas.push(delta));
    await adapter.launchSession({ cwd: '/w', prompt: 'p' });

    fake.push({ type: 'result', subtype: 'success', uuid: 'r1', is_error: false, result: '', duration_ms: 1, total_cost_usd: 0.1, errors: [] });
    fake.push({
      type: 'result',
      subtype: 'error_during_execution',
      uuid: 'r2',
      is_error: true,
      duration_ms: 2,
      total_cost_usd: 0.15,
      errors: [],
      terminal_reason: 'aborted_streaming',
    });
    fake.push({ type: 'result', subtype: 'error_max_turns', uuid: 'r3', is_error: true, duration_ms: 3, total_cost_usd: 0.15, errors: ['too many'] });
    await vi.waitFor(() => expect(deltas).toHaveLength(3));
    const turns = deltas.flatMap((delta) => (delta.type === 'items' ? delta.items : []));
    expect(turns.map((turn) => (turn.kind === 'turn' ? [turn.state, turn.costUsd, turn.error] : null))).toEqual([
      ['completed', 0.1, undefined],
      ['interrupted', expect.closeTo(0.05, 10), undefined],
      ['failed', 0, 'error_max_turns: too many'],
    ]);
  });
});

describe('TranscriptBuilder', () => {
  it('numbers blocks across records of one message, and within one record', () => {
    const builder = new TranscriptBuilder();
    builder.consume({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } } as never, 'T');
    builder.consume({ type: 'assistant', uuid: 'b', message: { id: 'm', content: [{ type: 'text', text: 'three' }] } } as never, 'T');
    expect(builder.all().map((item) => item.id)).toEqual(['m:0', 'm:1', 'm:2']);
  });
});

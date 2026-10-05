import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSession, CaptainExchange, FleetLayout, Project, TranscriptItem } from '@vowe/core';
import { applyTranscriptDelta } from '@vowe/core/fleet-transcript';

import { AgentView } from '../src/renderer/fleet/AgentView.js';
import {
  ROW_WINDOW,
  afterGrowth,
  afterScroll,
  agentElapsed,
  atBottom,
  clusterWords,
  composerBlock,
  currentTurn,
  exchangeFor,
  pendingSend,
  questionAnswer,
  replacementLines,
  settlePending,
  showJump,
  thinkingLabel,
  toolHeadline,
  toolView,
  touchedFiles,
  transcriptRows,
  turnInFlight,
  turnLabel,
  unifiedPatch,
  windowStart,
  type ResponsePart,
  type ToolItem,
} from '../src/renderer/state/fleet-transcript.js';

const PROJECT: Project = {
  id: 'git:abc',
  name: 'Payments',
  repoRoot: '/repo/payments',
  createdAt: '2026-09-01T00:00:00.000Z',
  folders: [{ path: '/repo/payments', isDefault: true, addedAt: '2026-09-01T00:00:00.000Z' }],
};

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'a',
    provider: 'claude-code',
    providerSessionId: 'a',
    attachMode: 'managed',
    task: null,
    displayLabel: 'a',
    cwd: '/repo/payments',
    projectId: PROJECT.id,
    status: 'working',
    createdAt: '2026-10-01T09:00:00.000Z',
    lastActivityAt: '2026-10-01T09:04:12.000Z',
    capabilities: { observe: true, sendInstruction: true, interrupt: true, resume: true, launch: true, reasoning: false },
    semanticState: null,
    ...overrides,
  };
}

const at = (second: number) => `2026-10-01T09:00:${String(second).padStart(2, '0')}.000Z`;

const user = (id: string, text: string, origin: 'task' | 'you' | 'captain' | 'relay' = 'you', second = 0): TranscriptItem => ({
  kind: 'user',
  id,
  at: at(second),
  text,
  origin,
});
const said = (id: string, text: string, second = 0): TranscriptItem => ({ kind: 'assistant', id, at: at(second), text });
const thought = (id: string, text: string, second = 0, redacted?: boolean): TranscriptItem => ({
  kind: 'thinking',
  id,
  at: at(second),
  text,
  ...(redacted ? { redacted } : {}),
});
function tool(id: string, name: string, input: unknown, overrides: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', id, at: at(0), toolUseId: `tu-${id}`, name, input, summary: '', status: 'ok', ...overrides };
}
const turn = (id: string, state: 'completed' | 'failed' | 'interrupted' = 'completed', second = 0): TranscriptItem => ({
  kind: 'turn',
  id,
  at: at(second),
  state,
});

function exchange(overrides: Partial<CaptainExchange> & { id: string }): CaptainExchange {
  return {
    projectId: PROJECT.id,
    askerSessionId: 'a',
    questionId: `q-${overrides.id}`,
    captainSessionId: 'cap',
    question: 'Where is the ceiling?',
    captainAnswer: null,
    route: 'captain',
    userAnswer: null,
    status: 'pending',
    delivery: null,
    askedAt: at(0),
    answeredAt: null,
    ...overrides,
  };
}

describe('applyTranscriptDelta', () => {
  it('upserts items by id in place and appends new ones', () => {
    const first = tool('t1', 'Bash', { command: 'ls' }, { status: 'running' });
    const start = applyTranscriptDelta([user('u', 'go', 'task'), first], {}, {
      type: 'items',
      sessionId: 'a',
      items: [{ ...first, status: 'ok', output: 'a\nb' }, said('s', 'done')],
    });
    expect(start.items.map((item) => item.id)).toEqual(['u', 't1', 's']);
    expect(start.items[1]).toMatchObject({ status: 'ok', output: 'a\nb' });
  });

  it('accumulates streamed text and drops it when the final item lands', () => {
    let state = applyTranscriptDelta([], {}, { type: 'stream', sessionId: 'a', itemId: 'x', kind: 'assistant', textDelta: 'Hel' });
    state = applyTranscriptDelta(state.items, state.streaming, { type: 'stream', sessionId: 'a', itemId: 'x', kind: 'assistant', textDelta: 'lo' });
    expect(state.streaming).toEqual({ x: { kind: 'assistant', text: 'Hello' } });
    state = applyTranscriptDelta(state.items, state.streaming, { type: 'items', sessionId: 'a', items: [said('x', 'Hello.')] });
    expect(state.streaming).toEqual({});
    expect(state.items).toEqual([said('x', 'Hello.')]);
  });
});

describe('transcriptRows', () => {
  it('folds the agent’s consecutive output into one response and numbers turns', () => {
    const rows = transcriptRows([
      user('task', 'Split the retry policy out.', 'task'),
      thought('th', 'Look at the handler first.', 1),
      said('s1', 'The handler does three things.', 5),
      tool('t1', 'Read', { file_path: '/repo/payments/webhook/handler.ts' }),
      turn('end1'),
      user('m', 'Also move jitter.', 'you'),
      said('s2', 'Moved.'),
      turn('end2', 'interrupted'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['task', 'response', 'turn', 'message', 'response', 'turn']);
    const first = rows[1] as Extract<(typeof rows)[number], { kind: 'response' }>;
    expect(first.parts.map((part) => part.kind)).toEqual(['thinking', 'text', 'tool']);
    expect((first.parts[0] as Extract<ResponsePart, { kind: 'thinking' }>).durationMs).toBe(4000);
    expect(rows.filter((row) => row.kind === 'turn').map((row) => (row as { number: number }).number)).toEqual([1, 2]);
  });

  it('keeps captain and relay messages apart from yours, and a question breaks a response', () => {
    const rows = transcriptRows([
      said('s1', 'Asking.'),
      { kind: 'question', id: 'q', at: at(1), question: 'Which ceiling?' },
      user('c', 'Use config.', 'captain'),
      said('s2', 'Thanks.'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['response', 'question', 'message', 'response']);
    expect(rows[2]).toMatchObject({ origin: 'captain', pending: false });
  });

  it('appends streamed text not yet committed, after the committed output', () => {
    const rows = transcriptRows([said('s1', 'Reading.')], {
      th: { kind: 'thinking', text: 'hmm' },
      x: { kind: 'assistant', text: 'Writ' },
    });
    expect(rows).toHaveLength(1);
    const parts = (rows[0] as Extract<(typeof rows)[number], { kind: 'response' }>).parts;
    expect(parts.map((part) => [part.kind, 'streaming' in part ? part.streaming : null])).toEqual([
      ['text', false],
      ['thinking', true],
      ['text', true],
    ]);
  });

  it('ignores a stream whose final item is already present', () => {
    const rows = transcriptRows([said('x', 'Final.')], { x: { kind: 'assistant', text: 'Fin' } });
    const parts = (rows[0] as Extract<(typeof rows)[number], { kind: 'response' }>).parts;
    expect(parts).toEqual([{ kind: 'text', key: 'x', text: 'Final.', streaming: false }]);
  });

  it('shows pending sends after everything else until the transcript has them', () => {
    const items = [said('s', 'Done.')];
    const sent = pendingSend(items, [], 'p1', ' Also the tests. ', at(9));
    const rows = transcriptRows(items, {}, [sent]);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'message', origin: 'you', text: 'Also the tests.', pending: true });
    const echoed = transcriptRows([...items, user('u2', 'Also the tests.')], {}, [sent]);
    expect(echoed.filter((row) => row.kind === 'message')).toHaveLength(1);
    expect(echoed[echoed.length - 1]).toMatchObject({ pending: false });
  });
});

describe('optimistic sends', () => {
  it('settles repeated identical sends one at a time, in order', () => {
    const items: TranscriptItem[] = [user('old', 'continue')];
    const first = pendingSend(items, [], 'p1', 'continue', at(1));
    const second = pendingSend(items, [first], 'p2', 'continue', at(2));
    expect([first.baseline, second.baseline]).toEqual([1, 2]);
    expect(settlePending(items, [first, second]).map((send) => send.id)).toEqual(['p1', 'p2']);
    const one = [...items, user('n1', 'continue')];
    expect(settlePending(one, [first, second]).map((send) => send.id)).toEqual(['p2']);
    expect(settlePending([...one, user('n2', 'continue', 'relay')], [first, second])).toEqual([]);
  });

  it('never settles against the task', () => {
    const send = pendingSend([], [], 'p', 'Fix it', at(1));
    expect(settlePending([user('t', 'Fix it', 'task')], [send])).toHaveLength(1);
  });
});

describe('labels', () => {
  it('names thinking by how long it took, and says when it is redacted', () => {
    const base = { kind: 'thinking' as const, key: 'k', text: 'x', redacted: false, streaming: false, durationMs: 4200 };
    expect(thinkingLabel(base)).toBe('Thinking · 4s');
    expect(thinkingLabel({ ...base, streaming: true, durationMs: null })).toBe('Thinking');
    expect(thinkingLabel({ ...base, durationMs: 300 })).toBe('Thinking');
    expect(thinkingLabel({ ...base, redacted: true })).toBe('Thinking (redacted)');
  });

  it('labels a turn with its number, state, duration and cost', () => {
    expect(turnLabel({ kind: 'turn', id: 't', at: at(0), state: 'completed', durationMs: 42_000, costUsd: 0.031 }, 9)).toBe(
      'Turn 9 · 42s · $0.03',
    );
    expect(turnLabel({ kind: 'turn', id: 't', at: at(0), state: 'failed', error: 'boom' }, 3)).toBe('Turn 3 · failed');
    expect(turnLabel({ kind: 'turn', id: 't', at: at(0), state: 'interrupted', costUsd: 0.004 }, 4)).toBe('Turn 4 · interrupted · <$0.01');
  });

  it('describes a cluster by place and size', () => {
    expect(clusterWords(1, 3)).toEqual({ place: '1 of 3 parallel', compare: 'Compare the three' });
    expect(clusterWords(2, 2).compare).toBe('Compare the two');
    expect(clusterWords(1, 9).compare).toBe('Compare all 9');
  });
});

describe('tool cards', () => {
  it('shows a Bash call as its command', () => {
    const item = tool('b', 'Bash', { command: 'pnpm exec vitest run retry\n--reporter dot', description: 'Run tests' });
    const view = toolView(item, PROJECT);
    expect(view).toEqual({ kind: 'bash', command: 'pnpm exec vitest run retry\n--reporter dot', description: 'Run tests' });
    expect(toolHeadline(item, view).summary).toBe('pnpm exec vitest run retry …');
  });

  it('draws an Edit as a mini diff with project-relative path and counts', () => {
    const item = tool('e', 'Edit', {
      file_path: '/repo/payments/webhook/handler.ts',
      old_string: 'a\nconst CEILING = 30_000;\nlet wait = base;\nz',
      new_string: 'a\nreturn retry(policy, send);\nz',
    });
    const view = toolView(item, PROJECT);
    expect(view.kind).toBe('edit');
    if (view.kind !== 'edit') return;
    expect(view.path).toBe('webhook/handler.ts');
    expect(view.lines.map((line) => line.kind)).toEqual(['context', 'remove', 'remove', 'add', 'context']);
    expect(toolHeadline(item, view)).toEqual({ name: 'Edit', summary: 'webhook/handler.ts', added: 1, removed: 2 });
  });

  it('draws a Write as all additions and a MultiEdit as its edits with gaps', () => {
    const write = toolView(tool('w', 'Write', { file_path: '/repo/payments/retry.ts', content: 'one\ntwo\n' }), PROJECT);
    expect(write).toMatchObject({ kind: 'edit', added: 2, removed: 0 });
    const multi = toolView(
      tool('m', 'MultiEdit', { file_path: 'x.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] }),
      PROJECT,
    );
    expect(multi.kind === 'edit' && multi.lines.map((line) => line.kind)).toEqual(['remove', 'add', 'gap', 'remove']);
  });

  it('cuts a long mini diff and says so', () => {
    const content = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
    const view = toolView(tool('w', 'Write', { file_path: 'big.ts', content }), PROJECT);
    expect(view).toMatchObject({ kind: 'edit', added: 500, truncated: true });
    expect(view.kind === 'edit' && view.lines.length).toBe(240);
  });

  it('names a search by its pattern or path', () => {
    const grep = tool('g', 'Grep', { pattern: 'retryCeilingMs', path: '/repo/payments/config' });
    expect(toolHeadline(grep, toolView(grep, PROJECT)).summary).toBe('retryCeilingMs in config');
    const read = tool('r', 'Read', { file_path: '/repo/payments/a.ts', offset: 10, limit: 5 });
    expect(toolView(read, PROJECT)).toEqual({ kind: 'search', target: 'a.ts', detail: 'lines 10–14' });
  });

  it('falls back to the input as JSON and the worker’s own summary', () => {
    const item = tool('x', 'WebFetch', { url: 'https://example.com' }, { summary: 'example.com' });
    const view = toolView(item, PROJECT);
    expect(view).toEqual({ kind: 'generic', input: '{\n  "url": "https://example.com"\n}' });
    expect(toolHeadline(item, view).summary).toBe('example.com');
    expect(toolView(tool('y', 'Edit', 'not an object'), PROJECT).kind).toBe('generic');
  });

  it('keeps shared head and tail lines as context', () => {
    expect(replacementLines('', 'x')).toEqual([{ kind: 'add', text: 'x' }]);
    expect(replacementLines('same\n', 'same\n')).toEqual([{ kind: 'context', text: 'same' }]);
  });
});

describe('following the end', () => {
  const metrics = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });

  it('follows while within the slack of the bottom', () => {
    expect(atBottom(metrics(600))).toBe(true);
    expect(atBottom(metrics(560))).toBe(true);
    expect(atBottom(metrics(500))).toBe(false);
  });

  it('stops following when scrolled up, counts what arrives, and resumes at the bottom', () => {
    let state = { follow: true, unseen: 0 };
    expect(afterGrowth(state, 2)).toBe(state);
    state = afterScroll(state, metrics(100));
    expect(state).toEqual({ follow: false, unseen: 0 });
    expect(showJump(state)).toBe(true);
    state = afterGrowth(state, 2);
    state = afterGrowth(state, 0);
    expect(state).toEqual({ follow: false, unseen: 2 });
    state = afterScroll(state, metrics(600));
    expect(state).toEqual({ follow: true, unseen: 0 });
    expect(showJump(state)).toBe(false);
  });

  it('keeps the same state object when nothing changed', () => {
    const state = { follow: true, unseen: 0 };
    expect(afterScroll(state, metrics(600))).toBe(state);
  });

  it('windows long transcripts from the end', () => {
    expect(windowStart(50, ROW_WINDOW)).toBe(0);
    expect(windowStart(500, ROW_WINDOW)).toBe(500 - ROW_WINDOW);
    expect(windowStart(500, 1000)).toBe(0);
  });
});

describe('the agent', () => {
  it('is in flight while running, streaming, or with a tool running after the last turn', () => {
    const running = tool('t', 'Bash', { command: 'x' }, { status: 'running' });
    expect(turnInFlight([], {}, 'running')).toBe(true);
    expect(turnInFlight([], { x: { kind: 'assistant', text: '' } }, 'idle')).toBe(true);
    expect(turnInFlight([running], {}, 'needs-you')).toBe(true);
    expect(turnInFlight([running], {}, 'done')).toBe(false);
    expect(turnInFlight([running, turn('e')], {}, undefined)).toBe(false);
    expect(turnInFlight([said('s', 'x')], {}, 'idle')).toBe(false);
  });

  it('counts turns, including the one in flight', () => {
    const items = [turn('a'), said('s', 'x'), turn('b')];
    expect(currentTurn(items, false)).toBe(2);
    expect(currentTurn(items, true)).toBe(3);
  });

  it('measures elapsed to now while working, else to the last activity', () => {
    const now = Date.parse('2026-10-01T09:10:00.000Z');
    expect(agentElapsed(session(), true, now)).toBe(10 * 60_000);
    expect(agentElapsed(session(), false, now)).toBe(4 * 60_000 + 12_000);
  });

  it('gives a terse reason the composer cannot send', () => {
    expect(composerBlock(session())).toBeNull();
    const cannot = { ...session().capabilities, sendInstruction: false };
    expect(composerBlock(session({ capabilities: cannot, attachMode: 'external-live' }))).toBe('Running outside Vowe');
    expect(composerBlock(session({ capabilities: cannot, attachMode: 'external-idle' }))).toBe('Not running');
    expect(composerBlock(session({ capabilities: cannot }))).toBe('Can’t take instructions now');
  });
});

describe('questions', () => {
  const question = { kind: 'question' as const, id: 'q', at: at(0), toolUseId: 'tu-1', question: 'Where is the ceiling?' };

  it('finds the exchange by tool use, else by the question', () => {
    const byTool = exchange({ id: 'x1', toolUseId: 'tu-1', question: 'other words' });
    const byText = exchange({ id: 'x2' });
    const elsewhere = exchange({ id: 'x3', askerSessionId: 'b', toolUseId: 'tu-1' });
    expect(exchangeFor(question, 'a', [elsewhere, byText, byTool])?.id).toBe('x1');
    expect(exchangeFor({ ...question, toolUseId: undefined }, 'a', [elsewhere, byText])?.id).toBe('x2');
    expect(exchangeFor(question, 'a', [elsewhere])).toBeNull();
  });

  it('prefers an unanswered exchange when the same question was asked twice', () => {
    const old = exchange({ id: 'old', status: 'answered', userAnswer: 'no' });
    const fresh = exchange({ id: 'new' });
    expect(exchangeFor({ ...question, toolUseId: undefined }, 'a', [old, fresh])?.id).toBe('new');
  });

  it('reads the answer from the transcript or the exchange, and who gave it', () => {
    const byCaptain = exchange({ id: 'c', status: 'answered', captainAnswer: 'config.ts' });
    expect(questionAnswer(question, byCaptain)).toEqual({ text: 'config.ts', by: 'captain' });
    expect(questionAnswer({ ...question, answer: 'config.ts' }, byCaptain)).toEqual({ text: 'config.ts', by: 'captain' });
    expect(questionAnswer({ ...question, answer: 'mine' }, null)).toEqual({ text: 'mine', by: 'you' });
    expect(questionAnswer(question, exchange({ id: 'p' }))).toBeNull();
  });
});

describe('the diff', () => {
  const patch = [
    'diff --git a/webhook/retry.ts b/webhook/retry.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/webhook/retry.ts',
    '@@ -0,0 +1,2 @@',
    '+export interface RetryPolicy {',
    '+}',
    'diff --git a/webhook/handler.ts b/webhook/handler.ts',
    '--- a/webhook/handler.ts',
    '+++ b/webhook/handler.ts',
    '@@ -48,3 +48,2 @@ export function handle',
    ' const a = 1;',
    '-const CEILING = 30_000;',
    '-let wait = base;',
    '+return retry(policy, send);',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    '… diff truncated',
    'diff --git a/never.ts b/never.ts',
  ].join('\n');

  it('reads each file’s unified lines and counts', () => {
    const files = unifiedPatch(patch);
    expect(files.map((file) => [file.path, file.added, file.removed, file.binary])).toEqual([
      ['webhook/retry.ts', 2, 0, false],
      ['webhook/handler.ts', 1, 2, false],
      ['logo.png', 0, 0, true],
    ]);
    expect(files[1]!.lines.map((line) => line.kind)).toEqual(['hunk', 'context', 'remove', 'remove', 'add']);
    expect(files[1]!.lines[0]!.text).toBe('@@ 48,3 +48,2');
  });

  it('lists touched files first with the diff’s counts, then the rest of the diff', () => {
    const files = touchedFiles(PROJECT, ['/repo/payments/webhook/handler.ts', '/repo/payments/gone.ts'], unifiedPatch(patch));
    expect(files).toEqual([
      { path: 'webhook/handler.ts', added: 1, removed: 2, inDiff: true },
      { path: 'gone.ts', added: null, removed: null, inDiff: false },
      { path: 'webhook/retry.ts', added: 2, removed: 0, inDiff: true },
      { path: 'logo.png', added: 0, removed: 0, inDiff: true },
    ]);
  });
});

describe('AgentView', () => {
  afterEach(() => vi.unstubAllGlobals());

  const layout: FleetLayout = {
    version: 1,
    nodes: [
      { id: 'n1', sessionId: 'a', role: 'agent', x: 0, y: 0, label: 'Attempt A' },
      { id: 'n2', sessionId: 'b', role: 'agent', x: 0, y: 0 },
      { id: 'n3', sessionId: 'c', role: 'agent', x: 0, y: 0 },
      { id: 'cap', sessionId: 'cap', role: 'captain', x: 0, y: 0 },
    ],
    clusters: [{ id: 'k', label: 'Retry', brief: '', memberIds: ['n1', 'n2', 'n3'] }],
    wires: [{ id: 'w', captainId: 'cap', agentId: 'n1' }],
  };

  function render(overrides: Partial<AgentSession> = {}, withApi = true): string {
    vi.stubGlobal('window', {
      vowe: withApi
        ? { getTranscript: vi.fn(), onTranscriptDelta: vi.fn(), sendToAgent: vi.fn(), interruptAgent: vi.fn() }
        : {},
    });
    return renderToStaticMarkup(
      createElement(AgentView, {
        project: PROJECT,
        session: session(overrides),
        layout,
        status: 'running',
        onBack: () => undefined,
        onOpenAgent: () => undefined,
        onCompare: () => undefined,
      }),
    );
  }

  it('heads the view with status, name, its place in the cluster and its captain', () => {
    const html = render();
    expect(html).toContain('Attempt A');
    expect(html).toContain('running');
    expect(html).toContain('1 of 3 parallel');
    expect(html).toContain('Compare the three');
    expect(html).toContain('May ask the captain');
    expect(html).toMatch(/class="fa-stop"[^>]*>Stop/);
    expect(html).toContain('Instruct this agent');
  });

  it('disables the composer with a reason when the session cannot receive', () => {
    const html = render({ capabilities: { ...session().capabilities, sendInstruction: false }, attachMode: 'external-live' });
    expect(html).toContain('placeholder="Running outside Vowe"');
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it('says so when the bridge has no transcript', () => {
    const html = render({}, false);
    expect(html).toContain('Transcript unavailable');
    expect(html).toContain('placeholder="Not available"');
  });
});

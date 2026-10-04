import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentSession,
  AttemptSummary,
  CaptainExchange,
  FleetLayout,
  FleetStatus,
  NormalizedEvent,
  Project,
} from '@vowe/core';
import { FleetCompare } from '../src/renderer/fleet/FleetCompare.js';
import { FleetPanes } from '../src/renderer/fleet/FleetPanes.js';
import { FleetQuestions } from '../src/renderer/fleet/FleetQuestions.js';
import type { FleetViewProps } from '../src/renderer/fleet/types.js';
import {
  attemptColumn,
  chooseAttempt,
  compareGroups,
  isWired,
  separateLine,
} from '../src/renderer/state/fleet-compare.js';
import {
  captainTally,
  eventLine,
  mergeEvents,
  paneLines,
  paneMembers,
  waitingExchange,
} from '../src/renderer/state/fleet-panes.js';
import {
  answeredByCaptain,
  answeredHeader,
  answeredLine,
  askRoster,
  captainSaid,
  passedToYou,
  waitingFor,
} from '../src/renderer/state/fleet-questions.js';
import {
  fleetMembers,
  formatElapsed,
  formatSpan,
  labelsBySession,
  statusLook,
} from '../src/renderer/state/fleet-views.js';

const PROJECT: Project = {
  id: 'git:abc',
  name: 'Hooks',
  repoRoot: '/repo/hooks',
  createdAt: '2026-09-01T00:00:00.000Z',
  folders: [{ path: '/repo/hooks', isDefault: true, addedAt: '2026-09-01T00:00:00.000Z' }],
};

function session(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    provider: 'claude-code',
    providerSessionId: overrides.id,
    attachMode: 'managed',
    task: null,
    displayLabel: overrides.id,
    cwd: '/repo/hooks',
    projectId: PROJECT.id,
    status: 'working',
    createdAt: '2026-10-01T09:00:00.000Z',
    lastActivityAt: '2026-10-01T09:00:00.000Z',
    capabilities: { observe: true, sendInstruction: true, interrupt: true, resume: true, launch: true, reasoning: false },
    semanticState: null,
    ...overrides,
  };
}

let seq = 0;
function event(
  kind: NormalizedEvent['kind'],
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId: 'a',
    seq,
    at: `2026-10-01T09:00:${String(seq).padStart(2, '0')}.000Z`,
    kind,
    summary: '',
    raw: null,
    rawRef: { source: 't.jsonl', byteOffset: seq, line: seq },
    ...overrides,
  };
}

function exchange(overrides: Partial<CaptainExchange> & { id: string }): CaptainExchange {
  return {
    projectId: PROJECT.id,
    askerSessionId: 'a',
    questionId: `q-${overrides.id}`,
    captainSessionId: 'cap',
    question: 'Where is the backoff ceiling?',
    captainAnswer: null,
    route: 'captain',
    userAnswer: null,
    status: 'pending',
    delivery: null,
    askedAt: '2026-10-01T09:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

function summary(overrides: Partial<AttemptSummary> & { sessionId: string }): AttemptSummary {
  return {
    tests: null,
    typecheck: null,
    publicApi: null,
    diff: null,
    diffAttribution: 'own-folder',
    touchedFiles: [],
    turns: 0,
    elapsedMs: 0,
    askedCaptain: 0,
    askedYou: 0,
    ...overrides,
  };
}

/** Captain `n-cap`; attempts A, B, C in one cluster (A and C wired); D and a placeholder loose. */
const LAYOUT: FleetLayout = {
  version: 1,
  nodes: [
    { id: 'n-a', sessionId: 'a', role: 'agent', x: 0, y: 0, label: 'Attempt A' },
    { id: 'n-cap', sessionId: 'cap', role: 'captain', x: 0, y: 200 },
    { id: 'n-b', sessionId: 'b', role: 'agent', x: 200, y: 0, label: 'Attempt B' },
    { id: 'n-c', sessionId: 'c', role: 'agent', x: 400, y: 0, label: 'Attempt C' },
    { id: 'n-d', sessionId: 'd', role: 'agent', x: 0, y: 400, label: 'Docs sweep' },
    { id: 'n-p', sessionId: null, role: 'agent', x: 200, y: 400, label: 'Audit log index' },
  ],
  clusters: [{ id: 'k1', label: 'Retry', brief: 'Split the retry policy out.', memberIds: ['n-a', 'n-b', 'n-c'] }],
  wires: [
    { id: 'w1', captainId: 'n-cap', agentId: 'n-a' },
    { id: 'w2', captainId: 'n-cap', agentId: 'n-c' },
  ],
};

const SESSIONS = [
  session({ id: 'a', lastActivityAt: '2026-10-01T09:01:00.000Z' }),
  session({ id: 'cap', generatedTitle: 'Captain' }),
  session({ id: 'b', lastActivityAt: '2026-10-01T09:05:00.000Z' }),
  session({ id: 'c', status: 'finished', lastActivityAt: '2026-10-01T08:00:00.000Z' }),
  session({ id: 'd', status: 'finished' }),
  session({ id: 'stray', generatedTitle: 'Stray work', lastActivityAt: '2026-10-01T09:10:00.000Z' }),
  session({ id: 'old', archivedAt: '2026-10-01T00:00:00.000Z' }),
];

describe('fleet members', () => {
  it('lists canvas nodes in order, then other live sessions as agents, newest first', () => {
    const members = fleetMembers(LAYOUT, SESSIONS);
    expect(members.map((m) => m.sessionId)).toEqual(['a', 'cap', 'b', 'c', 'd', null, 'stray']);
    expect(members.find((m) => m.sessionId === 'stray')).toMatchObject({ nodeId: null, role: 'agent', label: 'Stray work' });
    expect(members.find((m) => m.nodeId === 'n-p')?.label).toBe('Audit log index');
    expect(labelsBySession(members).get('a')).toBe('Attempt A');
  });

  it('draws each status as a token and a word', () => {
    expect(statusLook('running')).toEqual({ tone: 'ask', word: 'running' });
    expect(statusLook('needs-you')).toEqual({ tone: 'attention', word: 'needs you' });
    expect(statusLook('done')).toEqual({ tone: 'good', word: 'done' });
    expect(statusLook('failed')).toEqual({ tone: 'bad', word: 'failed' });
    expect(statusLook(undefined)).toEqual({ tone: 'idle', word: 'idle' });
  });

  it('formats durations', () => {
    expect(formatElapsed(252_000)).toBe('4m 12s');
    expect(formatElapsed(9_000)).toBe('9s');
    expect(formatElapsed(3_840_000)).toBe('1h 04m');
    expect(formatSpan(40_000)).toBe('40s');
    expect(formatSpan(120_000)).toBe('2m');
  });
});

describe('panes', () => {
  const members = fleetMembers(LAYOUT, SESSIONS);

  it('puts captains first and skips placeholders', () => {
    expect(paneMembers(members, 'rows', false).map((m) => m.sessionId)).toEqual(['cap', 'a', 'b', 'c', 'd', 'stray']);
  });

  it('caps the grid, and following the newest promotes recent agents into it', () => {
    expect(paneMembers(members, '2x2', false).map((m) => m.sessionId)).toEqual(['cap', 'a', 'b', 'c']);
    expect(paneMembers(members, '2x2', true).map((m) => m.sessionId)).toEqual(['cap', 'stray', 'b', 'a']);
    expect(paneMembers(members, '3x2', false)).toHaveLength(6);
  });

  it('maps events to compact lines, with paths relative to the project folder', () => {
    const commands = new Map<string, string>();
    const write = event('file_changed', {
      summary: 'Wrote retry.ts',
      detail: { tool: 'Write', toolUseId: 't1', input: { file_path: '/repo/hooks/webhook/retry.ts' } },
    });
    expect(eventLine(write, PROJECT, commands)?.text).toBe('· Write webhook/retry.ts');
    const edit = event('file_changed', {
      summary: 'Edited retry.test.ts',
      detail: { tool: 'Edit', input: { file_path: '/repo/hooks/test/retry.test.ts' } },
    });
    expect(eventLine(edit, PROJECT, commands)?.text).toBe('· Edit test/retry.test.ts');
    // The write's result carries no input and is not a second line.
    expect(eventLine(event('file_changed', { detail: { toolUseId: 't1', output: 'ok' } }), PROJECT, commands)).toBeNull();

    const run = event('test_started', { detail: { toolUseId: 't2', input: { command: 'pnpm exec vitest run retry\n' } } });
    expect(eventLine(run, PROJECT, commands)).toMatchObject({ text: '$ pnpm exec vitest run retry', tone: 'plain' });
    const passed = event('test_finished', { detail: { toolUseId: 't2', output: 'Tests  11 passed (11)' } });
    expect(eventLine(passed, PROJECT, commands)).toMatchObject({ text: '✓ 11 passed', tone: 'good' });
    const failed = event('test_finished', { detail: { failed: true, output: 'Tests  2 failed | 9 passed' } });
    expect(eventLine(failed, PROJECT, commands)).toMatchObject({ text: '✗ 2 failed', tone: 'bad' });

    eventLine(event('command_started', { detail: { toolUseId: 't3', input: { command: 'pnpm typecheck' } } }), PROJECT, commands);
    expect(eventLine(event('command_finished', { detail: { toolUseId: 't3', output: '' } }), PROJECT, commands)?.text).toBe('✓ no errors');
    eventLine(event('command_started', { detail: { toolUseId: 't4', input: { command: 'tsc --noEmit' } } }), PROJECT, commands);
    expect(
      eventLine(event('command_finished', { detail: { toolUseId: 't4', failed: true, output: 'Found 3 errors.' } }), PROJECT, commands)?.text,
    ).toBe('✗ 3 errors');
    expect(eventLine(event('command_finished', { detail: { toolUseId: 'x', output: 'fine' } }), PROJECT, commands)).toBeNull();

    expect(eventLine(event('tool_started', { summary: 'Read README.md' }), PROJECT)?.text).toBe('· Read README.md');
    expect(eventLine(event('tool_started', { summary: 'Used WebFetch' }), PROJECT)).toBeNull();
    expect(eventLine(event('agent_message', { summary: 'Adding the jitter case\nmore' }), PROJECT)).toMatchObject({
      text: 'Adding the jitter case',
      tone: 'prose',
    });
    expect(eventLine(event('agent_reasoning', { summary: 'hmm' }), PROJECT)).toBeNull();
  });

  it('merges exchanges into the asker log and replaces the relayed stop', () => {
    const events = [
      event('file_changed', { detail: { tool: 'Edit', input: { file_path: '/repo/hooks/a.ts' } }, at: '2026-10-01T09:00:01.000Z' }),
      event('session_waiting', { detail: { awaitingHuman: true, toolUseId: 'ask-1' }, at: '2026-10-01T09:00:02.000Z' }),
    ];
    const asked = exchange({
      id: 'x1',
      toolUseId: 'ask-1',
      askedAt: '2026-10-01T09:00:02.000Z',
      answeredAt: '2026-10-01T09:00:05.000Z',
      status: 'answered',
      captainAnswer: 'config/webhook.ts · retryCeilingMs',
    });
    const lines = paneLines({ sessionId: 'a', role: 'agent', events, exchanges: [asked], project: PROJECT, labels: new Map() });
    expect(lines.map((line) => line.text)).toEqual([
      '· Edit a.ts',
      '? asked the captain',
      '→ captain: config/webhook.ts · retryCeilingMs',
    ]);
    expect(lines[1]?.tone).toBe('ask');
  });

  it('shows a passed question as the captain passing it, and an unwired one as asked you', () => {
    const passed = exchange({ id: 'x2', status: 'passed', route: 'you', passedToYouReason: 'that is your call' });
    const unwired = exchange({ id: 'x3', captainSessionId: null, route: 'you', askedAt: '2026-10-01T09:01:00.000Z' });
    const lines = paneLines({ sessionId: 'a', role: 'agent', events: [], exchanges: [passed, unwired], project: PROJECT, labels: new Map() });
    expect(lines.map((line) => [line.text, line.tone])).toEqual([
      ['? asked the captain', 'ask'],
      ['→ captain: that is your call', 'quiet'],
      ['? asked you', 'attention'],
    ]);
  });

  it('gives the captain ← question and → answer lines, named by asker', () => {
    const answered = exchange({
      id: 'x4',
      status: 'answered',
      captainAnswer: 'test/support/clock.ts',
      answeredAt: '2026-10-01T09:00:03.000Z',
      askerSessionId: 'c',
    });
    const lines = paneLines({
      sessionId: 'cap',
      role: 'captain',
      events: [],
      exchanges: [answered],
      project: PROJECT,
      labels: new Map([['c', 'Attempt C']]),
    });
    expect(lines.map((line) => line.text)).toEqual([
      '← Attempt C: Where is the backoff ceiling?',
      '→ test/support/clock.ts',
    ]);
    expect(captainTally('cap', [answered], 2)).toBe('1 answered · 2 wired');
  });

  it('keeps only the newest lines', () => {
    const events = Array.from({ length: 30 }, () => event('agent_message', { summary: 'step' }));
    expect(paneLines({ sessionId: 'a', role: 'agent', events, exchanges: [], project: PROJECT, labels: new Map(), limit: 5 })).toHaveLength(5);
  });

  it('finds the question a session waits on, oldest first', () => {
    const later = exchange({ id: 'l', route: 'you', status: 'passed', askedAt: '2026-10-01T09:05:00.000Z' });
    const first = exchange({ id: 'f', route: 'you', status: 'pending', askedAt: '2026-10-01T09:01:00.000Z' });
    const done = exchange({ id: 'd', route: 'you', status: 'answered', askedAt: '2026-10-01T08:00:00.000Z' });
    expect(waitingExchange('a', [later, done, first])?.id).toBe('f');
    expect(waitingExchange('b', [later])).toBeNull();
  });

  it('merges live events by id in seq order and caps the buffer', () => {
    const a = event('agent_message');
    const b = event('agent_message');
    const c = event('agent_message');
    expect(mergeEvents([b], [a, c, b]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(mergeEvents([a, b], [c], 2).map((e) => e.id)).toEqual([b.id, c.id]);
  });
});

describe('compare', () => {
  const members = fleetMembers(LAYOUT, SESSIONS);
  const statuses: Record<string, FleetStatus> = { a: 'running', b: 'running', c: 'done', d: 'done', stray: 'needs-you' };

  it('brackets only clusters, and lists every other agent as a separate task, needs-you first', () => {
    const groups = compareGroups(LAYOUT, members, statuses);
    expect(groups.parallel).toHaveLength(1);
    expect(groups.parallel[0]).toMatchObject({ clusterId: 'k1', brief: 'Split the retry policy out.' });
    expect(groups.parallel[0]!.members.map((m) => m.sessionId)).toEqual(['a', 'b', 'c']);
    expect(groups.separate.map((m) => m.sessionId ?? m.nodeId)).toEqual(['stray', 'd', 'n-p']);
    expect(groups.separate.some((m) => m.role === 'captain')).toBe(false);
  });

  it('reads wiring from the canvas', () => {
    const [a, b] = compareGroups(LAYOUT, members, statuses).parallel[0]!.members;
    expect(isWired(LAYOUT, a!)).toBe(true);
    expect(isWired(LAYOUT, b!)).toBe(false);
  });

  it('builds an own-folder column with deltas', () => {
    const column = attemptColumn(
      summary({
        sessionId: 'a',
        tests: { passed: 34, failed: 0, skipped: null, ok: true },
        typecheck: 'clean',
        publicApi: 'unchanged',
        diff: { files: 3, added: 124, removed: 38 },
        turns: 14,
        elapsedMs: 362_000,
        askedCaptain: 4,
      }),
      true,
    );
    expect(column).toMatchObject({
      badge: { text: 'Tests green', tone: 'good' },
      files: '3 files',
      added: 124,
      removed: 38,
      shared: false,
      tests: { text: '34 passed', tone: 'good' },
      typecheck: { text: 'clean', tone: 'good' },
      publicApi: { text: 'unchanged', tone: 'ink' },
      turns: { text: '14 · 6m 02s' },
      asked: { text: '4 · you 0', tone: 'ask' },
    });
  });

  it('says off when not wired, and flags skipped, failing and API changes', () => {
    const column = attemptColumn(
      summary({
        sessionId: 'b',
        tests: { passed: 41, failed: null, skipped: 1, ok: true },
        typecheck: { errors: 2 },
        publicApi: { basis: 'exported-declarations', added: 2, removed: 0, changed: 0, names: ['x', 'y'] },
        askedYou: 2,
      }),
      false,
    );
    expect(column.badge).toEqual({ text: '1 skipped', tone: 'warn' });
    expect(column.tests).toEqual({ text: '41 passed · 1 skipped', tone: 'warn' });
    expect(column.typecheck).toEqual({ text: '2 errors', tone: 'bad' });
    expect(column.publicApi).toEqual({ text: '2 exports added', tone: 'warn' });
    expect(column.asked).toEqual({ text: 'off · you 2', tone: 'quiet' });

    const failing = attemptColumn(
      summary({
        sessionId: 'c',
        tests: { passed: 31, failed: 3, skipped: null, ok: false },
        publicApi: { basis: 'exported-declarations', added: 0, removed: 0, changed: 1, names: ['handle'] },
      }),
      true,
    );
    expect(failing.badge).toEqual({ text: '3 failing', tone: 'bad' });
    expect(failing.publicApi).toEqual({ text: '1 changed', tone: 'bad' });
  });

  it('shows touched files and no line counts in a shared folder', () => {
    const column = attemptColumn(
      summary({ sessionId: 'a', diffAttribution: 'shared-folder', touchedFiles: ['/repo/hooks/a.ts', '/repo/hooks/b.ts'] }),
      true,
    );
    expect(column).toMatchObject({ shared: true, files: '2 files', added: null, removed: null });
    expect(column.publicApi).toEqual({ text: 'shared folder', tone: 'quiet' });
  });

  it('says what a separate task is doing without repeating its status word', () => {
    const [stray, docs, placeholder] = compareGroups(LAYOUT, members, statuses).separate;
    expect(separateLine(stray!, 'needs-you', null)).toBe('waiting on your answer');
    expect(separateLine(docs!, 'done', summary({ sessionId: 'd', diff: { files: 1, added: 6, removed: 0 } }))).toBe('1 file');
    expect(separateLine(placeholder!, undefined, null)).toBe('not started');
  });

  it('records one keep per group, and choosing again undoes it', () => {
    let choices = chooseAttempt({}, ['a', 'b', 'c'], 'a', 'kept');
    choices = chooseAttempt(choices, ['a', 'b', 'c'], 'c', 'discarded');
    choices = chooseAttempt(choices, ['a', 'b', 'c'], 'b', 'kept');
    expect(choices).toEqual({ b: 'kept', c: 'discarded' });
    expect(chooseAttempt(choices, ['a', 'b', 'c'], 'b', 'kept')).toEqual({ c: 'discarded' });
  });
});

describe('questions', () => {
  const now = Date.parse('2026-10-01T09:10:00.000Z');
  const pending = exchange({ id: 'p', route: 'you', status: 'pending', captainSessionId: null, askedAt: '2026-10-01T09:08:00.000Z' });
  const passed = exchange({
    id: 'pp',
    route: 'you',
    status: 'passed',
    passedToYouReason: 'Nothing in the project says — your call.',
    askedAt: '2026-10-01T09:02:00.000Z',
  });
  const yours = exchange({ id: 'y', route: 'you', status: 'answered', userAnswer: 'Keep it.' });
  const older = exchange({
    id: 'o',
    status: 'answered',
    captainAnswer: 'Named exports only.',
    askedAt: '2026-10-01T08:58:00.000Z',
    answeredAt: '2026-10-01T08:58:02.000Z',
  });
  const newer = exchange({
    id: 'n',
    status: 'answered',
    captainAnswer: 'config/webhook.ts',
    askedAt: '2026-10-01T09:09:17.000Z',
    answeredAt: '2026-10-01T09:09:20.000Z',
  });
  const working = exchange({ id: 'w', status: 'pending' });
  const all = [pending, passed, yours, older, newer, working];

  it('passes to you what is routed to you and unanswered, longest waiting first', () => {
    expect(passedToYou(all).map((x) => x.id)).toEqual(['pp', 'p']);
  });

  it('lists the captain answers newest first', () => {
    const answered = answeredByCaptain(all);
    expect(answered.map((x) => x.id)).toEqual(['n', 'o']);
    expect(answeredLine(newer, now)).toBe('40s ago · 3s');
    expect(answeredHeader(answered, now)).toBe('2 · last 40s ago');
    expect(answeredHeader([], now)).toBe('0');
  });

  it('says what the captain said only when it passed', () => {
    expect(captainSaid(passed)).toBe('Nothing in the project says — your call.');
    expect(captainSaid({ ...passed, captainAnswer: 'Depends on external callers.' })).toBe('Depends on external callers.');
    expect(captainSaid(pending)).toBeNull();
    expect(waitingFor(pending, now)).toBe('waiting 2m');
  });

  it('lists canvas agents and whether each may ask a captain', () => {
    const roster = askRoster(LAYOUT, fleetMembers(LAYOUT, SESSIONS));
    expect(roster.map((row) => [row.label, row.wired])).toEqual([
      ['Attempt A', true],
      ['Attempt B', false],
      ['Attempt C', true],
      ['Docs sweep', false],
      ['Audit log index', false],
    ]);
  });
});

describe('fleet views render', () => {
  afterEach(() => vi.unstubAllGlobals());

  const props: FleetViewProps = {
    project: PROJECT,
    sessions: SESSIONS,
    layout: LAYOUT,
    statuses: { a: 'running', b: 'running', c: 'done', d: 'done', stray: 'needs-you' },
    onOpenSession: () => undefined,
  };

  it('renders panes with captains first and the keyboard hint', () => {
    const html = renderToStaticMarkup(createElement(FleetPanes, props));
    expect(html.indexOf('fv-pane fv-tone-ask')).toBeLessThan(html.indexOf('Attempt A'));
    expect(html).toContain('Follow the newest');
    expect(html).toContain('⌃1…6 focus a pane');
    expect(html.match(/<article/g)).toHaveLength(6);
  });

  it('renders one bracket for the cluster and separate tasks unbracketed', () => {
    const html = renderToStaticMarkup(createElement(FleetCompare, props));
    expect(html.match(/class="fv-bracket"/g)).toHaveLength(1);
    expect(html).toContain('Parallel · 3');
    expect(html).toContain('nothing to compare');
    const separate = html.slice(html.indexOf('fv-separate'));
    expect(separate).toContain('Docs sweep');
    expect(separate).not.toContain('Attempt A');
  });

  it('renders the roster and the two counts', () => {
    const html = renderToStaticMarkup(createElement(FleetQuestions, props));
    expect(html).toContain('Who may ask the captain');
    expect(html).toContain('to you');
    expect(html).toContain('captain answered');
    expect(html.match(/fv-switch on/g)).toHaveLength(2);
  });
});

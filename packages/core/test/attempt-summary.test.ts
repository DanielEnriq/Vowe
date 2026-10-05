import { describe, expect, it } from 'vitest';

import {
  attemptSummaryOf,
  isTypecheckCommand,
  publicApiDelta,
  typecheckErrors,
} from '../src/fleet/attempt.js';
import { attemptSummaries } from '../src/fleet/attempt-service.js';
import type { CaptainExchange } from '../src/fleet/types.js';
import type { NormalizedEvent } from '../src/types/events.js';
import type { AgentSession } from '../src/types/session.js';
import { testSession } from './helpers.js';

const A = 'claude-code:a';

let seq = 0;
function event(
  kind: NormalizedEvent['kind'],
  detail: Record<string, unknown>,
  at: string,
  line = ++seq,
  sessionId = A,
): NormalizedEvent {
  return {
    id: `e${++seq}`,
    sessionId,
    seq,
    at,
    kind,
    summary: kind,
    detail,
    raw: {},
    rawRef: { source: 'a.jsonl', byteOffset: line, line },
  };
}

/** One attempt as the Claude Code normalizer would report it. */
function attemptEvents(): NormalizedEvent[] {
  seq = 0;
  return [
    event('session_started', { text: 'Split retry' }, '2026-10-01T10:00:00.000Z'),
    event('agent_message', { text: 'Reading the handler.' }, '2026-10-01T10:00:10.000Z', 100),
    event('tool_started', { tool: 'Read', toolUseId: 't1', input: {} }, '2026-10-01T10:00:10.000Z', 100),
    event('file_changed', { tool: 'Write', toolUseId: 't2', input: { file_path: '/r/webhook/retry.ts' } }, '2026-10-01T10:01:00.000Z'),
    event('file_changed', { tool: 'Write', toolUseId: 't2', failed: false, output: 'ok' }, '2026-10-01T10:01:01.000Z'),
    event('file_changed', { tool: 'Edit', toolUseId: 't3', input: { file_path: '/r/webhook/handler.ts' } }, '2026-10-01T10:02:00.000Z'),
    event('command_started', { tool: 'Bash', toolUseId: 't4', input: { command: 'pnpm typecheck' } }, '2026-10-01T10:03:00.000Z'),
    event('command_finished', { tool: 'Bash', toolUseId: 't4', failed: true, output: 'src/a.ts(1,1): error TS2322: no\nsrc/b.ts(2,2): error TS2345: no' }, '2026-10-01T10:03:20.000Z'),
    event('command_started', { tool: 'Bash', toolUseId: 't5', input: { command: 'cd packages/core && npx tsc --noEmit' } }, '2026-10-01T10:04:00.000Z'),
    event('command_finished', { tool: 'Bash', toolUseId: 't5', failed: false, output: '' }, '2026-10-01T10:04:10.000Z'),
    event('test_started', { tool: 'Bash', toolUseId: 't6', input: { command: 'pnpm exec vitest run retry' } }, '2026-10-01T10:05:00.000Z'),
    event('test_finished', { tool: 'Bash', toolUseId: 't6', failed: false, output: ' Test Files  1 passed (1)\n      Tests  11 passed | 1 skipped (12)' }, '2026-10-01T10:06:02.000Z'),
  ];
}

function exchange(overrides: Partial<CaptainExchange>): CaptainExchange {
  return {
    id: 'x',
    projectId: 'git:p',
    askerSessionId: A,
    questionId: 'q',
    captainSessionId: 'claude-code:captain',
    question: 'Q?',
    captainAnswer: 'A',
    route: 'captain',
    userAnswer: null,
    status: 'answered',
    delivery: 'in-place',
    askedAt: '2026-10-01T10:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

describe('typecheck classification', () => {
  it.each([
    ['tsc --noEmit', true],
    ['pnpm typecheck', true],
    ['pnpm -r run typecheck', true],
    ['pnpm --filter @vowe/core run typecheck', true],
    ['npm run type-check', true],
    ['yarn tsc -p .', true],
    ['npx vue-tsc --noEmit', true],
    ['cd app && mypy src', true],
    ['pnpm test', false],
    ['cat tsconfig.json', false],
    ["cat > notes.md <<'EOF'\nrun tsc later\nEOF", false],
  ])('%s → %s', (command, expected) => {
    expect(isTypecheckCommand(command)).toBe(expected);
  });

  it('counts errors from tsc output', () => {
    expect(typecheckErrors('Found 3 errors in 2 files.')).toBe(3);
    expect(typecheckErrors('a.ts(1,1): error TS2322: x\nb.ts(1,1): error TS1005: y')).toBe(2);
    expect(typecheckErrors('')).toBeNull();
  });
});

describe('attemptSummaryOf', () => {
  it('summarises one attempt from its own events and exchanges', () => {
    const summary = attemptSummaryOf({
      sessionId: A,
      events: attemptEvents(),
      exchanges: [
        exchange({ id: '1' }),
        exchange({ id: '2', route: 'you', status: 'passed' }),
        exchange({ id: '3', route: 'you', status: 'pending', captainSessionId: null }),
        exchange({ id: '4', askerSessionId: 'claude-code:other' }),
      ],
      diff: { files: 3, added: 124, removed: 38 },
      publicApi: 'unchanged',
      diffAttribution: 'own-folder',
    });
    expect(summary).toEqual({
      sessionId: A,
      tests: { passed: 11, failed: null, skipped: 1, ok: true },
      // The later, clean check wins over the earlier failing one.
      typecheck: 'clean',
      publicApi: 'unchanged',
      diff: { files: 3, added: 124, removed: 38 },
      diffAttribution: 'own-folder',
      touchedFiles: ['/r/webhook/retry.ts', '/r/webhook/handler.ts'],
      turns: 6,
      elapsedMs: 6 * 60_000 + 2_000,
      askedCaptain: 2,
      askedYou: 2,
    });
  });

  it('reports a failing typecheck with its error count', () => {
    const events = attemptEvents().slice(0, 8);
    expect(attemptSummaryOf({ sessionId: A, events, exchanges: [] }).typecheck).toEqual({ errors: 2 });
  });

  it('leaves the diff out when the folder is shared', () => {
    const summary = attemptSummaryOf({
      sessionId: A,
      events: attemptEvents(),
      exchanges: [],
      diff: { files: 9, added: 1, removed: 1 },
      publicApi: 'unchanged',
      diffAttribution: 'shared-folder',
    });
    expect(summary.diff).toBeNull();
    expect(summary.publicApi).toBeNull();
    expect(summary.touchedFiles).toHaveLength(2);
  });
});

describe('publicApiDelta', () => {
  it('reads added, removed and rewritten exports from a patch', () => {
    const patch = [
      '--- a/src/retry.ts',
      '+++ b/src/retry.ts',
      '-export function retry(send: Send): Promise<void> {',
      '+export function retry(policy: Policy, send: Send): Promise<void> {',
      '+export interface RetryPolicy {',
      '-export const CEILING = 30_000;',
      '-export type Moved = string;',
      '+export type Moved = string;',
      '+export { wrap as Retryable, type Options };',
      ' export const untouched = 1;',
    ].join('\n');
    expect(publicApiDelta(patch)).toEqual({
      basis: 'exported-declarations',
      added: 3,
      removed: 1,
      changed: 1,
      names: ['CEILING', 'Options', 'RetryPolicy', 'Retryable', 'retry'],
    });
    expect(publicApiDelta('+const local = 1;\n-function x() {}')).toBe('unchanged');
  });
});

describe('attemptSummaries', () => {
  const sessions: AgentSession[] = [
    testSession({ id: A, cwd: '/repo/shared', projectId: 'git:p' }),
    testSession({ id: 'claude-code:b', cwd: '/repo/shared', projectId: 'git:p' }),
    testSession({ id: 'claude-code:c', cwd: '/repo/own', projectId: 'git:p', status: 'idle' }),
  ];
  const deps = (gitCalls: string[]) => ({
    getSession: (id: string) => sessions.find((s) => s.id === id) ?? null,
    listSessions: () => sessions,
    getEvents: (id: string) => (id === A ? attemptEvents() : []),
    listCaptainExchanges: () => [exchange({ id: '1' })],
    git: async (cwd: string, args: string[]) => {
      gitCalls.push(`${cwd} ${args.join(' ')}`);
      if (args[0] === 'diff' && args[1] === '--numstat') return '10\t2\tsrc/a.ts\n-\t-\tlogo.png\n';
      if (args[0] === 'diff') return '+export const added = 1;\n';
      return 'src/new.ts\n';
    },
    readText: async () => 'export function fresh() {}\nconst x = 1;\n',
  });

  it('attributes the diff only to an attempt alone in its folder', async () => {
    const calls: string[] = [];
    const [a, b, c] = await attemptSummaries([A, 'claude-code:b', 'claude-code:c', 'claude-code:missing'], deps(calls));
    expect(a!.diffAttribution).toBe('shared-folder');
    expect(a!.diff).toBeNull();
    expect(b!.diffAttribution).toBe('shared-folder');
    expect(c!.diffAttribution).toBe('own-folder');
    expect(c!.diff).toEqual({ files: 3, added: 12, removed: 2 });
    expect(c!.publicApi).toEqual({ basis: 'exported-declarations', added: 2, removed: 0, changed: 0, names: ['added', 'fresh'] });
    expect(calls.every((call) => call.startsWith('/repo/own '))).toBe(true);
    expect(a!.askedCaptain).toBe(1);
  });

  it('treats another live session in the same folder as sharing it', async () => {
    const [a] = await attemptSummaries([A], deps([]));
    expect(a!.diffAttribution).toBe('shared-folder');
  });

  it('says unavailable when git fails', async () => {
    const failing = { ...deps([]), git: async () => { throw new Error('not a repository'); } };
    const [c] = await attemptSummaries(['claude-code:c'], failing);
    expect(c!.diffAttribution).toBe('unavailable');
    expect(c!.diff).toBeNull();
  });
});

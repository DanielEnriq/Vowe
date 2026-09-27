import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeConsultant, CONSULTATION_TOOLS, verifiedRefs } from '../src/consultant.js';

let base: string;
let root: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vowe-consult-')));
  root = path.join(base, 'repo');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'observer.ts'), 'export class Observer {}\n');
  await writeFile(path.join(root, 'src', 'service.ts'), 'export class Service {}\n');
  await writeFile(path.join(base, 'secret.txt'), 'outside\n');
  await symlink(path.join(base, 'secret.txt'), path.join(root, 'src', 'link.txt'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

type Call = { prompt: string; options: Options };

/** A stand-in for the Agent SDK's `query`: records the call, yields scripted messages. */
function fakeQuery(messages: (options: Options) => SDKMessage[] | Promise<never>, calls: Call[] = []) {
  return ((params: { prompt: string; options: Options }) => {
    calls.push({ prompt: params.prompt, options: params.options });
    return (async function* () {
      const scripted = await messages(params.options);
      for (const message of scripted) yield message;
    })();
  }) as never;
}

function toolUse(name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input }] },
    parent_tool_use_id: null,
    session_id: 's',
  } as unknown as SDKMessage;
}

function success(structured: unknown, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'prose answer',
    structured_output: structured,
    total_cost_usd: 0.04,
    num_turns: 3,
    session_id: 's',
    ...extra,
  } as unknown as SDKMessage;
}

const request = (overrides: Partial<Parameters<ClaudeCodeConsultant['consult']>[0]> = {}) => ({
  repoRoot: root,
  question: 'Is observer coverage durable across restart?',
  context: 'Deciding where Project Understanding sits.',
  signal: new AbortController().signal,
  ...overrides,
});

describe('ClaudeCodeConsultant', () => {
  it('runs the harness read-only, contained, isolated from settings and leaving no session', async () => {
    const calls: Call[] = [];
    const consultant = new ClaudeCodeConsultant({ query: fakeQuery(() => [success({ answer: 'a', confidence: 'confirmed', references: [] })], calls) });
    await consultant.consult(request());

    const { options, prompt } = calls[0]!;
    expect(options.cwd).toBe(root);
    expect(options.tools).toEqual([...CONSULTATION_TOOLS]);
    expect(options.tools).not.toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task']));
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toEqual({ autoMemoryEnabled: false });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options.persistSession).toBe(false);
    expect(options.maxTurns).toBeGreaterThan(0);
    expect(options.maxBudgetUsd).toBeGreaterThan(0);
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.outputFormat?.type).toBe('json_schema');
    expect(prompt).toContain('Is observer coverage durable across restart?');
    expect(prompt).toContain('Deciding where Project Understanding sits.');
  });

  it('turns structured output into a finding with verified, absolute refs', async () => {
    const consultant = new ClaudeCodeConsultant({
      query: fakeQuery(() => [
        toolUse('Grep', { pattern: 'coverage', path: '.' }),
        toolUse('Read', { file_path: path.join(root, 'src', 'service.ts') }),
        success({
          answer: 'Coverage lives in memory per session.',
          confidence: 'confirmed',
          references: [
            { path: 'src/observer.ts', line: 3 },
            { path: 'src/service.ts' },
            { path: '../secret.txt' },
            { path: path.join(base, 'secret.txt') },
            { path: 'src/link.txt' },
            { path: 'src/missing.ts' },
            { path: 'src/observer.ts', line: 9 },
          ],
        }),
      ]),
    });
    const activity: string[] = [];
    const finding = await consultant.consult(request({ onActivity: ({ label }) => activity.push(label) }));

    expect(finding).toMatchObject({
      status: 'answered',
      answer: 'Coverage lives in memory per session.',
      confidence: 'confirmed',
      provider: 'Claude Code',
      inspected: ['src/service.ts'],
      costUsd: 0.04,
    });
    // Opened first; outside, symlinked-out, missing and duplicate citations dropped.
    expect(finding.status === 'answered' && finding.refs).toEqual([
      { kind: 'repo', path: path.join(root, 'src', 'service.ts') },
      { kind: 'repo', path: path.join(root, 'src', 'observer.ts'), line: 3 },
    ]);
    expect(activity).toEqual(['Searching for “coverage”', 'Reading src/service.ts']);
  });

  it('falls back to the prose answer when no structured output arrives', async () => {
    const consultant = new ClaudeCodeConsultant({ query: fakeQuery(() => [success(undefined)]) });
    const finding = await consultant.consult(request());
    expect(finding).toMatchObject({ status: 'answered', answer: 'prose answer', confidence: 'partial', refs: [] });
  });

  it('reports limits and sign-in problems as findings, not exceptions', async () => {
    const limited = new ClaudeCodeConsultant({
      query: fakeQuery(() => [{ type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: [], session_id: 's' } as unknown as SDKMessage]),
    });
    expect(await limited.consult(request())).toMatchObject({ status: 'failed', reason: expect.stringMatching(/spending limit/) });

    const turns = new ClaudeCodeConsultant({
      query: fakeQuery(() => [{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], session_id: 's' } as unknown as SDKMessage]),
    });
    expect(await turns.consult(request())).toMatchObject({ status: 'failed', reason: expect.stringMatching(/ran out of steps/) });

    const signedOut = new ClaudeCodeConsultant({
      query: fakeQuery(() => [success(undefined, { is_error: true, result: 'Invalid API key · Please run /login', api_error_status: 401 })]),
    });
    expect(await signedOut.consult(request())).toMatchObject({ status: 'unavailable', reason: 'Invalid API key · Please run /login' });
  });

  it('is unavailable for a repository that is not there', async () => {
    const consultant = new ClaudeCodeConsultant({ query: fakeQuery(() => []) });
    expect(await consultant.consult(request({ repoRoot: path.join(base, 'nope') }))).toMatchObject({ status: 'unavailable' });
  });

  it('stops when the caller aborts, and aborts the harness', async () => {
    let harnessAbort: AbortController | undefined;
    const consultant = new ClaudeCodeConsultant({
      query: fakeQuery((options) => {
        harnessAbort = options.abortController;
        return new Promise<never>((_, reject) =>
          options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }),
    });
    const caller = new AbortController();
    const pending = consultant.consult(request({ signal: caller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    caller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(harnessAbort!.signal.aborted).toBe(true);
  });

  it('stops at its wall-clock ceiling', async () => {
    const consultant = new ClaudeCodeConsultant({
      timeoutMs: 10,
      query: fakeQuery((options) =>
        new Promise<never>((_, reject) =>
          options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      ),
    });
    expect(await consultant.consult(request())).toMatchObject({ status: 'failed', reason: expect.stringMatching(/longer than/) });
  });

  it('lets an unexpected fault propagate', async () => {
    const consultant = new ClaudeCodeConsultant({
      query: fakeQuery(() => Promise.reject(new Error('spawn exploded')) as Promise<never>),
    });
    await expect(consultant.consult(request())).rejects.toThrow('spawn exploded');
  });
});

describe('verifiedRefs', () => {
  it('keeps at most eight files, all inside the root', async () => {
    const references = Array.from({ length: 10 }, (_, index) => ({ path: `src/f${index}.ts` }));
    for (const reference of references) await writeFile(path.join(root, reference.path), '');
    const refs = await verifiedRefs(root, references, new Set());
    expect(refs).toHaveLength(8);
    expect(refs.every((ref) => ref.kind === 'repo' && ref.path.startsWith(`${root}/`))).toBe(true);
  });
});

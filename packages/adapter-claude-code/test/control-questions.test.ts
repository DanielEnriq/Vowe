import type { CanUseTool, Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WorkerOutcome, WorkerQuestionEvent } from '@vowe/core';
import { describe, expect, it } from 'vitest';

import { ControlChannel, questionsOf } from '../src/control.js';

/**
 * A stand-in for the SDK's `query()`: it reports a session id, then emits
 * whatever the test pushes. `canUseTool` is the real callback the channel
 * passed in, so the test plays the CLI's side of the permission protocol.
 */
function fakeQuery() {
  const pending: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let options: Options | undefined;
  const push = (message: Partial<SDKMessage>) => {
    pending.push({ session_id: 'sess-1', ...message } as SDKMessage);
    wake?.();
  };
  const end = () => {
    done = true;
    wake?.();
  };
  const query = ((args: { prompt: unknown; options?: Options }) => {
    options = args.options;
    push({ type: 'system' } as Partial<SDKMessage>);
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
    return Object.assign(iterator, { interrupt: async () => undefined, close: () => end() }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;

  const ask = (toolUseID: string, input: Record<string, unknown>, signal = new AbortController().signal) =>
    (options!.canUseTool as CanUseTool)('AskUserQuestion', input, {
      signal,
      toolUseID,
      requestId: `req-${toolUseID}`,
    });
  return { query, push, end, ask, options: () => options! };
}

const QUESTION = {
  questions: [
    {
      question: 'Keep the old header?',
      header: 'Header',
      multiSelect: false,
      options: [
        { label: 'Keep', description: 'one more release' },
        { label: 'Cut', description: 'now' },
      ],
    },
  ],
};

async function launched(readOnly = false) {
  const fake = fakeQuery();
  const channel = new ControlChannel({ query: fake.query });
  const questions: WorkerQuestionEvent[] = [];
  const outcomes: WorkerOutcome[] = [];
  channel.onQuestion((event) => questions.push(event));
  channel.onOutcome((outcome) => outcomes.push(outcome));
  const session = await channel.launch('/repo', 'Do the work', { readOnly });
  return { fake, channel, session, questions, outcomes };
}

describe('ControlChannel questions', () => {
  it('holds AskUserQuestion until answered, and answers it in place', async () => {
    const { fake, channel, questions } = await launched();
    expect(fake.options().permissionMode).toBe('auto');
    expect(fake.options().disallowedTools).toBeUndefined();

    let result: PermissionResult | null = null;
    void fake.ask('toolu_1', QUESTION).then((r) => (result = r));
    await Promise.resolve();
    expect(result).toBeNull();
    expect(questions).toEqual([
      {
        type: 'asked',
        question: {
          id: 'toolu_1',
          sessionId: 'claude-code:sess-1',
          toolUseId: 'toolu_1',
          question: 'Keep the old header?',
          options: ['Keep', 'Cut'],
          askedAt: expect.any(String),
        },
      },
    ]);

    expect(channel.answerQuestion('sess-1', 'toolu_1', 'Keep')).toBe(true);
    await Promise.resolve();
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { ...QUESTION, answers: { 'Keep the old header?': 'Keep' } },
    });
    expect(questions[1]).toMatchObject({ type: 'settled', settled: { id: 'toolu_1', answer: 'Keep', by: 'host' } });
    expect(channel.answerQuestion('sess-1', 'toolu_1', 'again')).toBe(false);
  });

  it('denies every other ask, as the CLI did with no callback', async () => {
    const { fake, questions } = await launched();
    const result = await (fake.options().canUseTool as CanUseTool)('Bash', { command: 'rm -rf /' }, {
      signal: new AbortController().signal,
      toolUseID: 't',
      requestId: 'r',
    });
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(questions).toEqual([]);
  });

  it('takes an instruction sent while a question is held as its answer', async () => {
    const { fake, channel } = await launched();
    const answered = fake.ask('toolu_2', QUESTION);
    await Promise.resolve();
    expect(channel.sendToManaged('sess-1', 'Cut it')).toBe('answered');
    expect(await answered).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Keep the old header?': 'Cut it' } } });
    expect(channel.sendToManaged('sess-1', 'next task')).toBe('queued');
  });

  it('settles an abandoned question as unanswered', async () => {
    const { fake, questions } = await launched();
    const abort = new AbortController();
    const result = fake.ask('toolu_3', QUESTION, abort.signal);
    abort.abort();
    expect(await result).toMatchObject({ behavior: 'deny' });
    expect(questions[1]).toMatchObject({ type: 'settled', settled: { answer: null, by: 'aborted' } });
  });

  it('reports turn outcomes from result messages and the end of the query', async () => {
    const { fake, channel, outcomes } = await launched();
    fake.push({ type: 'result', subtype: 'success', is_error: false, result: 'All done.' } as Partial<SDKMessage>);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(channel.outcomeOf('sess-1')).toMatchObject({ sessionId: 'claude-code:sess-1', state: 'completed', text: 'All done.' });

    channel.sendToManaged('sess-1', 'more');
    fake.push({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too long'] } as Partial<SDKMessage>);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(channel.outcomeOf('sess-1')).toMatchObject({ state: 'failed', error: 'error_max_turns: too long' });

    expect(outcomes.map((o) => o.state)).toEqual(['working', 'completed', 'working', 'failed']);
    fake.end();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A failed turn is not overwritten by a clean close.
    expect(channel.outcomeOf('sess-1')?.state).toBe('failed');
  });

  it('withholds writing tools from a read-only worker', async () => {
    const { fake } = await launched(true);
    expect(fake.options().disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  });

  it('reads question text verbatim, since answers are keyed by it', () => {
    expect(questionsOf({ questions: [{ question: ' Spaced? ', options: [{ label: 'A' }, {}] }, { nope: 1 }] })).toEqual([
      { question: ' Spaced? ', options: ['A'] },
    ]);
  });
});

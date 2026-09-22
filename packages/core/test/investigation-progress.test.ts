import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import {
  DelegatedQuestionRunner,
  type InvestigationProgress,
} from '../src/delegation/delegated-question-runner.js';
import type { DelegatedAnswer, ObservationLlm } from '../src/llm/observation-llm.js';
import { TEST_SESSION, temporaryStore, testSession } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function harness(
  run: (
    tools: Parameters<ObservationLlm['investigate']>[1],
    stream: Parameters<ObservationLlm['investigate']>[3],
  ) => Promise<DelegatedAnswer>,
) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());

  const seen: InvestigationProgress[] = [];
  const runner = new DelegatedQuestionRunner({
    store,
    navigator: new ContextNavigator({ store }),
    investigator: {
      async observeWindow() {
        return { summary: 'x' };
      },
      async investigate(_input, tools, _trace, stream) {
        return run(tools, stream);
      },
    },
    onProgress: (progress) => seen.push(progress),
  });

  return { runner, seen, store };
}

describe('Investigation progress — the work as it happens', () => {
  it('announces the start before any lookup', async () => {
    const { runner, seen } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));

    await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    expect(seen[0]?.phase).toBe('started');
  });

  /**
   * The point of the whole path: a developer sees each lookup as it happens
   * rather than everything at once when the answer lands.
   */
  it('reports each lookup in the order it actually happened', async () => {
    const { runner, seen } = await harness(async (tools) => {
      await tools.searchContext({ query: 'reconnect' });
      await tools.getDiff({});
      return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
    });

    await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });

    expect(seen.map((progress) => progress.phase)).toEqual([
      'started',
      'check',
      'check',
      'finished',
    ]);

    const checks = seen.filter(
      (progress): progress is Extract<InvestigationProgress, { phase: 'check' }> =>
        progress.phase === 'check',
    );
    expect(checks[0]!.check.kind).toBe('search');
    expect(checks[1]!.check.kind).toBe('diff');
  });

  /**
   * The live line and the persisted line are one object, so the trail cannot
   * show a step the receipt then disagrees with.
   */
  it('emits exactly the checks that end up in the receipt', async () => {
    const { runner, seen } = await harness(async (tools) => {
      await tools.searchContext({ query: 'reconnect' });
      await tools.getDiff({});
      return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
    });

    const result = await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });

    const live = seen
      .filter((progress) => progress.phase === 'check')
      .map((progress) => (progress as { check: { label: string } }).check.label);
    expect(live).toEqual(result.entry.investigation?.checks.map((check) => check.label));
  });

  it('finishes by naming the answer it produced', async () => {
    const { runner, seen } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));

    const result = await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    const last = seen.at(-1);

    expect(last).toMatchObject({ phase: 'finished', entryId: result.entry.id, failed: false });
  });

  it('still finishes when the investigation falls over', async () => {
    const { runner, seen } = await harness(async () => {
      throw new Error('model down');
    });

    await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    expect(seen.at(-1)).toMatchObject({ phase: 'finished', failed: true });
  });

  it('scopes every report, so one room cannot look busy for another', async () => {
    const { runner, seen } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));

    await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    for (const progress of seen) {
      expect(progress.scope).toEqual({ sessionId: TEST_SESSION });
    }
  });

  it('never lets a broken listener fail the answer', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const runner = new DelegatedQuestionRunner({
      store,
      navigator: new ContextNavigator({ store }),
      investigator: {
        async observeWindow() {
          return { summary: 'x' };
        },
        async investigate() {
          return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
        },
      },
      onProgress: () => {
        throw new Error('a view blew up');
      },
    });

    const result = await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    expect(result.failed).toBe(false);
  });

  /**
   * The point of the streaming path: language appears while it is being
   * written, on the same channel as the lookups, in the order it happened.
   */
  it('reports exposed reasoning and answer text as the model produces it', async () => {
    const { runner, seen } = await harness(async (tools, stream) => {
      stream?.reasoning?.('Checking the ');
      stream?.reasoning?.('reconnect path');
      await tools.getDiff({});
      stream?.answer?.('The reconnect ');
      stream?.answer?.('loop retries twice.');
      return {
        spokenAnswer: 'It retries twice.',
        fullAnswer: 'The reconnect loop retries twice.',
        refs: [],
      };
    });

    await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });

    expect(seen.map((progress) => progress.phase)).toEqual([
      'started',
      'reasoning',
      'reasoning',
      'check',
      'answer',
      'answer',
      'finished',
    ]);

    const streamed = seen
      .filter((progress) => progress.phase === 'answer')
      .map((progress) => (progress as { delta: string }).delta)
      .join('');
    // What was watched and what was persisted are the same text.
    expect(streamed).toBe('The reconnect loop retries twice.');
  });

  it('scopes streamed text too, so one room cannot speak for another', async () => {
    const { runner, seen } = await harness(async (_tools, stream) => {
      stream?.answer?.('hello');
      return { spokenAnswer: 'a', fullAnswer: 'hello', refs: [] };
    });

    await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    for (const progress of seen) {
      expect(progress.scope).toEqual({ sessionId: TEST_SESSION });
    }
  });

  it('never lets a broken listener fail an answer that is streaming', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const runner = new DelegatedQuestionRunner({
      store,
      navigator: new ContextNavigator({ store }),
      investigator: {
        async observeWindow() {
          return { summary: 'x' };
        },
        async investigate(_input, _tools, _trace, stream) {
          stream?.answer?.('half an ');
          stream?.answer?.('answer');
          return { spokenAnswer: 'a', fullAnswer: 'half an answer', refs: [] };
        },
      },
      onProgress: () => {
        throw new Error('a view blew up');
      },
    });

    const result = await runner.answer({ sessionId: TEST_SESSION, question: 'why?' });
    expect(result.entry.text).toBe('half an answer');
    expect(result.failed).toBe(false);
  });
});

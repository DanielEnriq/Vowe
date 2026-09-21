import { afterEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/companion/companion-service.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { VoweRunRecorder } from '../src/execution/run-recorder.js';
import type { ModelTrace } from '../src/llm/model-trace.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import {
  makeEvents,
  storeEvents,
  temporaryStore,
  testSession,
  TEST_SESSION,
} from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

type Investigate = (
  input: InvestigationInput,
  tools: ReadOnlyToolset,
  trace?: ModelTrace,
) => Promise<DelegatedAnswer>;

function investigator(investigate: Investigate): ObservationLlm {
  return {
    async observeWindow(): Promise<WindowObservation> {
      return { summary: 'not used here' };
    },
    investigate,
  };
}

async function asking(investigate: Investigate): Promise<{
  store: SqliteEventStore;
  companion: CompanionService;
  reopen: () => Promise<SqliteEventStore>;
}> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());
  await storeEvents(
    store,
    makeEvents([
      { kind: 'session_started', summary: 'Task: fix the reconnect test', atSeconds: 0 },
      { kind: 'test_finished', summary: 'Tests failed', atSeconds: 1 },
    ]),
  );

  const delegated = new DelegatedQuestionRunner({
    store,
    navigator: new ContextNavigator({ store }),
    investigator: investigator(investigate),
    runs: new VoweRunRecorder({ store }),
  });
  return {
    store,
    companion: new CompanionService({ store, delegated }),
    reopen: fixture.reopen,
  };
}

const answer = (fullAnswer: string): DelegatedAnswer => ({
  spokenAnswer: 'Both paths hit the same function.',
  fullAnswer,
  refs: [],
});

describe('what Vowe did, beside what Vowe said', () => {
  it('keeps the reasoning a provider exposed, labelled as the summary it is', async () => {
    const { store, companion } = await asking(async (_input, _tools, trace) => {
      trace?.input({ model: 'test-model', messages: ['why?'] });
      trace?.reasoning({ text: 'Looked at both insertion paths.', summary: true });
      return answer('Both paths enter the same insertion function.');
    });

    const result = await companion.ask(TEST_SESSION, 'Why is it failing?');
    const run = store.getRunForEntry(result.entry.id)!;
    const reasoning = store
      .getTraceItems(run.id)
      .filter((item) => item.kind === 'reasoning_summary');

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toBe('Looked at both insertion paths.');
    // And not as raw reasoning, which is not what this provider returned.
    expect(
      store.getTraceItems(run.id).filter((item) => item.kind === 'reasoning'),
    ).toEqual([]);
  });

  it('keeps raw reasoning as raw when that is what came back', async () => {
    const { store, companion } = await asking(async (_input, _tools, trace) => {
      trace?.reasoning({ text: 'The whole of my thinking.', summary: false });
      return answer('An answer.');
    });

    const result = await companion.ask(TEST_SESSION, 'Why?');
    const run = store.getRunForEntry(result.entry.id)!;
    expect(
      store.getTraceItems(run.id).filter((item) => item.kind === 'reasoning'),
    ).toHaveLength(1);
  });

  it('invents none when a provider exposes none', async () => {
    const { store, companion } = await asking(async () =>
      answer('An answer, with nothing said about how it was reached.'),
    );

    const result = await companion.ask(TEST_SESSION, 'Why?');
    const run = store.getRunForEntry(result.entry.id)!;
    expect(
      store.getTraceItems(run.id).filter((item) => item.kind.startsWith('reasoning')),
    ).toEqual([]);
  });

  it('holds the execution in the order it happened', async () => {
    const { store, companion } = await asking(async (_input, tools, trace) => {
      trace?.input({ model: 'test-model' });
      trace?.reasoning({ text: 'Where does the replay path start?', summary: true });
      await tools.searchContext({ query: 'reconnect', limit: 2 });
      trace?.output({
        text: 'Both paths enter the same insertion function.',
        usage: { inputTokens: 120, outputTokens: 30 },
      });
      return answer('Both paths enter the same insertion function.');
    });

    const result = await companion.ask(TEST_SESSION, 'Why?');
    const run = store.getRunForEntry(result.entry.id)!;
    expect(store.getTraceItems(run.id).map((item) => item.kind)).toEqual([
      'model_input',
      'reasoning_summary',
      'tool_call',
      'tool_result',
      'model_output',
    ]);
    expect(run.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(run.status).toBe('completed');
  });

  it('keeps everything that happened before a failure, and says it failed', async () => {
    const { store, companion } = await asking(async (_input, tools, trace) => {
      trace?.reasoning({ text: 'Starting with the diff.', summary: true });
      await tools.searchContext({ query: 'reconnect', limit: 1 });
      throw new Error('the model went away');
    });

    const result = await companion.ask(TEST_SESSION, 'Why?');
    // The developer still gets an answer saying the investigation failed.
    expect(result.failed).toBe(true);

    const run = store.getRunForEntry(result.entry.id)!;
    expect(run.status).toBe('error');
    const kinds = store.getTraceItems(run.id).map((item) => item.kind);
    expect(kinds).toEqual([
      'reasoning_summary',
      'tool_call',
      'tool_result',
      'error',
    ]);
  });

  it('records a tool that threw as a tool that threw', async () => {
    const { store, companion } = await asking(async (_input, tools) => {
      await tools.openContext({ ref: 'not-a-ref' }).catch(() => undefined);
      return answer('An answer.');
    });

    const result = await companion.ask(TEST_SESSION, 'Why?');
    const run = store.getRunForEntry(result.entry.id)!;
    const [call, outcome] = store.getTraceItems(run.id);
    expect(call!.kind).toBe('tool_call');
    expect(outcome!.kind).toBe('tool_result');
  });

  it('is all still there after a restart', async () => {
    const { store, companion, reopen } = await asking(
      async (_input, _tools, trace) => {
        trace?.input({ model: 'test-model' });
        trace?.reasoning({ text: 'A summary of the thinking.', summary: true });
        trace?.output({ text: 'An answer.' });
        return answer('An answer.');
      },
    );

    const result = await companion.ask(TEST_SESSION, 'Why?');
    const runId = store.getRunForEntry(result.entry.id)!.id;

    const restarted = await reopen();
    const run = restarted.getRun(runId)!;
    expect(run.status).toBe('completed');
    expect(run.outputEntryId).toBe(result.entry.id);
    expect(restarted.getTraceItems(runId).map((item) => item.kind)).toEqual([
      'model_input',
      'reasoning_summary',
      'model_output',
    ]);
  });
});

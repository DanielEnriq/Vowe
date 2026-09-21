import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/companion/companion-service.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { formatRef } from '../src/context/refs.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { ConversationEntry } from '../src/types/conversation.js';
import {
  steadyEvents,
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

function investigator(
  run: (input: InvestigationInput, tools: ReadOnlyToolset) => Promise<DelegatedAnswer>,
): ObservationLlm {
  return {
    async observeWindow(): Promise<WindowObservation> {
      return { summary: 'not used here' };
    },
    investigate: run,
  };
}

async function harness(observer: ObservationLlm): Promise<{
  companion: CompanionService;
  store: Awaited<ReturnType<typeof temporaryStore>>['store'];
  reopen: Awaited<ReturnType<typeof temporaryStore>>['reopen'];
}> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());
  await storeEvents(store, steadyEvents(12));

  const delegated = new DelegatedQuestionRunner({
    store,
    navigator: new ContextNavigator({ store }),
    investigator: observer,
  });
  return {
    companion: new CompanionService({ store, delegated }),
    store,
    reopen: fixture.reopen,
  };
}

function answerOf(entries: ConversationEntry[]): ConversationEntry {
  const answer = entries.find((entry) => entry.role === 'companion_answer');
  if (!answer) throw new Error('no answer was persisted');
  return answer;
}

describe('InvestigationReceipt — what Vowe actually checked', () => {
  it('records each lookup in the order it happened, with its own refs', async () => {
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        const hits = await tools.searchContext({ query: 'step', limit: 3 });
        const opened = await tools.openContext({ ref: hits[0]!.refId });
        await tools.getDiff({});
        return {
          spokenAnswer: 'Step three.',
          fullAnswer: 'The worker is on step three.',
          refs: [opened.ref],
        };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'What is it doing?');
    const receipt = result.entry.investigation;

    expect(receipt).toBeDefined();
    expect(receipt!.checks.map((check) => check.kind)).toEqual(['search', 'open', 'diff']);
    expect(receipt!.checks.map((check) => check.label)).toEqual([
      'Searched session context',
      'Reviewed worker activity',
      'Inspected the current diff',
    ]);
    // The search's hits belong to the search; the diff's ref to the diff.
    expect(receipt!.checks[0]!.refs.length).toBeGreaterThan(1);
    expect(receipt!.checks[1]!.refs).toHaveLength(1);
    expect(receipt!.checks[2]!.refs).toEqual([
      { kind: 'diff', sessionId: TEST_SESSION },
    ]);
    expect(typeof receipt!.durationMs).toBe('number');
    expect(receipt!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('names the repository, the file and the diff in words a person would use', async () => {
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        await tools.searchContext({ query: 'absorb', sources: ['repo'] });
        await tools.openContext({ ref: 'repo:/tmp/vowe-missing/registry.ts#12' });
        await tools.getDiff({ path: 'src/live.ts' });
        return { spokenAnswer: 'a', fullAnswer: 'b', refs: [] };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'Where is absorb?');
    const labels = result.entry.investigation!.checks.map((check) => check.label);

    expect(labels).toEqual([
      'Searched the repository',
      'Read registry.ts:12',
      'Inspected the diff for src/live.ts',
    ]);
    // No implementation syntax leaks into something a person reads.
    for (const label of labels) {
      expect(label).not.toMatch(/[_(]/);
      expect(label).not.toContain('tool');
    }
  });

  it('records a lookup that found nothing, because looking is what happened', async () => {
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        await tools.searchContext({ query: 'nothingmatchesthis' });
        await tools.openContext({ ref: `window:${TEST_SESSION}:w-gone` });
        return { spokenAnswer: 'a', fullAnswer: 'b', refs: [] };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'Is there anything?');
    const checks = result.entry.investigation!.checks;

    expect(checks.map((check) => check.label)).toEqual([
      'Searched session context',
      'Checked recent observed work',
    ]);
    expect(checks[0]!.refs).toEqual([]);
    expect(checks[1]!.refs).toEqual([]);
  });

  it('keeps the checks that ran when the investigation then falls over', async () => {
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        await tools.searchContext({ query: 'step', limit: 2 });
        await tools.getDiff({});
        throw new Error('the model is unreachable');
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'Why is it stuck?');

    expect(result.failed).toBe(true);
    const receipt = result.entry.investigation;
    expect(receipt!.checks.map((check) => check.kind)).toEqual(['search', 'diff']);
    expect(receipt!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('carries no receipt at all when nothing was looked at', async () => {
    const { companion } = await harness(
      investigator(async () => ({
        spokenAnswer: 'No model is configured.',
        fullAnswer: 'No model is configured, so I could not investigate.',
        refs: [],
      })),
    );

    const result = await companion.ask(TEST_SESSION, 'What is it doing?');

    // Not an empty receipt: there is nothing to show, and `Checked 0 things`
    // would be a sentence about nothing.
    expect(result.entry.investigation).toBeUndefined();
  });

  it('collapses an immediately repeated identical lookup and nothing more', async () => {
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        await tools.getDiff({});
        await tools.getDiff({});
        await tools.searchContext({ query: 'step', limit: 2 });
        await tools.getDiff({});
        return { spokenAnswer: 'a', fullAnswer: 'b', refs: [] };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'What changed?');

    expect(result.entry.investigation!.checks.map((check) => check.kind)).toEqual([
      'diff',
      'search',
      'diff',
    ]);
  });

  it('keeps the answer’s grounding refs exactly as they were', async () => {
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        const hits = await tools.searchContext({ query: 'step', limit: 3 });
        return {
          spokenAnswer: 'a',
          fullAnswer: 'b',
          refs: [{ kind: 'repo' as const, path: 'src/registry.ts', line: 12 }],
        };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'What is it doing?');
    const refs = result.entry.refs!.map(formatRef);

    expect(refs).toContain('repo:src/registry.ts#12');
    // Everything the receipt names is still in the entry's own grounding.
    for (const check of result.entry.investigation!.checks) {
      for (const ref of check.refs) expect(refs).toContain(formatRef(ref));
    }
  });

  it('captures no model prose — only what was retrieved', async () => {
    const prose = 'I suspect the backoff is doubling, so I will check the diff.';
    const { companion } = await harness(
      investigator(async (_input, tools) => {
        await tools.getDiff({});
        return { spokenAnswer: prose, fullAnswer: prose, refs: [] };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'Why is it slow?');

    expect(JSON.stringify(result.entry.investigation)).not.toContain('suspect');
    expect(JSON.stringify(result.entry.investigation)).not.toContain(prose);
  });

  it('survives a restart, and an entry written without one still loads', async () => {
    const { companion, store, reopen } = await harness(
      investigator(async (_input, tools) => {
        await tools.searchContext({ query: 'step', limit: 2 });
        return { spokenAnswer: 'a', fullAnswer: 'b', refs: [] };
      }),
    );

    await companion.ask(TEST_SESSION, 'What is it doing?');
    // An answer from before receipts existed.
    await store.appendConversationEntry({
      id: randomUUID(),
      sessionId: TEST_SESSION,
      at: '2026-01-01T00:00:00.000Z',
      role: 'companion_answer',
      text: 'An older answer, with no receipt.',
      refs: [],
    });

    const restarted = await reopen();
    const entries = restarted.getConversation(TEST_SESSION);

    expect(answerOf(entries).investigation!.checks).toHaveLength(1);
    expect(answerOf(entries).investigation!.checks[0]!.label).toBe(
      'Searched session context',
    );
    const older = entries.find((entry) => entry.text.startsWith('An older answer'))!;
    expect(older.investigation).toBeUndefined();
    expect(older.role).toBe('companion_answer');
  });

  it('attaches nothing to the question, only to the answer', async () => {
    const { companion, store } = await harness(
      investigator(async (_input, tools) => {
        await tools.getDiff({});
        return { spokenAnswer: 'a', fullAnswer: 'b', refs: [] };
      }),
    );

    await companion.ask(TEST_SESSION, 'What changed?');
    const question = store
      .getConversation(TEST_SESSION)
      .find((entry) => entry.role === 'user_question')!;

    expect(question.investigation).toBeUndefined();
  });
});

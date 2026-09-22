import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { formatRef, parseRef } from '../src/context/refs.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
} from '../src/llm/observation-llm.js';
import type { WindowNote } from '../src/observation/trace-window.js';
import { TEST_SESSION, temporaryStore, testSession } from './helpers.js';

const PROJECT = 'git:abc123';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function note(sessionId: string, index: number, summary: string): WindowNote {
  return {
    id: `n-${sessionId}-${index}`,
    sessionId,
    windowId: `w-${index}`,
    windowIndex: index,
    summary,
    refs: [],
    investigated: false,
    createdAt: `2026-09-22T09:0${index}:00.000Z`,
  };
}

async function harness(
  run: (input: InvestigationInput, tools: ReadOnlyToolset) => Promise<DelegatedAnswer>,
) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;

  await store.upsertProject({
    id: PROJECT,
    name: 'Vowe',
    repoRoot: '/repo/vowe',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  await store.upsertSession(
    testSession({ projectId: PROJECT, displayLabel: 'Unified Ask', branch: 'main' }),
  );
  await store.upsertSession(
    testSession({
      id: 'claude-code:second',
      providerSessionId: 'second',
      projectId: PROJECT,
      displayLabel: 'Voice integration',
      lastActivityAt: '2026-02-11T10:00:00.000Z',
    }),
  );

  const investigator: ObservationLlm = {
    async observeWindow() {
      return { summary: 'not used here' };
    },
    investigate: run,
  };

  const runner = new DelegatedQuestionRunner({
    store,
    navigator: new ContextNavigator({ store }),
    investigator,
  });
  return { runner, store };
}

describe('Project Ask — a durable thread of its own', () => {
  it('persists the question and the answer in the project conversation', async () => {
    const { runner, store } = await harness(async () => ({
      spokenAnswer: 'Two sessions are running.',
      fullAnswer: 'Unified Ask and Voice integration are both running.',
      refs: [],
    }));

    const result = await runner.answerProject({
      projectId: PROJECT,
      question: 'What are the agents doing?',
    });

    const thread = store.getProjectConversation(PROJECT);
    expect(thread.map((entry) => entry.role)).toEqual(['user_question', 'companion_answer']);
    expect(thread[0]!.text).toBe('What are the agents doing?');
    expect(thread[1]!.id).toBe(result.entry.id);
    expect(result.failed).toBe(false);
  });

  /** Session and project threads are separate; neither leaks into the other. */
  it('leaves every session conversation untouched', async () => {
    const { runner, store } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));

    await runner.answerProject({ projectId: PROJECT, question: 'How does this repo work?' });

    expect(store.getConversation(TEST_SESSION)).toEqual([]);
    expect(store.getConversation('claude-code:second')).toEqual([]);
    expect(store.getProjectConversation(PROJECT)).toHaveLength(2);
  });

  it('hands the model the repository and a roster, not a trace', async () => {
    let seen: InvestigationInput | null = null;
    const { runner } = await harness(async (input) => {
      seen = input;
      return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
    });

    await runner.answerProject({ projectId: PROJECT, question: 'What is happening?' });

    expect(seen).not.toBeNull();
    const input = seen! as Extract<InvestigationInput, { projectId: string }>;
    expect(input.projectId).toBe(PROJECT);
    expect(input.projectName).toBe('Vowe');
    expect(input.repoRoot).toBe('/repo/vowe');
    expect(input.sessions.map((session) => session.label)).toEqual([
      'Voice integration',
      'Unified Ask',
    ]);
    expect(input.sessions[1]!.branch).toBe('main');
  });

  it('records the investigation against the project, not a session', async () => {
    const { runner, store } = await harness(async (_input, tools) => {
      await tools.searchContext({ query: 'reconnect' });
      return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
    });

    const result = await runner.answerProject({ projectId: PROJECT, question: 'why?' });
    expect(result.entry.investigation?.checks.length).toBeGreaterThan(0);
    expect(store.getConversation(TEST_SESSION)).toEqual([]);
  });

  it('answers with a failure it can persist when the investigation falls over', async () => {
    const { runner, store } = await harness(async () => {
      throw new Error('model unavailable');
    });

    const result = await runner.answerProject({ projectId: PROJECT, question: 'why?' });
    expect(result.failed).toBe(true);
    expect(store.getProjectConversation(PROJECT)).toHaveLength(2);
  });
});

describe('Project Ask — what a project search may see', () => {
  it('reads interpretation across every session, and says which one it came from', async () => {
    const { store } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));
    await store.appendWindowNote(note(TEST_SESSION, 1, 'Rewriting the reconnect path.'));
    await store.appendWindowNote(note('claude-code:second', 2, 'Reconnect sideband work.'));

    const navigator = new ContextNavigator({ store });
    const hits = await navigator.searchContext({ projectId: PROJECT, query: 'reconnect' });

    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((hit) => hit.source === 'observations')).toBe(true);
    expect(hits.some((hit) => hit.label.startsWith('Unified Ask'))).toBe(true);
    expect(hits.some((hit) => hit.label.startsWith('Voice integration'))).toBe(true);
  });

  /**
   * The citation is the descent path: a project answer names a window, and the
   * window ref carries the session it belongs to.
   */
  it('cites refs that lead back into the session they came from', async () => {
    const { store } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));
    await store.appendWindowNote(note(TEST_SESSION, 1, 'Rewriting the reconnect path.'));

    const navigator = new ContextNavigator({ store });
    const [hit] = await navigator.searchContext({ projectId: PROJECT, query: 'reconnect' });

    expect(hit!.ref).toEqual({ kind: 'window', sessionId: TEST_SESSION, windowId: 'w-1' });
  });

  it('refuses raw trace and transcript at project scope', async () => {
    const { store } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));
    const navigator = new ContextNavigator({ store });

    const hits = await navigator.searchContext({
      projectId: PROJECT,
      query: 'reconnect',
      sources: ['trace', 'transcript'],
    });
    expect(hits).toEqual([]);
  });

  it('still lets a session search see its own trace', async () => {
    const { store } = await harness(async () => ({
      spokenAnswer: 'a',
      fullAnswer: 'a',
      refs: [],
    }));
    await store.appendWindowNote(note(TEST_SESSION, 1, 'Rewriting the reconnect path.'));

    const navigator = new ContextNavigator({ store });
    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'reconnect',
      sources: ['windows'],
    });
    expect(hits[0]!.source).toBe('windows');
  });
});

describe('Project diff refs', () => {
  it('round-trips and cannot be confused with a session diff', () => {
    const projectRef = { kind: 'diff', projectId: PROJECT } as const;
    const formatted = formatRef(projectRef);
    expect(formatted).toBe('diff:project:git:abc123');
    expect(parseRef(formatted)).toEqual(projectRef);

    const sessionRef = { kind: 'diff', sessionId: TEST_SESSION } as const;
    expect(parseRef(formatRef(sessionRef))).toEqual(sessionRef);
  });

  it('round-trips with a path', () => {
    const ref = { kind: 'diff', projectId: PROJECT, path: 'src/ask.ts' } as const;
    expect(parseRef(formatRef(ref))).toEqual(ref);
  });
});

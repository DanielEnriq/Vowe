import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    testSession({ projectId: PROJECT, task: 'Unified Ask', displayLabel: 'Unified Ask', branch: 'main' }),
  );
  await store.upsertSession(
    testSession({
      id: 'claude-code:second',
      providerSessionId: 'second',
      projectId: PROJECT,
      displayLabel: 'Voice integration',
      task: 'Voice integration',
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
  return { runner, store, root: fixture.root };
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

  it('opens a relative code reference in the project and records its absolute address', async () => {
    const { runner, store, root } = await harness(async (_input, tools) => {
      const opened = await tools.openContext({ ref: 'repo:observer.ts' });
      expect(opened.notFound).toBeUndefined();
      expect(opened.content).toContain('project observer evidence');
      return { spokenAnswer: 'Found it.', fullAnswer: 'Found it.', refs: [opened.ref] };
    });
    await store.upsertProject({ ...store.getProject(PROJECT)!, repoRoot: root });
    await writeFile(path.join(root, 'observer.ts'), '// project observer evidence\n');
    const result = await runner.answerProject({ projectId: PROJECT, question: 'Show me the relevant code.' });
    expect(result.refs).toEqual([{ kind: 'repo', path: path.join(root, 'observer.ts') }]);
  });

  it('uses live observer orientation and carries a follow-up with evidence', async () => {
    const { store } = await harness(async () => ({ spokenAnswer: '', fullAnswer: '', refs: [] }));
    const evidence = { kind: 'trace' as const, sessionId: TEST_SESSION, startSeq: 1, endSeq: 2 };
    const live = testSession({ projectId: PROJECT, generatedTitle: 'Observer intelligence', semanticState: {
      task: 'Join observer state', phase: 'editing', currentActivity: 'Joining observer state',
      currentUnderstanding: 'Window observation now carries settled understanding.',
      meaningfulUpdates: [{ id: 'u1', text: 'The observer publishes into SemanticState.', at: '2026-09-24T10:00:00Z', refs: [evidence] }],
      recentProgress: [], lastMeaningfulUpdate: '2026-09-24T10:00:00Z', source: 'llm',
      provenance: { eventIds: [], throughSeq: 2 }, updatedAt: '2026-09-24T10:00:00Z',
    } });
    const inputs: InvestigationInput[] = [];
    const runner = new DelegatedQuestionRunner({
      store, navigator: new ContextNavigator({ store }), sessionsFor: () => [live],
      investigator: {
        async observeWindow() { return { summary: '' }; },
        async investigate(input) {
          inputs.push(input);
          return { spokenAnswer: 'Joined.', fullAnswer: 'The observer publishes into SemanticState.', refs: [evidence] };
        },
      },
    });
    await runner.answerProject({ projectId: PROJECT, question: 'What changed in the observer work?' });
    await runner.answerProject({ projectId: PROJECT, question: 'Why?' });
    const first = inputs[0] as Extract<InvestigationInput, { projectId: string }>;
    expect(first.sessions[0]).toMatchObject({
      label: 'Observer intelligence', provider: 'claude-code', active: true,
      currentActivity: 'Joining observer state', attention: null,
      currentUnderstanding: 'Window observation now carries settled understanding.',
      latestDevelopment: 'The observer publishes into SemanticState.', evidenceRefs: [formatRef(evidence)],
    });
    expect(first.liveConversation).toEqual([]);
    expect(inputs[1]!.liveConversation).toEqual([
      { speaker: 'user', text: 'What changed in the observer work?' },
      { speaker: 'vo', text: `The observer publishes into SemanticState.\nEvidence: ${formatRef(evidence)}` },
    ]);
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
  it('can find carried understanding through the observations source', async () => {
    const { store } = await harness(async () => ({ spokenAnswer: '', fullAnswer: '', refs: [] }));
    await store.appendWindowNote({
      ...note(TEST_SESSION, 1, 'Routine file reads.'),
      understanding: 'The continuity cursor keeps settled understanding across windows.',
    });
    const hits = await new ContextNavigator({ store }).searchContext({
      projectId: PROJECT, query: 'continuity cursor', sources: ['observations'],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('continuity cursor');
    expect(hits[0]!.ref).toEqual({ kind: 'window', sessionId: TEST_SESSION, windowId: 'w-1' });
  });

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

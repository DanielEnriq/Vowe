import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { formatRef, type ContextRef } from '../src/context/refs.js';
import { ProjectKnowledgeService } from '../src/knowledge/project-knowledge-service.js';
import { ProjectMemoryStore } from '../src/knowledge/project-memory-store.js';
import type { TraceWindow, WindowNote } from '../src/observation/trace-window.js';
import { ArtifactResolver } from '../src/workbench/artifact-resolver.js';
import { FakeKnowledgeProvider } from './fake-knowledge-provider.js';
import { GitFixtures } from './git-fixtures.js';
import {
  makeEvents,
  steadyEvents,
  storeEvents,
  temporaryStore,
  testSession,
  TEST_SESSION,
} from './helpers.js';

const PROJECT = 'git:artifacts';

const fixtures = new GitFixtures();
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  await fixtures.cleanup();
});

interface Harness {
  resolver: ArtifactResolver;
  store: Awaited<ReturnType<typeof temporaryStore>>['store'];
  knowledge: ProjectKnowledgeService;
  provider: FakeKnowledgeProvider;
  memory: ProjectMemoryStore;
  repoRoot: string;
  sourceFile: string;
}

async function harness(
  options: { knowledge?: boolean } = {},
): Promise<Harness> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;

  const repoRoot = await fixtures.repo('work');
  const sourceFile = await fixtures.commitFile(
    repoRoot,
    'src/registry.ts',
    Array.from({ length: 120 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n'),
  );

  await store.upsertSession(testSession({ cwd: repoRoot, projectId: PROJECT }));
  await storeEvents(store, steadyEvents(6));
  await storeEvents(
    store,
    makeEvents([
      { kind: 'agent_message', summary: 'Explaining the reconnect fix', detail: { text: 'It reconnects.' }, atSeconds: 30 },
    ], TEST_SESSION, '/fixtures/spoken.jsonl'),
  );

  const provider = new FakeKnowledgeProvider();
  provider.available = options.knowledge ?? true;
  const memory = new ProjectMemoryStore({
    dataDirFor: (projectId) => store.projectDataDir(projectId),
  });
  const knowledge = new ProjectKnowledgeService({ provider, memory });

  const navigator = new ContextNavigator({ store, knowledge });
  return {
    resolver: new ArtifactResolver({ navigator, store, memory: knowledge }),
    store,
    knowledge,
    provider,
    memory,
    repoRoot,
    sourceFile,
  };
}

function window(overrides: Partial<TraceWindow> = {}): TraceWindow {
  return {
    id: 'w-0',
    sessionId: TEST_SESSION,
    index: 4,
    startSeq: 1,
    endSeq: 6,
    eventCount: 6,
    approxTokens: 300,
    source: '/fixtures/test.jsonl',
    startOffset: 0,
    endOffset: 720,
    startedAt: '2026-02-11T09:00:00.000Z',
    endedAt: '2026-02-11T09:01:00.000Z',
    closedBy: 'maxEvents',
    createdAt: '2026-02-11T09:01:00.000Z',
    ...overrides,
  };
}

function note(): WindowNote {
  return {
    id: 'n-0',
    sessionId: TEST_SESSION,
    windowId: 'w-0',
    windowIndex: 4,
    summary: 'Working through the reconnect path',
    refs: [{ kind: 'trace', sessionId: TEST_SESSION, startSeq: 1, endSeq: 6 }],
    investigated: true,
    createdAt: '2026-02-11T09:01:00.000Z',
  };
}

describe('ArtifactResolver — a ref, as something a person can look at', () => {
  it('resolves a repository ref to unnumbered source, with the line in focus', async () => {
    const { resolver, sourceFile } = await harness();
    const ref: ContextRef = { kind: 'repo', path: sourceFile, line: 40 };

    const artifact = await resolver.resolve(ref);

    expect(artifact.kind).toBe('source');
    expect(artifact.id).toBe(formatRef(ref));
    expect(artifact.title).toBe('registry.ts');
    expect(artifact.subtitle).toContain('line 40');
    if (artifact.content.type !== 'source') throw new Error('expected source content');
    expect(artifact.content.text).toContain('const line40 = 40;');
    // A viewer draws its own gutter. The model-facing rendering numbers the
    // lines; this one must not, or the renderer ends up parsing them back off.
    expect(artifact.content.text).not.toMatch(/^\s+\d+ const line/m);
    expect(artifact.content.startLine).toBe(11);
    expect(artifact.content.endLine).toBe(70);
    expect(artifact.focus?.startLine).toBe(40);
    expect(artifact.focus?.startLine).toBeGreaterThanOrEqual(artifact.content.startLine);
    expect(artifact.focus?.endLine).toBeLessThanOrEqual(artifact.content.endLine);
  });

  it('says so, in a shape that still renders, when the file is gone', async () => {
    const { resolver, repoRoot } = await harness();
    const ref: ContextRef = { kind: 'repo', path: path.join(repoRoot, 'src/deleted.ts') };

    const artifact = await resolver.resolve(ref);

    expect(artifact.kind).toBe('source');
    expect(artifact.sourceRef).toEqual(ref);
    expect(artifact.id).toBe(formatRef(ref));
    if (artifact.content.type !== 'unavailable') throw new Error('expected unavailable');
    expect(artifact.content.reason).toContain('deleted.ts');
  });

  it('resolves the current diff to its stat and patch', async () => {
    const { resolver, repoRoot, sourceFile } = await harness();
    await writeFile(sourceFile, 'const changed = true;\n', 'utf8');

    const artifact = await resolver.resolve({ kind: 'diff', sessionId: TEST_SESSION });

    expect(artifact.kind).toBe('diff');
    expect(artifact.title).toBe('Working diff');
    if (artifact.content.type !== 'diff') throw new Error('expected diff content');
    expect(artifact.content.stat).toContain('registry.ts');
    expect(artifact.content.patch).toContain('const changed = true;');
    // The repository's own paths, not this machine's.
    expect(artifact.content.patch).not.toContain(repoRoot);
    expect(artifact.subtitle).toContain('changed');
  });

  it('resolves a clean tree and a session with no working tree without failing', async () => {
    const { resolver, store } = await harness();

    const clean = await resolver.resolve({ kind: 'diff', sessionId: TEST_SESSION });
    if (clean.content.type !== 'narrative') throw new Error('expected narrative');
    expect(clean.content.text).toBe('The working tree is clean.');

    await store.upsertSession(testSession({ id: 'claude-code:nowhere', cwd: null }));
    const homeless = await resolver.resolve({
      kind: 'diff',
      sessionId: 'claude-code:nowhere',
    });
    expect(homeless.content.type).toBe('unavailable');
  });

  it('resolves an event to normalized material, not the provider’s own record', async () => {
    const { resolver, store } = await harness();
    const event = store.getEvents(TEST_SESSION)[0]!;
    const ref: ContextRef = { kind: 'event', sessionId: TEST_SESSION, eventId: event.id };

    const artifact = await resolver.resolve(ref);

    expect(artifact.kind).toBe('worker_activity');
    expect(artifact.title).toBe(`[${event.seq}] ${event.kind}`);
    expect(artifact.subtitle).toBe(event.summary);
    expect(artifact.focus?.eventIds).toEqual([event.id]);
    if (artifact.content.type !== 'narrative') throw new Error('expected narrative');
    expect(artifact.content.text).toContain(event.summary);
    // The raw provider record is deeper than the default artifact, and stays there.
    expect(artifact.content.text).not.toContain(JSON.stringify(event.raw));
  });

  it('resolves a transcript ref to the exchange around it', async () => {
    const { resolver, store } = await harness();
    const spoken = store
      .getEvents(TEST_SESSION)
      .find((event) => event.kind === 'agent_message')!;

    const artifact = await resolver.resolve({
      kind: 'transcript',
      sessionId: TEST_SESSION,
      eventId: spoken.id,
    });

    expect(artifact.kind).toBe('transcript');
    if (artifact.content.type !== 'narrative') throw new Error('expected narrative');
    expect(artifact.content.text).toContain('Surrounding exchange');
    expect(artifact.content.text).toContain('It reconnects.');
  });

  it('resolves a window through its stored index and note', async () => {
    const { resolver, store } = await harness();
    await store.appendWindow(window());
    await store.appendWindowNote(note());

    const artifact = await resolver.resolve({
      kind: 'window',
      sessionId: TEST_SESSION,
      windowId: 'w-0',
    });

    expect(artifact.kind).toBe('worker_activity');
    expect(artifact.title).toBe('Window 4');
    expect(artifact.subtitle).toBe('Working through the reconnect path');
    expect(artifact.content.type).toBe('narrative');

    const missing = await resolver.resolve({
      kind: 'window',
      sessionId: TEST_SESSION,
      windowId: 'w-nope',
    });
    expect(missing.content.type).toBe('unavailable');
  });

  it('resolves a trace range to the events beneath it', async () => {
    const { resolver } = await harness();

    const artifact = await resolver.resolve({
      kind: 'trace',
      sessionId: TEST_SESSION,
      startSeq: 2,
      endSeq: 4,
    });

    expect(artifact.kind).toBe('worker_activity');
    expect(artifact.title).toBe('Trace 2–4');
    if (artifact.content.type !== 'narrative') throw new Error('expected narrative');
    expect(artifact.content.text).toContain('[2]');
    expect(artifact.content.text).toContain('[4]');
    expect(artifact.content.text).not.toContain('[5]');

    const empty = await resolver.resolve({
      kind: 'trace',
      sessionId: TEST_SESSION,
      startSeq: 900,
      endSeq: 910,
    });
    expect(empty.content.type).toBe('unavailable');
  });

  it('resolves a symbol through the graph, and degrades honestly without one', async () => {
    const { resolver, store, provider, knowledge, sourceFile } = await harness();
    provider.node = {
      label: 'SessionRegistry.absorb',
      kind: 'method',
      summary: 'Assigns a session its project.',
      locations: [{ path: sourceFile, line: 12 }],
      related: [],
    };

    const artifact = await resolver.resolve({
      kind: 'symbol',
      projectId: PROJECT,
      nodeId: 'sessionregistry_absorb',
    });

    expect(artifact.kind).toBe('source');
    expect(artifact.title).toContain('SessionRegistry.absorb');
    expect(artifact.subtitle).toBe(PROJECT);
    if (artifact.content.type !== 'narrative') throw new Error('expected narrative');
    // The graph orients; the file is what is true now, and it is read.
    expect(artifact.content.text).toContain('const line12 = 12;');

    // No indexer, but Vowe's own memory is still there: the graph half is the
    // part that is missing, and the reason says so.
    provider.available = false;
    const withoutGraph = new ArtifactResolver({
      navigator: new ContextNavigator({ store, knowledge }),
      store,
      memory: knowledge,
    });
    const graphless = await withoutGraph.resolve({
      kind: 'symbol',
      projectId: PROJECT,
      nodeId: 'sessionregistry_absorb',
    });
    expect(graphless.kind).toBe('source');
    if (graphless.content.type !== 'unavailable') throw new Error('expected unavailable');
    expect(graphless.content.reason).toContain('code graph');

    // No project knowledge wired at all.
    const blind = new ArtifactResolver({
      navigator: new ContextNavigator({ store }),
      store,
    });
    const unknown = await blind.resolve({
      kind: 'symbol',
      projectId: PROJECT,
      nodeId: 'sessionregistry_absorb',
    });
    if (unknown.content.type !== 'unavailable') throw new Error('expected unavailable');
    expect(unknown.content.reason).toContain('Repository knowledge is not available.');
  });

  it('titles a remembered result by the question it answered', async () => {
    const { resolver, memory } = await harness();
    const record = await memory.remember({
      projectId: PROJECT,
      question: 'Where does a session get its project?',
      answer: 'SessionRegistry.absorb assigns it from the cwd.',
      refs: [{ kind: 'repo', path: 'src/registry.ts', line: 12 }],
    });

    const artifact = await resolver.resolve({
      kind: 'lesson',
      projectId: PROJECT,
      recordId: record.id,
    });

    expect(artifact.kind).toBe('project_memory');
    expect(artifact.title).toBe('Where does a session get its project?');
    expect(artifact.subtitle).toContain('useful');
    if (artifact.content.type !== 'narrative') throw new Error('expected narrative');
    expect(artifact.content.text).toContain('SessionRegistry.absorb assigns it from the cwd.');
  });

  it('still resolves what Vowe remembered when the code graph is absent', async () => {
    const { resolver, memory } = await harness({ knowledge: false });
    const record = await memory.remember({
      projectId: PROJECT,
      question: 'Why is the reconnect delayed?',
      answer: 'The backoff doubles on every failure.',
      refs: [{ kind: 'repo', path: 'src/live.ts' }],
    });

    const artifact = await resolver.resolve({
      kind: 'lesson',
      projectId: PROJECT,
      recordId: record.id,
    });

    // Memory is Vowe's own; the two halves of project knowledge do not fail
    // together.
    expect(artifact.title).toBe('Why is the reconnect delayed?');
    expect(artifact.content.type).toBe('narrative');
  });

  it('gives the same ref the same identity, and different refs different ones', async () => {
    const { resolver, sourceFile } = await harness();
    const ref: ContextRef = { kind: 'repo', path: sourceFile, line: 40 };

    const first = await resolver.resolve(ref);
    const second = await resolver.resolve(ref);
    const other = await resolver.resolve({ kind: 'diff', sessionId: TEST_SESSION });

    expect(first.id).toBe(second.id);
    expect(first.id).toBe(formatRef(ref));
    expect(other.id).not.toBe(first.id);
  });

  it('produces artifacts that survive the trip to the renderer', async () => {
    const { resolver, store, sourceFile } = await harness();
    const event = store.getEvents(TEST_SESSION)[0]!;
    const refs: ContextRef[] = [
      { kind: 'repo', path: sourceFile, line: 40 },
      { kind: 'diff', sessionId: TEST_SESSION },
      { kind: 'event', sessionId: TEST_SESSION, eventId: event.id },
    ];

    for (const ref of refs) {
      const artifact = await resolver.resolve(ref);
      expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
    }
  });

  it('changes nothing by being asked', async () => {
    const { resolver, store, sourceFile } = await harness();
    const before = {
      conversation: store.getConversation(TEST_SESSION),
      events: store.getEvents(TEST_SESSION),
      observation: store.getObservationState(TEST_SESSION),
      sessions: store.listSessions(),
    };

    await resolver.resolve({ kind: 'repo', path: sourceFile, line: 40 });
    await resolver.resolve({ kind: 'diff', sessionId: TEST_SESSION });
    await resolver.resolve({ kind: 'trace', sessionId: TEST_SESSION, startSeq: 1, endSeq: 3 });

    expect(store.getConversation(TEST_SESSION)).toEqual(before.conversation);
    expect(store.getEvents(TEST_SESSION)).toEqual(before.events);
    expect(store.getObservationState(TEST_SESSION)).toEqual(before.observation);
    expect(store.listSessions()).toEqual(before.sessions);
  });
});

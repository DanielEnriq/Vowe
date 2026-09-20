import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { parseRef } from '../src/context/refs.js';
import { ProjectKnowledgeService } from '../src/knowledge/project-knowledge-service.js';
import { UnavailableProjectKnowledge } from '../src/knowledge/project-knowledge.js';
import { FakeKnowledgeProvider } from './fake-knowledge-provider.js';
import { GitFixtures } from './git-fixtures.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const PROJECT = 'git:abc123';

const git = new GitFixtures();
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  await git.cleanup();
});

/**
 * A real repository with real content, because the whole question here is
 * whether a ref that came out of a search can be opened again afterwards.
 */
async function harness(options: { knowledge?: ProjectKnowledgeService } = {}) {
  const repoRoot = await git.repo('app');
  await git.commitFile(
    repoRoot,
    'session-registry.ts',
    [
      '// The registry absorbs discovered sessions.',
      '',
      'export class SessionRegistry {',
      '  absorb() {',
      '    this.assignProject();',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  await fixture.store.upsertSession(
    testSession({ cwd: repoRoot, projectId: PROJECT }),
  );

  const navigator = new ContextNavigator({
    store: fixture.store,
    ...(options.knowledge ? { knowledge: options.knowledge } : {}),
  });
  return { navigator, repoRoot, store: fixture.store };
}

describe('search_context(repo) — acceptance 2: the graph is one source among the rest', () => {
  it('returns graph hits ahead of grep, both under the same source', async () => {
    const provider = new FakeKnowledgeProvider();
    provider.hits = [
      {
        id: 'n1',
        label: 'SessionRegistry',
        kind: 'class',
        summary: 'Absorbs discovered sessions and stamps their project.',
        locations: [],
        origin: 'structure',
      },
    ];
    const { navigator } = await harness({
      knowledge: new ProjectKnowledgeService({ provider }),
    });

    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'SessionRegistry',
      sources: ['repo'],
    });

    // The model asked the repository a question. It is not told, and does not
    // have to care, which store each answer came out of.
    expect(hits.every((hit) => hit.source === 'repo')).toBe(true);
    expect(hits[0]!.refId).toBe(`symbol:${PROJECT}#n1`);
    expect(hits[0]!.label).toBe('SessionRegistry (class)');
    expect(hits.some((hit) => hit.ref.kind === 'repo')).toBe(true);
  });

  it('passes the project through, not the session', async () => {
    const provider = new FakeKnowledgeProvider();
    const { navigator } = await harness({
      knowledge: new ProjectKnowledgeService({ provider }),
    });

    await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'registry',
      sources: ['repo'],
    });

    // Knowledge belongs to the Project, not to whichever session asked.
    expect(provider.searches[0]!.projectId).toBe(PROJECT);
  });

  it('opens a symbol by reading the source it points at', async () => {
    const provider = new FakeKnowledgeProvider();
    const { navigator, repoRoot } = await harness({
      knowledge: new ProjectKnowledgeService({ provider }),
    });
    provider.node = {
      label: 'SessionRegistry',
      kind: 'class',
      summary: 'Absorbs discovered sessions.',
      locations: [{ path: path.join(repoRoot, 'session-registry.ts'), line: 3 }],
      related: [{ nodeId: 'n3', label: 'assignProject', relation: 'SessionRegistry calls assignProject' }],
    };

    const result = await navigator.openContext({ ref: `symbol:${PROJECT}#n1` });

    // The graph says what it thinks; the file says what is true. Both are here,
    // and the file is the part that was read just now.
    expect(result.content).toContain('SessionRegistry calls assignProject');
    expect(result.content).toContain('export class SessionRegistry {');
    expect(result.content).toContain('    3 export class SessionRegistry {');
    expect(result.related.map((ref) => ref.kind)).toContain('repo');
    expect(result.related.map((ref) => ref.kind)).toContain('symbol');
  });

  it('says so plainly when a symbol is not in the graph', async () => {
    const provider = new FakeKnowledgeProvider();
    provider.node = null;
    const { navigator } = await harness({
      knowledge: new ProjectKnowledgeService({ provider }),
    });

    const result = await navigator.openContext({ ref: `symbol:${PROJECT}#gone` });
    expect(result.notFound).toBe('No such symbol in the code graph.');
  });
});

describe('search_context(repo) — acceptance 3: the working tree wins', () => {
  it('still finds an edit the graph has never seen', async () => {
    const provider = new FakeKnowledgeProvider();
    // A graph that knows nothing about this: stale, still building, or behind.
    provider.hits = [];
    const { navigator, repoRoot } = await harness({
      knowledge: new ProjectKnowledgeService({ provider }),
    });
    // The worker just changed a tracked file. Nothing has re-indexed yet.
    await writeFile(
      path.join(repoRoot, 'session-registry.ts'),
      'export class SessionRegistry {\n  justWritten = true;\n}\n',
      'utf8',
    );

    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'justWritten',
      sources: ['repo'],
    });

    // Graph knowledge only ever adds. It cannot subtract a file that is on
    // disk right now, which is what makes a stale index safe to keep serving.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ref.kind).toBe('repo');
  });

  it('behaves exactly as it did before, with no knowledge configured', async () => {
    const { navigator } = await harness();

    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'SessionRegistry',
      sources: ['repo'],
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.ref.kind === 'repo')).toBe(true);
  });

  it('degrades to grep when the provider is the floor', async () => {
    const { navigator } = await harness({
      knowledge: new ProjectKnowledgeService({
        provider: new UnavailableProjectKnowledge('graphify is not installed'),
      }),
    });

    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'SessionRegistry',
      sources: ['repo'],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.ref.kind === 'repo')).toBe(true);
  });
});

describe('a repo ref survives the round trip', () => {
  it('opens the file a search pointed at, from a different working directory', async () => {
    const { navigator, repoRoot } = await harness();

    const [hit] = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'assignProject',
      sources: ['repo'],
    });
    expect(hit).toBeDefined();

    // `git grep` prints repository-relative paths, but this process runs
    // somewhere else entirely — so the ref has to carry an absolute one.
    const ref = parseRef(hit!.refId);
    expect(ref).toMatchObject({ kind: 'repo' });
    expect(path.isAbsolute((ref as { path: string }).path)).toBe(true);
    expect((ref as { path: string }).path.startsWith(repoRoot)).toBe(true);

    const opened = await navigator.openContext({ ref: hit!.refId });
    expect(opened.notFound).toBeUndefined();
    expect(opened.content).toContain('assignProject');
    // And it really is the file on disk, not a copy of the snippet.
    const onDisk = await readFile(path.join(repoRoot, 'session-registry.ts'), 'utf8');
    expect(onDisk).toContain('assignProject');
  });
});

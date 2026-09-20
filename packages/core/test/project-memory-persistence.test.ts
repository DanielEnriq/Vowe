import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import type { ContextRef } from '../src/context/refs.js';
import { ProjectKnowledgeService } from '../src/knowledge/project-knowledge-service.js';
import type {
  ProjectMemoryMirror,
  ProjectMemoryRecord,
} from '../src/knowledge/project-knowledge.js';
import { UnavailableProjectKnowledge } from '../src/knowledge/project-knowledge.js';
import { ProjectMemoryStore } from '../src/knowledge/project-memory-store.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const PROJECT = 'git:abc123';

const REFS: ContextRef[] = [
  { kind: 'symbol', projectId: PROJECT, nodeId: 'src_registry_sessionregistry' },
  { kind: 'repo', path: '/repo/src/registry.ts', line: 3 },
];

const QUESTION = 'Why is project assignment done in SessionRegistry?';
const ANSWER =
  'absorb() is the single funnel every discovered session passes through, so stamping the project there is the only place it cannot be missed.';

/** Records what it was handed, and can be told to fail. */
class RecordingMirror implements ProjectMemoryMirror {
  readonly mirrored: ProjectMemoryRecord[] = [];
  reflections = 0;

  constructor(
    readonly available = true,
    private readonly fail = false,
  ) {}

  async mirror(record: ProjectMemoryRecord): Promise<void> {
    if (this.fail) throw new Error('graphify is not installed');
    this.mirrored.push(record);
  }

  async reflect(): Promise<void> {
    if (this.fail) throw new Error('graphify is not installed');
    this.reflections += 1;
  }
}

const roots: string[] = [];
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-memory-'));
  roots.push(root);
  return root;
}

function storeOn(root: string, mirror?: ProjectMemoryMirror): ProjectMemoryStore {
  return new ProjectMemoryStore({
    dataDirFor: () => root,
    ...(mirror ? { mirror } : {}),
  });
}

describe('acceptance 5: what Vowe learned survives Vowe', () => {
  it('remembers, and finds it again after a restart', async () => {
    const root = await dataRoot();
    const record = await storeOn(root).remember({
      projectId: PROJECT,
      question: QUESTION,
      answer: ANSWER,
      refs: REFS,
    });

    // Quit Vowe and start it again: a new store over the same directory.
    const restarted = storeOn(root);
    const hits = await restarted.search({
      projectId: PROJECT,
      query: 'why is project assignment in SessionRegistry',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(record.id);
    expect(hits[0]!.origin).toBe('memory');
    expect(hits[0]!.summary).toBe(ANSWER);
    // The refs it was worked out from came back too, so it can be re-checked.
    expect((await restarted.get(PROJECT, record.id))!.nodeIds).toEqual([
      'src_registry_sessionregistry',
    ]);
    expect((await restarted.get(PROJECT, record.id))!.locations).toEqual([
      { path: '/repo/src/registry.ts', line: 3 },
    ]);
  });

  it('is reached through the ordinary repository search, as a lesson', async () => {
    const root = await dataRoot();
    const memory = storeOn(root);
    await memory.remember({
      projectId: PROJECT,
      question: QUESTION,
      answer: ANSWER,
      refs: REFS,
    });

    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(
      testSession({ cwd: root, projectId: PROJECT }),
    );

    // No structural provider at all — this is knowledge Vowe owns outright.
    const navigator = new ContextNavigator({
      store: fixture.store,
      knowledge: new ProjectKnowledgeService({
        provider: new UnavailableProjectKnowledge(),
        memory,
      }),
    });

    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'SessionRegistry project assignment',
      sources: ['repo'],
    });

    const lesson = hits.find((hit) => hit.ref.kind === 'lesson');
    expect(lesson).toBeDefined();
    expect(lesson!.source).toBe('repo');
    expect(lesson!.label.startsWith('Known: ')).toBe(true);

    const opened = await navigator.openContext({ ref: lesson!.refId });
    expect(opened.notFound).toBeUndefined();
    expect(opened.content).toContain(ANSWER);
    // A lesson is a previous conclusion, not evidence, so it hands back the
    // material it was drawn from.
    expect(opened.content).toContain('Worked out from:');
    expect(opened.related.map((ref) => ref.kind)).toContain('symbol');
    expect(opened.related.map((ref) => ref.kind)).toContain('repo');
  });
});

describe('acceptance 6: a correction survives, and wins', () => {
  it('supersedes the answer it replaces', async () => {
    const root = await dataRoot();
    const first = await storeOn(root).remember({
      projectId: PROJECT,
      question: QUESTION,
      answer: 'Project assignment happens in ProjectService.resolveForSession.',
      refs: REFS,
    });

    await storeOn(root).correct({
      projectId: PROJECT,
      supersedes: first.id,
      correction:
        'It happens in SessionRegistry.absorb(); ProjectService only resolves identity.',
    });

    // Restart again, so this is answered from disk rather than from memory.
    const restarted = storeOn(root);
    const hits = await restarted.search({
      projectId: PROJECT,
      query: 'where does project assignment happen',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.summary).toContain('SessionRegistry.absorb()');
    expect(hits[0]!.kind).toBe('corrected');
    // The superseded answer is gone from results — which is the entire point
    // of having recorded a correction.
    expect(hits.map((hit) => hit.id)).not.toContain(first.id);
    // But not gone from the record: it is append-only, and how Vowe came to
    // believe the right thing is part of what happened.
    expect((await restarted.list(PROJECT))).toHaveLength(2);
  });

  it('records a correction with no decision model and no mirror', async () => {
    const root = await dataRoot();
    const service = new ProjectKnowledgeService({
      provider: new UnavailableProjectKnowledge(),
      memory: storeOn(root),
      // No `admission` at all: corrections do not go through it.
    });

    const record = await service.recordCorrection({
      projectId: PROJECT,
      question: QUESTION,
      correction: 'It happens in SessionRegistry.absorb().',
    });

    expect(record).not.toBeNull();
    expect(record!.outcome).toBe('corrected');

    // And a plain `consider` still keeps nothing, because nothing can judge it.
    expect(
      await service.consider({
        projectId: PROJECT,
        question: QUESTION,
        answer: ANSWER,
        refs: REFS,
      }),
    ).toBeNull();
  });
});

describe('the mirror is enrichment, never storage', () => {
  it('keeps the mirror in step, and reflects a correction at once', async () => {
    const root = await dataRoot();
    const mirror = new RecordingMirror();
    const memory = storeOn(root, mirror);

    await memory.remember({ projectId: PROJECT, question: QUESTION, answer: ANSWER, refs: REFS });
    expect(mirror.mirrored).toHaveLength(1);
    expect(mirror.mirrored[0]!.nodeIds).toEqual(['src_registry_sessionregistry']);
    // Not after every record — reflection is batched.
    expect(mirror.reflections).toBe(0);

    await memory.correct({ projectId: PROJECT, correction: 'Actually elsewhere.' });
    // A correction that has not propagated leaves the wrong answer standing in
    // the lessons file, so this one does not wait for a batch.
    expect(mirror.reflections).toBeGreaterThanOrEqual(1);
  });

  it('remembers just as well with no mirror at all', async () => {
    const root = await dataRoot();
    const memory = storeOn(root);
    await memory.remember({ projectId: PROJECT, question: QUESTION, answer: ANSWER, refs: REFS });
    expect(await storeOn(root).search({ projectId: PROJECT, query: 'SessionRegistry' })).toHaveLength(1);
  });

  it('does not let a broken mirror fail the write', async () => {
    const root = await dataRoot();
    const scopes: string[] = [];
    const memory = new ProjectMemoryStore({
      dataDirFor: () => root,
      mirror: new RecordingMirror(true, true),
      reflectEvery: 1,
      onError: (scope) => scopes.push(scope),
    });

    const record = await memory.remember({
      projectId: PROJECT,
      question: QUESTION,
      answer: ANSWER,
      refs: REFS,
    });

    expect(record.id).toBeTruthy();
    expect(scopes).toContain('memory:mirror');
    expect(scopes).toContain('memory:reflect');
    // Still on disk, which is the only thing that matters.
    expect(await storeOn(root).get(PROJECT, record.id)).not.toBeNull();
  });
});

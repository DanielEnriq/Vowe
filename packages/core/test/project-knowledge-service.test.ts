import { describe, expect, it } from 'vitest';

import { ProjectKnowledgeService } from '../src/knowledge/project-knowledge-service.js';
import { UnavailableProjectKnowledge } from '../src/knowledge/project-knowledge.js';
import { FakeKnowledgeProvider } from './fake-knowledge-provider.js';

const PROJECT = 'git:abc123';
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('acceptance 1: asking is what builds the index', () => {
  it('starts a build on the first repository question', async () => {
    const provider = new FakeKnowledgeProvider();
    const service = new ProjectKnowledgeService({ provider });

    await service.search({ projectId: PROJECT, query: 'session registry' });

    expect(provider.countOf('ensureIndexed')).toBe(1);
    expect(provider.searches).toHaveLength(1);
  });

  it('does not start one merely because a room was opened', async () => {
    const provider = new FakeKnowledgeProvider();
    const service = new ProjectKnowledgeService({ provider });

    await service.describe(PROJECT);

    // Opening a Project should not commit the machine to indexing it.
    expect(provider.countOf('hydrate')).toBe(1);
    expect(provider.countOf('ensureIndexed')).toBe(0);
  });

  it('returns immediately rather than waiting for the build', async () => {
    const provider = new FakeKnowledgeProvider();
    // A build that never finishes. A search must not be hostage to it: the
    // caller is usually part-way through answering out loud.
    provider.blockBuild = new Promise(() => undefined);
    const service = new ProjectKnowledgeService({ provider });

    const hits = await service.search({ projectId: PROJECT, query: 'anything' });

    expect(hits).toEqual([]);
    expect(provider.searches).toHaveLength(1);
  });

  it('keeps answering when the provider throws', async () => {
    const provider = new FakeKnowledgeProvider();
    provider.search = async () => {
      throw new Error('graph is being rewritten');
    };
    const scopes: string[] = [];
    const service = new ProjectKnowledgeService({
      provider,
      onError: (scope) => scopes.push(scope),
    });

    expect(await service.search({ projectId: PROJECT, query: 'x' })).toEqual([]);
    expect(scopes).toContain('knowledge:search');
  });
});

describe('acceptance 8: no repository knowledge at all', () => {
  it('answers every call without anyone having checked first', async () => {
    const service = new ProjectKnowledgeService({
      provider: new UnavailableProjectKnowledge('graphify is not installed'),
    });

    expect(service.available).toBe(false);
    expect(service.unavailableReason).toBe('graphify is not installed');
    expect(await service.search({ projectId: PROJECT, query: 'x' })).toEqual([]);
    expect(await service.open(PROJECT, 'n1')).toBeNull();
    expect((await service.describe(PROJECT)).status).toBe('unindexed');
    // Staleness from an observed edit is simply ignored.
    service.noteSourceChange(PROJECT);
    await settle();
  });
});

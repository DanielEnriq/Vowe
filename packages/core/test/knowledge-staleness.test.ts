import { afterEach, describe, expect, it } from 'vitest';

import { ProjectKnowledgeService } from '../src/knowledge/project-knowledge-service.js';
import { FakeKnowledgeProvider } from './fake-knowledge-provider.js';

const PROJECT = 'git:abc123';
const QUIET_MS = 25;
const settle = (ms = QUIET_MS * 3) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let service: ProjectKnowledgeService | null = null;
afterEach(() => {
  service?.stop();
  service = null;
});

function harness(options: { burstChanges?: number } = {}) {
  const provider = new FakeKnowledgeProvider();
  provider.setStatus('ready');
  service = new ProjectKnowledgeService({
    provider,
    quietMs: QUIET_MS,
    ...(options.burstChanges === undefined ? {} : { burstChanges: options.burstChanges }),
  });
  return { provider, service: service! };
}

describe('acceptance 4: the index follows the work', () => {
  it('marks stale at once and refreshes after the quiet period', async () => {
    const { provider, service } = harness();

    service.noteSourceChange(PROJECT);

    // Marking is immediate, so the UI tells the truth straight away.
    expect(provider.countOf('markStale')).toBe(1);
    expect(provider.status(PROJECT).status).toBe('stale');
    // Refreshing is not.
    expect(provider.countOf('refresh')).toBe(0);

    await settle();
    expect(provider.countOf('refresh')).toBe(1);
    expect(provider.status(PROJECT).status).toBe('ready');
  });

  it('coalesces a burst of edits into one refresh', async () => {
    const { provider, service } = harness();

    // A worker mid-edit produces exactly this shape.
    for (let i = 0; i < 12; i += 1) service.noteSourceChange(PROJECT);

    await settle();
    expect(provider.countOf('markStale')).toBe(12);
    expect(provider.countOf('refresh')).toBe(1);
  });

  it('stops waiting once enough has changed', async () => {
    const { provider, service } = harness({ burstChanges: 4 });

    for (let i = 0; i < 4; i += 1) service.noteSourceChange(PROJECT);

    // No quiet period elapsed: a long edit run should not leave the graph
    // indefinitely behind just because the worker never pauses.
    await settle(5);
    expect(provider.countOf('refresh')).toBe(1);
  });

  it('refreshes rather than rebuilding', async () => {
    const { provider, service } = harness();
    service.noteSourceChange(PROJECT);
    await settle();

    // `refresh` is incremental; a full `extract` on every edit would cost far
    // more than the change is worth.
    expect(provider.calls).toContain('refresh');
    expect(provider.calls).not.toContain('extract');
  });

  it('never runs two refreshes at once, and picks up what arrived meanwhile', async () => {
    const { provider, service } = harness();
    const original = provider.refresh.bind(provider);
    let release: (() => void) | null = null;
    let starts = 0;
    let inFlight = 0;
    let maxConcurrent = 0;

    provider.refresh = async (projectId: string) => {
      starts += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Only the first pass hangs; the point is what happens to the edits that
      // arrive while it is hanging.
      if (starts === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      inFlight -= 1;
      return original(projectId);
    };

    service.noteSourceChange(PROJECT);
    await settle();
    expect(starts).toBe(1);

    service.noteSourceChange(PROJECT);
    await settle();
    // Still one: a second refresh must not start on top of the first.
    expect(starts).toBe(1);

    release?.();
    await settle();

    expect(maxConcurrent).toBe(1);
    // …but the change that arrived meanwhile was not dropped.
    expect(starts).toBe(2);
  });

  it('forgets pending work when stopped', async () => {
    const { provider, service } = harness();
    service.noteSourceChange(PROJECT);
    service.stop();

    await settle();
    expect(provider.countOf('refresh')).toBe(0);
    expect(provider.calls).toContain('stop');
  });
});

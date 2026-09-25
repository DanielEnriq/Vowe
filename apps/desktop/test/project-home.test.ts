import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectBrief, ProjectMemoryRecord, ProjectSessionSummary } from '@vowe/core';
import { DEFAULT_PRESENCE_PROFILE } from '@vowe/core/presence';
import { projectChanges, projectRef } from '../src/renderer/state/project-home.js';
import { ProjectRoom } from '../src/renderer/project/ProjectRoom.js';

const at = '2026-09-24T12:00:00.000Z';
const worker: ProjectSessionSummary = {
  sessionId: 'codex:1', title: 'Observer intelligence', provider: 'codex', status: 'working',
  currentActivity: 'Joining the observation paths', currentUnderstanding: 'The shared observer state is connected.',
  latestDevelopment: { id: 'update', text: 'Connected shared state.', at, refs: [{ kind: 'event', sessionId: 'codex:1', eventId: 'event' }] },
  attention: null, branch: null, lastActivityAt: at, needsAttention: false,
};
function brief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return { projectId: 'p', headline: 'Everything is moving.', detailLines: [], active: [worker], recent: [],
    needsAttention: [], latestSignal: null, knowledge: { status: 'unavailable' }, updatedAt: at, ...overrides };
}
function memory(overrides: Partial<ProjectMemoryRecord> = {}): ProjectMemoryRecord {
  return { id: 'memory', projectId: 'p', at, question: 'Why did activity change?', answer: 'The two paths now share state.',
    refs: [], nodeIds: [], locations: [], outcome: 'useful', ...overrides };
}
afterEach(() => vi.unstubAllGlobals());

describe('Project Home selections', () => {
  it('keeps only the latest development for each session and retains its evidence', () => {
    const signal = { sessionId: worker.sessionId, text: 'Verified the connected state.', at: '2026-09-24T12:01:00.000Z', refs: worker.latestDevelopment!.refs };
    const changes = projectChanges(brief({ latestSignal: signal }), []);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ text: signal.text, ref: signal.refs[0], sessionId: worker.sessionId });
  });
  it('drops superseded and dead-end memories, keeps the correction and its address', () => {
    const corrected = memory({ id: 'correction', outcome: 'corrected', supersedes: 'memory', correction: 'Corrected understanding.' });
    const changes = projectChanges(null, [memory(), memory({ id: 'failed', outcome: 'dead_end' }), corrected]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ text: corrected.correction, ref: { kind: 'lesson', projectId: 'p', recordId: 'correction' } });
  });
  it('deduplicates identical developments and bounds the page without changing records', () => {
    const memories = Array.from({ length: 6 }, (_, i) => memory({ id: `${i}`, answer: i < 2 ? 'Same finding' : `Finding ${i}` }));
    const original = structuredClone(memories);
    expect(projectChanges(null, memories)).toHaveLength(3);
    expect(memories).toEqual(original);
  });
  it('does not invent changes from liveness or current understanding', () => {
    expect(projectChanges(brief({ active: [], recent: [{ ...worker, status: 'finished', latestDevelopment: null }] }), [])).toEqual([]);
    expect(projectChanges(null, [])).toEqual([]);
  });
  it('does not let routine start markers displace meaningful developments', () => {
    const starting = { ...worker, latestDevelopment: { ...worker.latestDevelopment!, text: 'started work' } };
    expect(projectChanges(brief({ active: [starting] }), [])).toEqual([]);
  });
  it('resolves project-relative file evidence without changing session addresses', () => {
    expect(projectRef({ kind: 'repo', path: 'src/main.ts', line: 8 }, '/repo')).toEqual({ kind: 'repo', path: '/repo/src/main.ts', line: 8 });
    const ref = { kind: 'event', sessionId: 'codex:1', eventId: 'event' } as const;
    expect(projectRef(ref, '/repo')).toBe(ref);
  });
});

function render(briefValue: ProjectBrief): string {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return renderToStaticMarkup(createElement(ProjectRoom, {
    brief: briefValue, changes: projectChanges(briefValue, []), presence: DEFAULT_PRESENCE_PROFILE,
    presenceState: 'idle', composer: 'Ask Vowe', hasConversation: true, investigating: false,
    onOpenConversation() {}, onOpenSession() {}, onOpenRef() {},
  }));
}

describe('Project Home hierarchy', () => {
  it('shows three providers as work, without empty attention or transcript sections', () => {
    const html = render(brief({ active: ['codex', 'pi', 'claude-code'].map((provider, i) => ({ ...worker, provider, title: `Work ${i}`, sessionId: `${provider}:1` })) }));
    for (const title of ['Work 0', 'Work 1', 'Work 2']) expect(html).toContain(title);
    expect(html).toContain('Current work');
    expect(html).toContain('Open conversation');
    expect(html).not.toContain('Needs you');
    expect(html).not.toContain('Recently');
    expect(html).not.toContain('project-thread');
  });
  it('settles idle work without pretending it finished or filling absent changes', () => {
    const html = render(brief({ headline: 'Quiet here.', active: [], recent: [{ ...worker, status: 'idle', latestDevelopment: null }] }));
    expect(html).toContain(worker.currentUnderstanding);
    expect(html).toContain('Last active');
    expect(html).not.toContain('Current work');
    expect(html).not.toContain('What changed');
    expect(html).not.toContain('Needs you');
    expect(html).not.toContain('finished');
  });
  it('gives a genuine attention condition a session navigation path', () => {
    const html = render(brief({ needsAttention: [{ id: 'attention', sessionId: worker.sessionId, projectId: 'p', kind: 'permission', summary: 'Approve the requested command.', createdAt: at, refs: [] }] }));
    expect(html).toContain('Needs you');
    expect(html).toContain('Approve the requested command.');
    expect(html).toContain('Open session');
  });
});

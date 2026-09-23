import { describe, expect, it } from 'vitest';

import type { OpenResult, SearchHit } from '../src/context/context-navigator.js';
import type { ContextRef } from '../src/context/refs.js';
import {
  describeDiff,
  describeSearch,
  describeSearchResult,
  InvestigationRecorder,
} from '../src/delegation/investigation-recorder.js';

const event = (eventId: string): ContextRef => ({ kind: 'event', sessionId: 's', eventId });

function hit(ref: ContextRef): SearchHit {
  return { ref, refId: 'unused', source: 'trace', label: 'x', snippet: 'x' };
}

function opened(ref: ContextRef): OpenResult {
  return { ref, refId: 'unused', kind: ref.kind, content: 'x', related: [], truncated: false };
}

describe('describeSearch — the query drives the label', () => {
  it.each([
    ['recent session activity', 'Looking for recent session activity'],
    ['whether the Slice 6.3 repair is complete', 'Checking whether the Slice 6.3 repair is complete'],
    ['what happened after the failed test suite', 'Finding what happened after the failed test suite'],
    ['what changed in Conversation.tsx', 'Finding what changed in Conversation.tsx'],
    ['why no answer was produced', 'Tracing why no answer was produced'],
    ['where the title fallback is implemented', 'Locating where the title fallback is implemented'],
    ['latest test run for session-title.ts', 'Looking for the latest test run for session-title.ts'],
    ['event 527 details and the final agent response', 'Looking for event 527 details and the final agent response'],
  ])('%s', (query, label) => {
    expect(describeSearch(query)).toBe(label);
  });

  it('strips transport noise and nothing else', () => {
    expect(describeSearch('  Can you find out whether   `sessionTitle()` is called?  ')).toBe(
      'Checking whether `sessionTitle()` is called',
    );
    expect(describeSearch('"uncommitted changes in the worker session"')).toBe(
      'Looking for uncommitted changes in the worker session',
    );
  });

  it('gives an identical normalized query an identical label', () => {
    expect(describeSearch('Whether the tests passed?')).toBe(describeSearch('whether the tests passed'));
    expect(describeSearch('WHY  the build broke.')).toBe(describeSearch('why the build broke'));
  });

  it('keeps materially different queries apart', () => {
    const queries = [
      'recent session activity',
      'whether tests passed',
      'whether the UI repair finished',
      'whether the database migration finished',
      'whether the tests did not pass',
      'what failed in the latest test run',
      'what failed in the first test run',
    ];
    const labels = queries.map((query) => describeSearch(query));
    expect(new Set(labels).size).toBe(queries.length);
  });

  it('keeps a long query to one line and says it was cut', () => {
    const label = describeSearch(`whether ${'the worker finished the repair and '.repeat(6)}tests passed`);
    expect(label.length).toBeLessThan(120);
    expect(label.endsWith('…')).toBe(true);
    expect(label.startsWith('Checking whether the worker finished')).toBe(true);
  });

  it('falls back to the sources only when there is no query at all', () => {
    expect(describeSearch('  ?  ', ['repo'])).toBe('Searched the repository');
  });
});

describe('describeSearchResult — a count, never a paraphrase', () => {
  it('says what the search returned', () => {
    expect(describeSearchResult([])).toBe('No matching items found');
    expect(describeSearchResult([hit(event('a'))])).toBe('1 matching item');
    expect(describeSearchResult([hit(event('a')), hit(event('b'))])).toBe('2 matching items');
  });
});

describe('describeDiff', () => {
  it('names the path when there is one', () => {
    expect(describeDiff('apps/desktop/Conversation.tsx')).toBe(
      'Inspecting apps/desktop/Conversation.tsx changes',
    );
    expect(describeDiff(undefined)).toBe('Inspecting the current diff');
  });
});

describe('InvestigationRecorder — an open inherits why it was opened', () => {
  it('carries the search clause onto an open of one of its hits', () => {
    const recorder = new InvestigationRecorder();
    recorder.searched('whether the UI repair finished', undefined, [hit(event('550'))]);
    recorder.opened(event('550'), opened(event('550')));

    const [search, open] = recorder.receipt(0).checks;
    expect(search).toMatchObject({
      label: 'Checking whether the UI repair finished',
      detail: '1 matching item',
    });
    expect(open!.label).toBe('Reading the worker update about whether the UI repair finished');
    expect(open!.detail).toBeUndefined();
  });

  it('names a file by the question that led to it', () => {
    const file: ContextRef = { kind: 'repo', path: 'packages/core/src/session-title.ts' };
    const recorder = new InvestigationRecorder();
    recorder.searched('where the title fallback is implemented', ['repo'], [hit(file)]);
    recorder.opened(file, opened(file));

    expect(recorder.receipt(0).checks[1]!.label).toBe(
      'Reading session-title.ts for where the title fallback is implemented',
    );
  });

  it('uses the most recent search that found the ref', () => {
    const recorder = new InvestigationRecorder();
    recorder.searched('recent session activity', undefined, [hit(event('9'))]);
    recorder.searched('what failed in the latest test run', undefined, [hit(event('9'))]);
    recorder.opened(event('9'), opened(event('9')));

    expect(recorder.receipt(0).checks[2]!.label).toBe(
      'Reading the worker update about what failed in the latest test run',
    );
  });

  it('describes the ref alone when no search turned it up', () => {
    const recorder = new InvestigationRecorder();
    recorder.searched('whether tests passed', undefined, [hit(event('1'))]);
    recorder.opened(event('2'), opened(event('2')));

    expect(recorder.receipt(0).checks[1]!.label).toBe('Reviewed worker activity');
  });
});

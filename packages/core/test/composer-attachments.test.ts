import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import type { ContextRef } from '../src/context/refs.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
} from '../src/llm/observation-llm.js';
import { TEST_SESSION, temporaryStore, testSession } from './helpers.js';

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function harness() {
  const fixture = await temporaryStore();
  cleanup.push(fixture.cleanup);
  const { store } = fixture;
  await store.upsertSession(testSession());

  const dir = await mkdtemp(path.join(tmpdir(), 'vowe-attach-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ask.ts');
  await writeFile(file, 'export async function ask() {\n  return investigate();\n}\n', 'utf8');

  let seen: InvestigationInput | null = null;
  const investigator: ObservationLlm = {
    async observeWindow() {
      return { summary: 'x' };
    },
    async investigate(input): Promise<DelegatedAnswer> {
      seen = input;
      return { spokenAnswer: 'Yes.', fullAnswer: 'Yes, it does.', refs: [] };
    },
  };

  const runner = new DelegatedQuestionRunner({
    store,
    navigator: new ContextNavigator({ store }),
    investigator,
  });

  return { runner, file, seen: () => seen };
}

describe('Composer attachments — a chip the investigator honours', () => {
  it('opens an attachment before the model runs and hands it the material', async () => {
    const { runner, file, seen } = await harness();

    await runner.answer({
      sessionId: TEST_SESSION,
      question: 'Does this still compile?',
      contextRefs: [{ kind: 'repo', path: file }],
    });

    const attachments = seen()!.attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments![0]!.refId).toBe(`repo:${file}`);
    expect(attachments![0]!.content).toContain('export async function ask()');
  });

  /**
   * The point of opening them here rather than describing them: "I attached
   * this" and "Vowe looked at this" become the same claim, and the receipt is
   * what proves it.
   */
  it('records the attachment as the first thing checked', async () => {
    const { runner, file } = await harness();

    const result = await runner.answer({
      sessionId: TEST_SESSION,
      question: 'Does this still compile?',
      contextRefs: [{ kind: 'repo', path: file }],
    });

    const checks = result.entry.investigation?.checks ?? [];
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]!.kind).toBe('open');
    expect(checks[0]!.refs[0]).toEqual({ kind: 'repo', path: file });
  });

  it('sends no attachments key when nothing was attached', async () => {
    const { runner, seen } = await harness();
    await runner.answer({ sessionId: TEST_SESSION, question: 'plain question' });
    expect(seen()!.attachments).toBeUndefined();
  });

  it('answers anyway when an attachment cannot be read', async () => {
    const { runner, seen } = await harness();

    const result = await runner.answer({
      sessionId: TEST_SESSION,
      question: 'Does this still compile?',
      contextRefs: [{ kind: 'repo', path: '/nowhere/missing.ts' }],
    });

    expect(result.failed).toBe(false);
    // Either skipped or opened-as-not-found, but never a thrown question.
    const attachments = seen()!.attachments ?? [];
    expect(attachments.length).toBeLessThanOrEqual(1);
  });

  it('bounds how much can be attached to one question', async () => {
    const { runner, file, seen } = await harness();
    const many: ContextRef[] = Array.from({ length: 9 }, () => ({
      kind: 'repo' as const,
      path: file,
    }));

    await runner.answer({
      sessionId: TEST_SESSION,
      question: 'everything at once',
      contextRefs: many,
    });

    expect(seen()!.attachments!.length).toBeLessThanOrEqual(4);
  });
});

import { describe, expect, it } from 'vitest';

import type { ContextRef } from '../src/context/refs.js';
import type {
  ChoiceInput,
  ChoiceResult,
  DecisionRouter,
  NoulInput,
  NoulResult,
  ScoreResult,
} from '../src/decision/decision-router.js';
import {
  ConservativeMemoryAdmission,
  isRepositoryGrounded,
} from '../src/knowledge/memory-admission.js';

const PROJECT = 'git:abc123';

/** Grounded in the repository: this answer came out of the code. */
const REPO_REFS: ContextRef[] = [
  { kind: 'symbol', projectId: PROJECT, nodeId: 'src_registry_sessionregistry' },
  { kind: 'repo', path: '/repo/src/registry.ts', line: 3 },
];

/** Grounded in the session: this answer is about a worker, right now. */
const SESSION_REFS: ContextRef[] = [
  { kind: 'trace', sessionId: 'claude-code:x', startSeq: 1, endSeq: 9 },
  { kind: 'event', sessionId: 'claude-code:x', eventId: 'e-1' },
  { kind: 'diff', sessionId: 'claude-code:x', path: 'src/registry.ts' },
  { kind: 'transcript', sessionId: 'claude-code:x', eventId: 'e-2' },
];

/** A router that answers with whatever it was told to, and records the asking. */
class StubRouter implements DecisionRouter {
  readonly name = 'stub';
  readonly calls: NoulInput[] = [];

  constructor(
    readonly available: boolean,
    private readonly answer: number | null | 'throw',
  ) {}

  async noul(input: NoulInput): Promise<NoulResult | null> {
    this.calls.push(input);
    if (this.answer === 'throw') throw new Error('decisions are down');
    return this.answer === null ? null : { noul: this.answer };
  }

  async choose<K extends string>(
    _input: ChoiceInput<K>,
  ): Promise<ChoiceResult<K> | null> {
    return null;
  }

  async score(): Promise<ScoreResult | null> {
    return null;
  }
}

const ARCHITECTURAL = {
  question: 'Why is project assignment done in SessionRegistry?',
  answer:
    'absorb() is the single funnel every discovered session passes through, so stamping the project there is the only place it cannot be missed.',
};

describe('grounding — acceptance 7: what the session knows is not what the repository knows', () => {
  it('reads grounding off the refs, not the wording', () => {
    expect(isRepositoryGrounded(REPO_REFS)).toBe(true);
    expect(isRepositoryGrounded(SESSION_REFS)).toBe(false);
    expect(isRepositoryGrounded([])).toBe(false);
    // String forms too, since that is how a record stores them.
    expect(isRepositoryGrounded([`symbol:${PROJECT}#n1`])).toBe(true);
    expect(isRepositoryGrounded(['diff:claude-code:x'])).toBe(false);
  });

  it('rejects an answer about the current run before the model is asked', async () => {
    const router = new StubRouter(true, 1);
    const policy = new ConservativeMemoryAdmission({ router });

    const admitted = await policy.shouldRemember({
      question: 'What command is the worker running right now?',
      answer: 'It is running `pnpm test` and is on test 47 of 163.',
      refs: SESSION_REFS,
    });

    expect(admitted).toBe(false);
    // Not merely rejected — never even considered. The structural gate is
    // first because it is the cheap one and the certain one.
    expect(router.calls).toHaveLength(0);
  });
});

describe('admission — acceptance 5: grounding is necessary, not sufficient', () => {
  it('admits a durable architectural answer', async () => {
    const router = new StubRouter(true, 0.8);
    const policy = new ConservativeMemoryAdmission({ router });

    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(true);

    // The model is asked about a future, unrelated session — not about whether
    // the answer is correct, which is not in doubt by this point.
    expect(router.calls[0]!.instructions).toContain('future, unrelated coding session');
    expect(router.calls[0]!.state).toMatchObject({ question: ARCHITECTURAL.question });
  });

  it('rejects a repository-grounded answer the model does not think will last', async () => {
    const router = new StubRouter(true, 0.6);
    const policy = new ConservativeMemoryAdmission({ router });

    // Above 0.5, which is what the observer uses to decide whether to explore.
    // Remembering is held to a higher bar than looking.
    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(false);
  });

  it('respects a threshold set explicitly', async () => {
    const policy = new ConservativeMemoryAdmission({
      router: new StubRouter(true, 0.6),
      threshold: 0.5,
    });
    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(true);
  });
});

describe('admission fails closed', () => {
  it('remembers nothing at all with no decision model', async () => {
    const policy = new ConservativeMemoryAdmission();

    // A deliberate departure from the DecisionRouter convention that every call
    // site has its own deterministic answer. Here the deterministic answer *is*
    // no: a sparse memory costs a rediscovery, a polluted one cannot be undone.
    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(false);
  });

  it('remembers nothing when the router is in shadow mode', async () => {
    const router = new StubRouter(false, 1);
    const policy = new ConservativeMemoryAdmission({ router });
    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(false);
    expect(router.calls).toHaveLength(0);
  });

  it('remembers nothing when the router declines to answer', async () => {
    const policy = new ConservativeMemoryAdmission({
      router: new StubRouter(true, null),
    });
    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(false);
  });

  it('remembers nothing when the router fails, and says why', async () => {
    const scopes: string[] = [];
    const policy = new ConservativeMemoryAdmission({
      router: new StubRouter(true, 'throw'),
      onError: (scope) => scopes.push(scope),
    });
    expect(
      await policy.shouldRemember({ ...ARCHITECTURAL, refs: REPO_REFS }),
    ).toBe(false);
    expect(scopes).toContain('memory:admission');
  });
});

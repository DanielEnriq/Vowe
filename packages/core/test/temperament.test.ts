import { afterEach, describe, expect, it } from 'vitest';

import {
  CommunicationPolicy,
  DEFAULT_TEMPERAMENT,
  MAX_PERSONAL_INSTRUCTION,
  bandOf,
  effectivePreference,
  meetsSpeakFloor,
  normalizeTemperament,
  speakFloor,
  temperamentGuidance,
  type SurfaceUpdate,
  type SurfaceUrgency,
  type TemperamentProfile,
} from '../src/index.js';
import type { DecisionRouter } from '../src/decision/decision-router.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
} from '../src/llm/observation-llm.js';
import { TEST_SESSION, temporaryStore, testSession } from './helpers.js';

function candidate(urgency: SurfaceUrgency): SurfaceUpdate {
  return {
    id: `candidate-${urgency}`,
    sessionId: TEST_SESSION,
    windowId: 'w-1',
    message: 'It switched approaches after the reconnect test failed again.',
    whyNow: 'Second identical failure.',
    refs: [],
    urgency,
    createdAt: '2026-09-22T09:10:00.000Z',
  };
}

const alwaysSpeaks: DecisionRouter = {
  name: 'stub',
  available: true,
  async choose() {
    return { choice: 'speak_now' as never };
  },
  async score() {
    return null;
  },
  async noul() {
    return null;
  },
};

function at(proactive: number): TemperamentProfile {
  return { ...DEFAULT_TEMPERAMENT, proactive };
}

describe('Temperament — normalization', () => {
  it('defaults to the design’s resting positions', () => {
    expect(normalizeTemperament(undefined)).toEqual({
      proactive: 0.3,
      exploratory: 0.35,
      casual: 0.25,
    });
  });

  it('clamps every dial into range and ignores nonsense', () => {
    expect(normalizeTemperament({ proactive: 4, exploratory: -2, casual: 'loud' })).toEqual({
      proactive: 1,
      exploratory: 0,
      casual: DEFAULT_TEMPERAMENT.casual,
    });
  });

  it('collapses whitespace and bounds the personal instruction', () => {
    const profile = normalizeTemperament({
      personalInstruction: '  Only interrupt me\n\nwhen something needs my attention.  ',
    });
    expect(profile.personalInstruction).toBe(
      'Only interrupt me when something needs my attention.',
    );

    const long = normalizeTemperament({ personalInstruction: 'x'.repeat(900) });
    expect(long.personalInstruction).toHaveLength(MAX_PERSONAL_INSTRUCTION);
  });

  it('omits an empty instruction rather than storing a blank', () => {
    expect(normalizeTemperament({ personalInstruction: '   ' }).personalInstruction).toBeUndefined();
  });
});

describe('Temperament — Quiet↔Proactive changes what is said out loud', () => {
  it('raises the urgency floor as the dial moves quiet', () => {
    expect(speakFloor(at(0))).toBe('high');
    expect(speakFloor(at(0.5))).toBe('normal');
    expect(speakFloor(at(1))).toBe('low');
  });

  it('bands on thirds', () => {
    expect(bandOf(0.32)).toBe('low');
    expect(bandOf(0.34)).toBe('middle');
    expect(bandOf(0.67)).toBe('high');
  });

  /**
   * The load-bearing assertion for the whole control: the same candidate and
   * the same decision model produce a different outcome at each setting. If
   * this test can be deleted without another failing, the slider is cosmetic.
   */
  it('holds an approved low-urgency development when the developer asked to be left alone', async () => {
    const policy = new CommunicationPolicy({ router: alwaysSpeaks });
    const low = candidate('low');

    expect((await policy.evaluate(low, null, at(0.1))).action).toBe('queue');
    expect((await policy.evaluate(low, null, at(0.5))).action).toBe('queue');
    expect((await policy.evaluate(low, null, at(0.9))).action).toBe('speak_now');
  });

  it('still speaks an urgent development at every setting', async () => {
    const policy = new CommunicationPolicy({ router: alwaysSpeaks });
    for (const proactive of [0, 0.5, 1]) {
      expect((await policy.evaluate(candidate('high'), null, at(proactive))).action).toBe(
        'speak_now',
      );
    }
  });

  it('lets a middle setting through for a normal development but a quiet one not', async () => {
    const policy = new CommunicationPolicy({ router: alwaysSpeaks });
    expect((await policy.evaluate(candidate('normal'), null, at(0.5))).action).toBe('speak_now');
    expect((await policy.evaluate(candidate('normal'), null, at(0.1))).action).toBe('queue');
  });

  it('explains a held development in the decision itself', async () => {
    const policy = new CommunicationPolicy({ router: alwaysSpeaks });
    const decision = await policy.evaluate(candidate('low'), null, at(0));
    expect(decision.reason).toMatch(/interrupted less/);
  });

  /** Only ever downwards: erring quiet is the house rule. */
  it('never promotes something the model declined to speak', async () => {
    const declines: DecisionRouter = {
      ...alwaysSpeaks,
      async choose() {
        return { choice: 'ignore' as never };
      },
    };
    const policy = new CommunicationPolicy({ router: declines });
    expect((await policy.evaluate(candidate('high'), null, at(1))).action).toBe('ignore');
  });

  it('leaves behaviour untouched when no temperament is supplied', async () => {
    const policy = new CommunicationPolicy({ router: alwaysSpeaks });
    expect((await policy.evaluate(candidate('low'), null)).action).toBe('speak_now');
  });

  it('agrees with meetsSpeakFloor', () => {
    expect(meetsSpeakFloor('low', at(1))).toBe(true);
    expect(meetsSpeakFloor('low', at(0))).toBe(false);
    expect(meetsSpeakFloor('high', at(0))).toBe(true);
  });
});

describe('Temperament — the other two dials change the prompt', () => {
  it('produces a different instruction at each length setting', () => {
    const texts = [0, 0.5, 1].map((exploratory) =>
      temperamentGuidance({ ...DEFAULT_TEMPERAMENT, exploratory }),
    );
    expect(new Set(texts).size).toBe(3);
  });

  it('produces a different instruction at each register setting', () => {
    const texts = [0, 0.5, 1].map((casual) =>
      temperamentGuidance({ ...DEFAULT_TEMPERAMENT, casual }),
    );
    expect(new Set(texts).size).toBe(3);
  });

  it('varies the two axes independently', () => {
    const base = temperamentGuidance({ ...DEFAULT_TEMPERAMENT, exploratory: 0, casual: 0 });
    const length = temperamentGuidance({ ...DEFAULT_TEMPERAMENT, exploratory: 1, casual: 0 });
    const register = temperamentGuidance({ ...DEFAULT_TEMPERAMENT, exploratory: 0, casual: 1 });
    expect(length).not.toBe(base);
    expect(register).not.toBe(base);
    expect(length).not.toBe(register);
  });

  it('carries the developer’s own words into the prompt, quoted', () => {
    const guidance = temperamentGuidance({
      ...DEFAULT_TEMPERAMENT,
      personalInstruction: 'Never guess at timings.',
    });
    expect(guidance).toContain('"Never guess at timings."');
  });
});

describe('Temperament — one preference, from two places', () => {
  it('prefers what the developer said about this session', () => {
    expect(
      effectivePreference(
        { ...DEFAULT_TEMPERAMENT, personalInstruction: 'Global rule.' },
        'Only tell me if something looks weird.',
      ),
    ).toBe('Only tell me if something looks weird.');
  });

  it('falls back to the global instruction when the session has none', () => {
    expect(
      effectivePreference({ ...DEFAULT_TEMPERAMENT, personalInstruction: 'Global rule.' }, null),
    ).toBe('Global rule.');
    expect(
      effectivePreference({ ...DEFAULT_TEMPERAMENT, personalInstruction: 'Global rule.' }, '   '),
    ).toBe('Global rule.');
  });

  it('is null when neither exists, so nothing invents a preference', () => {
    expect(effectivePreference(DEFAULT_TEMPERAMENT, null)).toBeNull();
  });
});

describe('Temperament — reaches the model that answers', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  async function askWith(
    temperament: TemperamentProfile | undefined,
  ): Promise<InvestigationInput> {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    let seen: InvestigationInput | null = null;
    const investigator: ObservationLlm = {
      async observeWindow() {
        return { summary: 'not used here' };
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
      ...(temperament ? { temperament: () => temperament } : {}),
    });
    await runner.answer({ sessionId: TEST_SESSION, question: 'Does this break the CLI?' });

    if (!seen) throw new Error('the investigator was never called');
    return seen;
  }

  it('hands the investigator guidance built from the current temperament', async () => {
    const input = await askWith({
      ...DEFAULT_TEMPERAMENT,
      exploratory: 1,
      personalInstruction: 'Never guess at timings.',
    });
    expect(input.guidance).toBe(
      temperamentGuidance({
        ...DEFAULT_TEMPERAMENT,
        exploratory: 1,
        personalInstruction: 'Never guess at timings.',
      }),
    );
    expect(input.guidance).toContain('"Never guess at timings."');
  });

  it('sends no guidance at all when nothing was configured', async () => {
    const input = await askWith(undefined);
    expect(input.guidance).toBeUndefined();
  });

  /** Read per question, so moving a dial changes the next answer. */
  it('reads the temperament at question time rather than at construction', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const seen: (string | undefined)[] = [];
    let current: TemperamentProfile = { ...DEFAULT_TEMPERAMENT, casual: 0 };
    const runner = new DelegatedQuestionRunner({
      store,
      navigator: new ContextNavigator({ store }),
      investigator: {
        async observeWindow() {
          return { summary: 'x' };
        },
        async investigate(input) {
          seen.push(input.guidance);
          return { spokenAnswer: 'a', fullAnswer: 'a', refs: [] };
        },
      },
      temperament: () => current,
    });

    await runner.answer({ sessionId: TEST_SESSION, question: 'one' });
    current = { ...DEFAULT_TEMPERAMENT, casual: 1 };
    await runner.answer({ sessionId: TEST_SESSION, question: 'two' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

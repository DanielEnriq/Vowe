import { describe, expect, it } from 'vitest';

import { JevDecisionRouter, JEV_ENDPOINTS } from '../src/jev-decision-router.js';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(
  answer: unknown,
  captured: Captured[] = [],
  status = 200,
): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: status === 200,
      status,
      json: async () => ({ answers: { q: answer } }),
    };
  }) as unknown as typeof fetch;
}

describe('JevDecisionRouter — request shape', () => {
  it('sends the documented decisions request', async () => {
    const captured: Captured[] = [];
    const router = new JevDecisionRouter({
      apiKey: 'test-key',
      fetchImpl: fakeFetch({ type: 'choice', choice: 'b', confidence: 0.9 }, captured),
    });

    await router.choose({
      state: { anything: true },
      instructions: 'Pick one.',
      criteria: { a: 'the first', b: 'the second' },
    });

    expect(captured[0]!.url).toBe(JEV_ENDPOINTS.openrouter.baseUrl);
    expect(captured[0]!.body).toEqual({
      model: JEV_ENDPOINTS.openrouter.model,
      state: { anything: true },
      questions: {
        q: {
          type: 'choice',
          instructions: 'Pick one.',
          criteria: { a: 'the first', b: 'the second' },
        },
      },
    });
  });

  it('reads each answer primitive', async () => {
    const choice = await new JevDecisionRouter({
      apiKey: 'k',
      fetchImpl: fakeFetch({
        type: 'choice',
        choice: 'speak_now',
        probabilities: { speak_now: 0.8, ignore: 0.2 },
        confidence: 0.77,
      }),
    }).choose({
      state: {},
      instructions: 'x',
      criteria: { speak_now: 'a', ignore: 'b' },
    });
    expect(choice).toEqual({
      choice: 'speak_now',
      confidence: 0.77,
      probabilities: { speak_now: 0.8, ignore: 0.2 },
    });

    const score = await new JevDecisionRouter({
      apiKey: 'k',
      fetchImpl: fakeFetch({ type: 'score', score: 1.6, confidence: 0.5 }),
    }).score({ state: {}, instructions: 'x', levels: ['low', 'high'] });
    expect(score).toMatchObject({ score: 1.6, confidence: 0.5 });

    const noul = await new JevDecisionRouter({
      apiKey: 'k',
      fetchImpl: fakeFetch({ type: 'noul', noul: 0.92 }),
    }).noul({ state: {}, instructions: 'x', criteria: { true: 'y', false: 'n' } });
    expect(noul).toEqual({ noul: 0.92 });
  });

  it('targets the first-party endpoint when asked to', async () => {
    const captured: Captured[] = [];
    await new JevDecisionRouter({
      apiKey: 'k',
      baseUrl: JEV_ENDPOINTS.typesafe.baseUrl,
      model: JEV_ENDPOINTS.typesafe.model,
      fetchImpl: fakeFetch({ type: 'noul', noul: 1 }, captured),
    }).noul({ state: {}, instructions: 'x', criteria: { true: 'y', false: 'n' } });

    expect(captured[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(captured[0]!.body['model']).toBe('jev-latest');
  });
});

describe('JevDecisionRouter — every failure means "decide it yourself"', () => {
  const badCases: [string, () => typeof fetch][] = [
    ['a non-200 response', () => fakeFetch({}, [], 500)],
    [
      'a thrown request',
      () =>
        (async () => {
          throw new Error('network down');
        }) as unknown as typeof fetch,
    ],
    ['an unparseable answer', () => fakeFetch('not an object')],
    ['a missing field', () => fakeFetch({ type: 'choice' })],
  ];

  for (const [name, impl] of badCases) {
    it(`returns null on ${name}`, async () => {
      const router = new JevDecisionRouter({ apiKey: 'k', fetchImpl: impl() });
      const result = await router.choose({
        state: {},
        instructions: 'x',
        criteria: { a: 'a', b: 'b' },
      });
      expect(result).toBeNull();
    });
  }

  it('refuses an option it was never offered', async () => {
    const router = new JevDecisionRouter({
      apiKey: 'k',
      fetchImpl: fakeFetch({ type: 'choice', choice: 'something_else' }),
    });
    const result = await router.choose({
      state: {},
      instructions: 'x',
      criteria: { a: 'a', b: 'b' },
    });
    expect(result).toBeNull();
  });

  it('is unavailable without a credential', () => {
    expect(new JevDecisionRouter({ apiKey: '' }).available).toBe(false);
  });

  it('observes without deciding in shadow mode', async () => {
    const seen: unknown[] = [];
    const router = new JevDecisionRouter({
      apiKey: 'k',
      shadow: true,
      onShadowDecision: (record) => seen.push(record.answer),
      fetchImpl: fakeFetch({ type: 'choice', choice: 'a' }),
    });

    // Reports unavailable, so callers take their own path...
    expect(router.available).toBe(false);
    const result = await router.choose({
      state: {},
      instructions: 'x',
      criteria: { a: 'a' },
    });
    // ...and the answer is recorded rather than obeyed.
    expect(result).toBeNull();
    expect(seen).toEqual([{ type: 'choice', choice: 'a' }]);
  });
});

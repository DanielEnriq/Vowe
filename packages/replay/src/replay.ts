import { AnthropicLlmClient } from '@vowe/llm';
import { JevDecisionRouter } from '@vowe/decision-jev';
import { HeuristicDecisionRouter, type DecisionRouter } from '@vowe/core';

import { replayFixture } from './harness.ts';
import { resolveFromInvocation } from './resolve-path.ts';
import { ScriptedObserver } from './scripted-observer.ts';

/**
 * Replay a recorded trace through the observation harness and print what came
 * out of it.
 *
 *   pnpm replay <fixture.jsonl> [--observer scripted|llm] [--max-events N]
 *                               [--max-tokens N] [--preference "..."]
 *
 * This is how window sizes, observer prompts, decision-model use and surfacing
 * behaviour get tuned: change one thing, run the same fixture, read the diff in
 * the output. With the scripted observer it needs no credentials at all.
 */
async function main(): Promise<void> {
  const [fixtureArg, ...rest] = process.argv.slice(2);
  if (!fixtureArg) {
    console.error(
      'usage: replay <fixture.jsonl> [--observer scripted|llm] [--max-events N] [--max-tokens N] [--preference "..."]',
    );
    process.exitCode = 1;
    return;
  }
  const fixture = resolveFromInvocation(fixtureArg);

  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? undefined : rest[index + 1];
  };

  const mode = flag('observer') ?? 'scripted';
  const preference = flag('preference') ?? 'Only tell me if something looks weird.';

  let observer;
  if (mode === 'llm') {
    const client = AnthropicLlmClient.fromEnvironment();
    if (!client) {
      console.error(
        'No ANTHROPIC_API_KEY or OPENROUTER_API_KEY is set, so --observer llm cannot run. Use the scripted observer instead.',
      );
      process.exitCode = 1;
      return;
    }
    observer = client;
  } else {
    observer = new ScriptedObserver({ surfaceOnRepeatedFailure: true });
  }

  const router: DecisionRouter =
    JevDecisionRouter.fromEnvironment({
      onError: (scope, error) => console.warn(`[jev] ${scope}`, error),
    }) ?? new HeuristicDecisionRouter();

  const windowPolicy: Record<string, number> = {};
  const maxEvents = Number(flag('max-events'));
  if (Number.isFinite(maxEvents)) windowPolicy['maxEvents'] = maxEvents;
  const maxTokens = Number(flag('max-tokens'));
  if (Number.isFinite(maxTokens)) windowPolicy['maxApproxTokens'] = maxTokens;

  const started = Date.now();
  const result = await replayFixture({
    fixture,
    observer,
    router,
    communicationPreference: preference,
    ...(Object.keys(windowPolicy).length ? { windowPolicy } : {}),
  });
  const elapsed = Date.now() - started;

  const windows = result.store.getWindows(result.sessionId);

  console.log(`\nFixture      ${fixtureArg}`);
  console.log(`Observer     ${mode}`);
  console.log(`Decisions    ${router.name}${router.available ? '' : ' (unavailable — deterministic fallbacks)'}`);
  console.log(`Preference   "${preference}"`);
  console.log(
    `Ingested     ${result.recordsRead} records -> ${result.eventsStored} events in ${elapsed}ms`,
  );
  console.log(`Windows      ${windows.length}`);

  console.log('\n--- windows ---');
  for (const window of windows) {
    console.log(
      `[${String(window.index).padStart(3)}] seq ${window.startSeq}-${window.endSeq}  ` +
        `${String(window.eventCount).padStart(3)} events  ~${window.approxTokens} tok  ` +
        `closed by ${window.closedBy}`,
    );
  }

  console.log('\n--- L1 notes ---');
  for (const note of result.store.getWindowNotes(result.sessionId)) {
    console.log(`[${String(note.windowIndex).padStart(3)}] ${note.summary}`);
    if (note.currentActivity) console.log(`      now: ${note.currentActivity}`);
    if (note.notableChange) console.log(`      notable: ${note.notableChange}`);
    console.log(`      refs: ${note.refs.length}${note.investigated ? ' (investigated)' : ''}`);
  }

  const candidates = result.store.getSurfaceUpdates(result.sessionId);
  console.log(`\n--- surface candidates (${candidates.length}) ---`);
  for (const candidate of candidates) {
    console.log(`  ${candidate.urgency.toUpperCase()}  ${candidate.message}`);
    console.log(`         why now: ${candidate.whyNow}`);
    console.log(
      `         decision: ${candidate.decision?.action ?? 'pending'}` +
        `${candidate.decision ? ` (${candidate.decision.source}) — ${candidate.decision.reason}` : ''}`,
    );
  }

  console.log(`\nStore written to ${result.storeRoot}\n`);
}

void main();

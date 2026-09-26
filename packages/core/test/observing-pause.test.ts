import { afterEach, expect, it } from 'vitest';
import { HeuristicInterpreter } from '../src/interpretation/heuristic-interpreter.js';
import { InterpretationRunner } from '../src/interpretation/interpretation-runner.js';
import type { InterpretationInput } from '../src/interpretation/semantic-interpreter.js';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { SemanticState } from '../src/types/session.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Counts every pass that would have reached a model. */
class CountingInterpreter extends HeuristicInterpreter {
  calls = 0;
  override async interpret(input: InterpretationInput): Promise<SemanticState> {
    this.calls++;
    return super.interpret(input);
  }
}

it('a paused session reaches no model; resuming waits for new activity', async () => {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  await f.store.upsertSession(testSession());
  const registry = new SessionRegistry({ store: f.store });
  await registry.start();
  cleanups.push(() => registry.stop());
  const interpreter = new CountingInterpreter();
  const runner = new InterpretationRunner({ registry, store: f.store, interpreter, quietMs: 5, burstEvents: 2 });
  runner.start();
  cleanups.push(async () => runner.stop());
  const event = async (n: number) => {
    const stored = await f.store.appendEvent(TEST_SESSION, {
      sessionId: TEST_SESSION,
      at: '2026-01-01T00:00:00Z',
      kind: 'agent_message',
      summary: `message ${n}`,
      raw: { n },
      rawRef: { source: 'log', byteOffset: n, line: n },
    });
    registry.emit('event', stored!);
  };

  runner.setPaused(() => true);
  for (let n = 0; n < 6; n++) await event(n);
  await runner.refresh(TEST_SESSION);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(interpreter.calls).toBe(0);

  runner.setPaused(() => false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(interpreter.calls).toBe(0);
  await event(6);
  await expect.poll(() => interpreter.calls).toBeGreaterThan(0);
});

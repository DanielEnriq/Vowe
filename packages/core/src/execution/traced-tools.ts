import type { RunHandle } from './run-recorder.js';

/**
 * Record one tool call around the call itself.
 *
 * Wrapped where the tool actually runs, never derived from the model's account
 * of what it did — the same principle `InvestigationRecorder` is built on, and
 * for the same reason: a model can say it opened a file it never opened, and an
 * audit lane that believes it is worse than none.
 *
 * With no run, this is the tool call and nothing else.
 */
export async function tracedTool<T>(
  run: RunHandle | undefined,
  name: string,
  args: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!run) return work();
  run.toolCall({ name, arguments: args });
  try {
    const result = await work();
    run.toolResult({ name, result });
    return result;
  } catch (error) {
    run.toolResult({
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

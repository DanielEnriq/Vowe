import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ObserverToolset,
  ObserveWindowInput,
  ReadOnlyToolset,
  WindowObservation,
} from '@vowe/core';

export interface ScriptedObserverOptions {
  /**
   * Surface a candidate when a window looks like repeated failure.
   *
   * The deterministic stand-in for the judgement an observation model would
   * make. It exists so the surfacing path — candidate, policy, decision,
   * delivery — can be exercised end to end without a credential, and so the
   * test that covers it fails for a real reason rather than because a model
   * phrased something differently today.
   */
  surfaceOnRepeatedFailure?: boolean;
  /** Called on every window, for assertions and for the CLI's output. */
  onObserve?: (input: ObserveWindowInput) => void;
  /** Milliseconds to stall each observation, for exercising concurrency. */
  delayMs?: number;
}

/**
 * A deterministic stand-in for the observation model.
 *
 * Replay has two jobs, and they want different backends. Tuning prompts and
 * window sizes wants the real model. Testing that windows are ordered, that the
 * cursor resumes, that a candidate reaches the policy — all of that wants an
 * observer whose output is a function of its input. This is the second one.
 */
export class ScriptedObserver implements ObservationLlm {
  private readonly options: ScriptedObserverOptions;

  constructor(options: ScriptedObserverOptions = {}) {
    this.options = options;
  }

  async observeWindow(
    input: ObserveWindowInput,
    tools: ObserverToolset,
  ): Promise<WindowObservation> {
    this.options.onObserve?.(input);
    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    const events = input.window.events;
    const failures = events.filter(
      (event) =>
        event.kind === 'test_finished' &&
        /fail/i.test(`${event.summary} ${event.detail ?? ''}`),
    );
    const edits = events.filter((event) => event.kind === 'file_changed');

    const kinds = new Map<string, number>();
    for (const event of events) {
      kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    }
    const shape = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${count}×${kind}`)
      .join(', ');

    const observation: WindowObservation = {
      summary: `Window ${input.window.windowIndex}: ${events.length} events (${shape}).`,
      currentActivity: events[events.length - 1]?.summary ?? 'nothing observed',
    };

    if (failures.length) {
      observation.notableChange = `${failures.length} failing test run(s) after ${edits.length} edit(s).`;
    }

    if (this.options.surfaceOnRepeatedFailure && failures.length >= 2) {
      await tools.surfaceUpdate({
        message:
          'It has tried several variations of the same fix and is still hitting the same failing assertion.',
        whyNow: `${failures.length} runs of the same test have failed in a row, each after another edit.`,
        refs: [
          `trace:${input.sessionId}:${input.window.startSeq}-${input.window.endSeq}`,
        ],
        urgency: 'high',
      });
    }

    return observation;
  }

  async investigate(
    input: InvestigationInput,
    tools: ReadOnlyToolset,
  ): Promise<DelegatedAnswer> {
    // Search, then zoom in — the same shape a real investigation takes, so the
    // delegated path is genuinely exercised rather than stubbed past.
    const hits = await tools.searchContext({
      query: input.question,
      sources: ['trace', 'windows', 'transcript'],
      limit: 5,
    });

    const opened = hits[0]
      ? await tools.openContext({ ref: hits[0].refId, depth: 'full' })
      : null;

    const spokenAnswer = hits.length
      ? `I found ${hits.length} place${hits.length === 1 ? '' : 's'} in the trace matching that — the closest is ${hits[0]!.label}.`
      : 'I could not find anything in this session about that.';

    const fullAnswer = [
      `Question: ${input.question}`,
      '',
      hits.length ? 'Matches:' : 'No matches in the observed session.',
      ...hits.map((hit) => `- ${hit.refId} — ${hit.label}: ${hit.snippet}`),
      ...(opened && !opened.notFound ? ['', 'Opened:', opened.content] : []),
    ].join('\n');

    return {
      spokenAnswer,
      fullAnswer,
      refs: hits.map((hit) => hit.ref),
    };
  }
}

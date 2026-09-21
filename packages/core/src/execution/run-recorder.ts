import { randomUUID } from 'node:crypto';

import type { ModelTrace } from '../llm/model-trace.js';
import type { EventStore } from '../store/event-store.js';
import type {
  ModelUsage,
  VoweRun,
  VoweRunStatus,
  VoweTraceItem,
} from '../types/execution.js';

export interface VoweRunRecorderOptions {
  store: EventStore;
  /**
   * Where a failed write goes. An audit lane that can fail the work it audits
   * is worse than no audit lane, so nothing here throws at the caller.
   */
  onError?: (scope: string, error: unknown) => void;
}

/** What is known when a run begins. The rest is learned as it goes. */
export type RunStart = Omit<VoweRun, 'id' | 'status' | 'startedAt' | 'completedAt'>;

/**
 * One execution in progress.
 *
 * It is a `ModelTrace`, so a model adapter can be handed the handle itself and
 * report into it without knowing anything about runs, sessions or the store.
 */
export interface RunHandle extends ModelTrace {
  readonly runId: string;
  complete(result?: {
    outputEntryId?: string;
    usage?: ModelUsage;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * The work was abandoned — interrupted, superseded, shut down.
   *
   * Still takes an output entry: a response the user talked over produced a
   * real turn, and losing the link between them would make the partial answer
   * an orphan.
   */
  cancel(result?: {
    outputEntryId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  /** It ended badly. Everything traced before the failure is still kept. */
  failed(
    error: unknown,
    result?: { outputEntryId?: string; metadata?: Record<string, unknown> },
  ): Promise<void>;
}

/**
 * Opens runs and closes them.
 *
 * The run row is written immediately, with status `started`; the trace is
 * buffered and flushed with the final status in one transaction. That split is
 * deliberate. Writing the row up front means a run that was in flight when Vowe
 * stopped stays visible afterwards as exactly that — a run nobody ever finished
 * — which is the same honesty `ConversationDelivery.started` already provides.
 * Buffering the items means one commit instead of a dozen on the hot path, and
 * it is why every sink method can be synchronous: recording what a model did
 * must never be able to slow down the answer a person is waiting for.
 *
 * A crash mid-run therefore keeps the run and loses its trace. That is the
 * right trade for a record of work: the fact that the work happened and never
 * finished is the part worth surviving.
 */
export class VoweRunRecorder {
  private readonly store: EventStore;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: VoweRunRecorderOptions) {
    this.store = options.store;
    this.onError = options.onError ?? (() => undefined);
  }

  begin(start: RunStart): RunHandle {
    const run: VoweRun = {
      ...start,
      id: randomUUID(),
      status: 'started',
      startedAt: new Date().toISOString(),
    };
    return new BufferedRun(run, this.store, this.onError);
  }
}

class BufferedRun implements RunHandle {
  readonly runId: string;
  private readonly store: EventStore;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly items: Omit<VoweTraceItem, 'runId' | 'ord'>[] = [];
  /** Writes stay in order without a lock: each awaits the one before it. */
  private writing: Promise<void>;
  private usage: ModelUsage | undefined;
  private provider: string | undefined;
  private model: string | undefined;
  private finished = false;

  constructor(
    run: VoweRun,
    store: EventStore,
    onError: (scope: string, error: unknown) => void,
  ) {
    this.runId = run.id;
    this.store = store;
    this.onError = onError;
    this.writing = store
      .appendRun(run)
      .catch((error) => this.onError('run:begin', error));
  }

  input(
    payload: unknown,
    options: { text?: string; provider?: string; model?: string } = {},
  ): void {
    if (options.provider) this.provider = options.provider;
    if (options.model) this.model = options.model;
    this.push('model_input', options.text, payload);
  }

  reasoning(item: {
    text?: string;
    summary: boolean;
    payload?: unknown;
    providerItemId?: string;
  }): void {
    this.push(
      item.summary ? 'reasoning_summary' : 'reasoning',
      item.text,
      item.payload,
      item.providerItemId,
    );
  }

  toolCall(item: {
    name: string;
    arguments?: unknown;
    providerItemId?: string;
  }): void {
    this.push(
      'tool_call',
      item.name,
      { name: item.name, arguments: item.arguments },
      item.providerItemId,
    );
  }

  toolResult(item: {
    name: string;
    result?: unknown;
    error?: string;
    providerItemId?: string;
  }): void {
    this.push(
      'tool_result',
      item.name,
      item.error === undefined
        ? { name: item.name, result: item.result }
        : { name: item.name, error: item.error },
      item.providerItemId,
    );
  }

  output(item: { text?: string; payload?: unknown; usage?: ModelUsage }): void {
    // An empty object is what a provider that reported no counters looks like
    // after normalization, and storing it would claim a measurement nobody made.
    if (item.usage && Object.keys(item.usage).length) this.usage = item.usage;
    this.push('model_output', item.text, item.payload);
  }

  error(error: unknown): void {
    this.push('error', messageOf(error));
  }

  async complete(
    result: {
      outputEntryId?: string;
      usage?: ModelUsage;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.finish('completed', result);
  }

  async cancel(
    result: { outputEntryId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.finish('cancelled', result);
  }

  async failed(
    error: unknown,
    result: { outputEntryId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    this.error(error);
    await this.finish('error', result);
  }

  private push(
    kind: VoweTraceItem['kind'],
    text?: string,
    payload?: unknown,
    providerItemId?: string,
  ): void {
    // Finished is finished. A late report belongs to no run and is dropped
    // rather than appended after the status that says the work was over.
    if (this.finished) return;
    this.items.push({
      id: randomUUID(),
      kind,
      at: new Date().toISOString(),
      ...(text === undefined ? {} : { text }),
      ...(payload === undefined ? {} : { payload }),
      ...(providerItemId === undefined ? {} : { providerItemId }),
    });
  }

  private async finish(
    status: VoweRunStatus,
    result: {
      outputEntryId?: string;
      usage?: ModelUsage;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const items = this.items.splice(0, this.items.length);
    const usage = result.usage ?? this.usage;

    this.writing = this.writing
      .then(async () => {
        await this.store.appendTraceItems(this.runId, items);
        await this.store.finishRun(this.runId, {
          status,
          completedAt: new Date().toISOString(),
          ...(this.provider ? { provider: this.provider } : {}),
          ...(this.model ? { model: this.model } : {}),
          ...(usage ? { usage } : {}),
          ...(result.outputEntryId ? { outputEntryId: result.outputEntryId } : {}),
          ...(result.metadata ? { metadata: result.metadata } : {}),
        });
      })
      .catch((error) => this.onError('run:finish', error));

    await this.writing;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CommunicationPolicy,
  ContextNavigator,
  DelegatedQuestionRunner,
  HeuristicDecisionRouter,
  SqliteEventStore,
  ObserverRunner,
  type AgentSession,
  type DecisionRouter,
  type LlmClient,
  type ObservationLlm,
  type SurfaceUpdate,
  type WindowNote,
  type WindowPolicy,
} from '@vowe/core';

import { fixtureSession, ingestTranscript } from './ingest.ts';

export interface ReplayHarnessOptions {
  fixture: string;
  observer: ObservationLlm;
  sessionId?: string;
  /** Working directory the session is treated as having, for repo/diff tools. */
  cwd?: string | null;
  task?: string | null;
  windowPolicy?: Partial<WindowPolicy>;
  router?: DecisionRouter;
  /** Used by the communication policy when no decision router answers. */
  llm?: LlmClient;
  communicationPreference?: string | null;
  storeRoot?: string;
  maxRecords?: number;
}

export interface ReplayResult {
  sessionId: string;
  storeRoot: string;
  store: SqliteEventStore;
  navigator: ContextNavigator;
  runner: ObserverRunner;
  delegated: DelegatedQuestionRunner;
  recordsRead: number;
  eventsStored: number;
  notes: WindowNote[];
  surfaceUpdates: SurfaceUpdate[];
}

/**
 * Run a recorded trace through the whole observation harness.
 *
 * This is the path the acceptance tests use and the path prompt and
 * window-size tuning will use. It deliberately builds the *real* components —
 * the real store on a real temporary directory, the real window builder, the
 * real observer runner, the real navigator — and varies only the observation
 * model. A harness that stubbed the parts under test would prove nothing.
 *
 * Nothing here reads `~/.claude`, and nothing here starts a coding agent.
 */
export async function replayFixture(
  options: ReplayHarnessOptions,
): Promise<ReplayResult> {
  const storeRoot =
    options.storeRoot ?? (await mkdtemp(path.join(os.tmpdir(), 'vowe-replay-')));
  const sessionId = options.sessionId ?? 'claude-code:replay-fixture';

  const store = new SqliteEventStore(storeRoot);
  await store.init();

  const session: AgentSession = fixtureSession(sessionId, {
    cwd: options.cwd ?? null,
    task: options.task ?? null,
  });
  await store.upsertSession(session);

  const { recordsRead, eventsStored } = await ingestTranscript({
    file: options.fixture,
    sessionId,
    store,
    ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
  });

  const navigator = new ContextNavigator({
    store,
    resolveCwd: () => options.cwd ?? null,
  });

  const notes: WindowNote[] = [];
  const surfaceUpdates: SurfaceUpdate[] = [];
  const router = options.router ?? new HeuristicDecisionRouter();

  const policy = new CommunicationPolicy({
    router,
    ...(options.llm ? { llm: options.llm } : {}),
  });

  const runner = new ObserverRunner({
    sessionId,
    store,
    observer: options.observer,
    navigator,
    router,
    getSession: () => store.getSession(sessionId),
    ...(options.windowPolicy ? { policy: options.windowPolicy } : {}),
    onNote: (note) => notes.push(note),
    onSurfaceUpdate: (update) => {
      surfaceUpdates.push(update);
      // Replay evaluates candidates inline rather than through
      // ObservationService, so a fixture run exercises the policy too.
      void policy
        .evaluate(update, options.communicationPreference ?? null)
        .then((decision) =>
          store.recordCommunicationDecision(sessionId, update.id, decision),
        );
    },
  });

  if (options.communicationPreference !== undefined) {
    await runner.setCommunicationPreference(options.communicationPreference);
  }

  // `closeTail: true` because a fixture is a finished trace: the last partial
  // window is real work and must not be dropped just because nothing follows.
  await runner.catchUp({ closeTail: true });

  const delegated = new DelegatedQuestionRunner({
    store,
    navigator,
    investigator: options.observer,
  });

  return {
    sessionId,
    storeRoot,
    store,
    navigator,
    runner,
    delegated,
    recordsRead,
    eventsStored,
    notes,
    surfaceUpdates: store.getSurfaceUpdates(sessionId),
  };
}

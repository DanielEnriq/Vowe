import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, dialog, ipcMain, nativeTheme } from 'electron';

import { loadLocalEnv } from './env.js';

// Before anything reads a credential. Every key Vowe takes is optional, so a
// missing or malformed file degrades exactly like an empty environment.
const envFile = loadLocalEnv();

import {
  ArtifactResolver,
  CommunicationPolicy,
  CompanionService,
  ContextNavigator,
  DelegatedQuestionRunner,
  HeuristicDecisionRouter,
  HeuristicInterpreter,
  InterpretationRunner,
  LiveBridge,
  LlmSemanticInterpreter,
  SqliteEventStore,
  ObservationService,
  ConservativeMemoryAdmission,
  describeObservedState,
  PresenceProfileStore,
  ProjectBriefService,
  ProjectKnowledgeService,
  ProjectMemoryStore,
  ProjectService,
  SessionRegistry,
  UserProfileStore,
  UnavailableLiveTransport,
  VoweRunRecorder,
  type DecisionRouter,
  type LiveTransport,
  type SemanticInterpreter,
} from '@vowe/core';
import { ClaudeCodeAdapter, PROVIDER } from '@vowe/adapter-claude-code';
import { createGraphifyKnowledge } from '@vowe/knowledge-graphify';
import { AnthropicLlmClient } from '@vowe/llm';
import { JevDecisionRouter } from '@vowe/decision-jev';
import { OpenAiLiveTransport } from '@vowe/live-openai';

import { IPC, type AppStatus, type AskResult, type ObservationView } from '../shared/ipc.js';
import type {
  ContextRef,
  PlaybackReport,
  PresenceProfile,
  UserProfile,
} from '@vowe/core';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Renderer input, so shaped rather than assumed. Anything else is dropped. */
function readPlaybackReport(value: unknown): PlaybackReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const report = value as { kind?: unknown; at?: unknown; audioMs?: unknown };
  if (typeof report.at !== 'string') return null;
  if (report.kind === 'started') return { kind: 'started', at: report.at };
  if (report.kind === 'lost') return { kind: 'lost', at: report.at };
  if (report.kind !== 'stopped') return null;
  return {
    kind: 'stopped',
    at: report.at,
    ...(typeof report.audioMs === 'number' && Number.isFinite(report.audioMs)
      ? { audioMs: Math.max(0, Math.round(report.audioMs)) }
      : {}),
  };
}

interface Services {
  store: SqliteEventStore;
  registry: SessionRegistry;
  projects: ProjectService;
  knowledge: ProjectKnowledgeService;
  /** The Project Room's read model. Derived on every read, never stored. */
  brief: ProjectBriefService;
  /** Every model call Vowe makes on its own behalf, recorded and announced. */
  runs: VoweRunRecorder;
  /** Vowe's one identity, and the developer's. Global, not per session. */
  profile: UserProfileStore;
  presence: PresenceProfileStore;
  companion: CompanionService;
  /** Resolves a ContextRef into something the renderer can display. */
  workbench: ArtifactResolver;
  /** The one grounded investigator. Typed questions and Vo both arrive here. */
  delegated: DelegatedQuestionRunner;
  runner: InterpretationRunner;
  observation: ObservationService;
  live: LiveBridge;
  status: AppStatus;
}

let services: Services | null = null;
/**
 * Resolved once wiring is complete. IPC handlers await it rather than failing,
 * so the window can paint immediately while the first discovery pass runs.
 */
let servicesReady: Promise<Services> | null = null;
let window: BrowserWindow | null = null;

/**
 * Wires the application together.
 *
 * Note what is handed to what. There is exactly one `DelegatedQuestionRunner`,
 * and both ways of asking a question reach it: `CompanionService` for typed
 * questions and `LiveBridge` for ones delegated from Vo. One instance means one
 * set of read tools, one `onAnswer` hook into project memory, and no way for
 * the two modalities to drift apart.
 *
 * It gets a store and a navigator. It never sees the registry or an adapter, so
 * a question asked of Vowe has no path to the coding agent even by accident.
 */
async function createServices(): Promise<Services> {
  if (envFile) console.log(`[vowe] loaded configuration from ${envFile}`);
  const storeRoot = path.join(app.getPath('userData'), 'vowe');
  const store = new SqliteEventStore(storeRoot, {
    onError: (scope, error) => console.warn(`[vowe] store:${scope}`, error),
  });
  await store.init();

  // What Vowe's own models did, kept beside what Vowe said. One recorder,
  // handed to every model caller, so "which execution produced this?" has one
  // answer and not one per subsystem.
  const runs = new VoweRunRecorder({
    store,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });

  const llm = AnthropicLlmClient.fromEnvironment();
  const interpreter: SemanticInterpreter = llm
    ? new LlmSemanticInterpreter(
        llm,
        (error) => console.error('[vowe] interpretation failed', error),
        runs,
      )
    : new HeuristicInterpreter();

  // Projects group sessions by the repository they are working in. Vowe
  // product state, not a provider concept — the adapter reports `cwd` and
  // knows nothing about this.
  const projects = new ProjectService({
    store,
    listSessions: () => registry.list(),
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });

  const registry: SessionRegistry = new SessionRegistry({
    store,
    projects,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });
  registry.registerAdapter(
    new ClaudeCodeAdapter({
      onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
    }),
  );

  const runner = new InterpretationRunner({
    registry,
    store,
    interpreter,
    onError: (error) => console.error('[vowe] interpretation runner', error),
  });
  runner.start();

  // Structured decisions. Constructed here because project knowledge needs it
  // to decide what is worth remembering.
  const router: DecisionRouter =
    JevDecisionRouter.fromEnvironment({
      onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
    }) ?? new HeuristicDecisionRouter();

  // ------------------------------------------------------- project knowledge

  // What each repository contains, kept in Vowe's own directory and never in
  // the user's checkout. Optional in the same way every credential is: absent,
  // repository search is `git grep` and nothing else changes.
  const { provider: knowledgeProvider, mirror } = await createGraphifyKnowledge({
    resolveProject: (projectId) => store.getProject(projectId),
    dataDirFor: (projectId) => store.projectDataDir(projectId),
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
    onStateChange: (state) => {
      window?.webContents.send(IPC.projectKnowledgeChanged, state.projectId);
    },
  });
  if (!knowledgeProvider.available) {
    console.log(`[vowe] code knowledge unavailable — ${knowledgeProvider.unavailableReason}`);
  }

  // What Vowe has learned, as opposed to what the repository contains. Vowe
  // owns this: the mirror keeps Graphify's own lessons file in step, but the
  // record here outlives Graphify being removed.
  const knowledge = new ProjectKnowledgeService({
    provider: knowledgeProvider,
    memory: new ProjectMemoryStore({
      dataDirFor: (projectId) => store.projectDataDir(projectId),
      mirror,
      onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
    }),
    // Conservative, and it fails closed: with no decision model, corrections
    // are recorded and nothing else is.
    admission: new ConservativeMemoryAdmission({
      router,
      onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
    }),
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });

  // What one repository's work adds up to. A projection over the sessions,
  // their trace, observation output and index state — assembled here so the
  // renderer stops recomputing project synthesis from several stores at once.
  // Deliberately not a project agent: nothing below calls a model.
  const brief = new ProjectBriefService({
    store,
    sessionsFor: (projectId) => projects.getSessions(projectId),
    knowledge,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });

  // Two small settings files beside sessions.json and projects.json. One Vowe
  // identity for the whole application: presence never lives inside a session
  // or a project, because it is not a property of either.
  const profile = new UserProfileStore({
    root: storeRoot,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });
  const presence = new PresenceProfileStore({
    root: storeRoot,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });

  // ------------------------------------------------------ observation harness

  // One read-only view of everything Vowe can see, shared unchanged by the
  // observer following the work and by the runner answering questions about it.
  const navigator = new ContextNavigator({
    store,
    resolveCwd: (sessionId) => registry.get(sessionId)?.cwd ?? null,
    resolveProject: (sessionId) => registry.get(sessionId)?.projectId ?? null,
    knowledge,
  });

  // One reference, resolved into something a person can look at. A projection
  // over the navigator and the stores — it opens no file of its own, which is
  // what keeps an artifact and the answer that cited it from disagreeing.
  const workbench = new ArtifactResolver({
    navigator,
    store,
    memory: knowledge,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });

  const liveTransport: LiveTransport = process.env.OPENAI_API_KEY
    ? new OpenAiLiveTransport({
        onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
      })
    : new UnavailableLiveTransport(
        'No OPENAI_API_KEY is configured, so Vo cannot join by voice. Observation is unaffected.',
      );

  // The observation model is optional in exactly the way the interpretation
  // model already was: without it, windows and notes cannot be produced, but
  // nothing else in the application changes.
  const observation = new ObservationService({
    store,
    registry,
    observer: llm ?? nullObserver(store),
    navigator,
    policy: new CommunicationPolicy({
      router,
      ...(llm ? { llm } : {}),
      runs,
      onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
    }),
    router,
    runs,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });

  // The one grounded investigator, constructed once and shared. A question
  // typed into Vowe and the same question asked out loud run through this
  // object, so they cannot diverge in what they can look at or in what they
  // leave behind.
  const delegated = new DelegatedQuestionRunner({
    store,
    navigator,
    investigator: llm ?? nullObserver(store),
    runs,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
    // After the answer is delivered, never during. Most answers are not kept.
    // Text and voice share this hook; nothing about admission asks which it was.
    onAnswer: (result) => {
      const projectId = registry.get(result.entry.sessionId)?.projectId;
      if (!projectId) return;
      void knowledge
        .consider({
          projectId,
          question: result.question,
          answer: result.fullAnswer,
          refs: result.refs,
        })
        .catch((error) => console.warn('[vowe] knowledge:consider', error));
    },
  });

  const companion = new CompanionService({ store, delegated });

  const live = new LiveBridge({
    transport: liveTransport,
    observation,
    delegated,
    // With these, a spoken conversation is history rather than a session that
    // evaporates when the call ends.
    store,
    runs,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });

  // Every conversation write converges on the store, so this one subscription
  // covers a typed answer, an answer delegated from Vo, and an instruction and
  // its result — including the last of those, which notified nothing before.
  store.onConversationChanged((change) => {
    window?.webContents.send(IPC.conversationChanged, change);
  });

  observation.on('note', (note) => {
    window?.webContents.send(IPC.observationChanged, note.sessionId);
  });
  observation.on('surface', (update) => {
    window?.webContents.send(IPC.observationChanged, update.sessionId);
  });
  live.on('status', (status) => {
    window?.webContents.send(IPC.liveStatusChanged, status);
  });
  // What Vowe is executing, published from the lane that already records it.
  runs.on('activity', (activity) => {
    window?.webContents.send(IPC.runActivityChanged, activity);
  });
  live.on('answered', (answered) => {
    // A delegated answer is persisted as a conversation entry, so the session
    // view has something new to show.
    window?.webContents.send(IPC.observationChanged, answered.sessionId);
  });

  registry.on('session:added', broadcastSessions);
  registry.on('session:updated', broadcastSessions);
  registry.on('session:removed', broadcastSessions);
  registry.on('event', (event) => {
    window?.webContents.send(IPC.sessionEvent, event);
    // Vowe needs no filesystem watcher: the workers it observes are the ones
    // doing the editing, and the adapters already normalize that into an event.
    if (event.kind === 'file_changed') {
      const projectId = registry.get(event.sessionId)?.projectId;
      if (projectId) knowledge.noteSourceChange(projectId);
    }
  });

  await registry.start();

  return {
    store,
    registry,
    runs,
    projects,
    knowledge,
    brief,
    profile,
    presence,
    companion,
    workbench,
    delegated,
    runner,
    observation,
    live,
    status: {
      llmConfigured: llm !== undefined,
      voiceConfigured: liveTransport.available,
      voiceUnavailableReason: liveTransport.unavailableReason,
      decisionsConfigured: router.available,
      codeKnowledgeConfigured: knowledgeProvider.available,
      codeKnowledgeUnavailableReason: knowledgeProvider.unavailableReason ?? null,
      storeRoot,
      providers: [PROVIDER],
    },
  };
}

/**
 * The observation model when none is configured.
 *
 * The two halves degrade differently, and deliberately so. **Observation** needs
 * a model in a way interpretation does not — there is no deterministic prose
 * that could stand in for having understood a window — so it says so plainly,
 * once per window, rather than pretending. **A question** does have a floor:
 * the session's phase, its current activity and its last few observed events.
 * That is not an answer, but it is what Ask Vowe has always fallen back to, and
 * it is far more use than repeating that nothing is configured.
 */
function nullObserver(store: SqliteEventStore): import('@vowe/core').ObservationLlm {
  return {
    async observeWindow() {
      return {
        summary:
          'No model is configured, so this window was recorded but not interpreted. Its trace range is still addressable.',
      };
    },
    async investigate(input) {
      // A project question has no session to describe, so it reports the
      // roster it was given rather than pretending to have looked at a trace.
      const observed =
        'projectId' in input
          ? input.sessions.length
            ? input.sessions
                .map(
                  (session) =>
                    `- ${session.label} (${session.status})${
                      session.currentActivity ? `: ${session.currentActivity}` : ''
                    }`,
                )
                .join('\n')
            : 'No sessions have run in this project yet.'
          : describeObservedState(
              store.getSession(input.sessionId)?.semanticState ?? null,
              store.getEvents(input.sessionId, { limit: 80 }),
            );

      return {
        spokenAnswer:
          'No model is configured, so I can only report what I observed directly.',
        fullAnswer: `No model is configured, so I could not investigate the question. Here is what I have observed:\n\n${observed}`,
        refs: [],
      };
    },
  };
}

function broadcastSessions(): void {
  window?.webContents.send(IPC.sessionsChanged);
}

async function requireServices(): Promise<Services> {
  if (services) return services;
  if (!servicesReady) throw new Error('Vowe is not starting up.');
  return servicesReady;
}

function registerIpc(): void {
  ipcMain.handle(IPC.status, async () => (await requireServices()).status);
  ipcMain.handle(IPC.listSessions, async () =>
    (await requireServices()).registry.list(),
  );
  ipcMain.handle(IPC.listProjects, async () =>
    (await requireServices()).projects.listProjectsForDisplay(),
  );
  ipcMain.handle(IPC.getSession, async (_event, sessionId: string) =>
    (await requireServices()).registry.get(sessionId),
  );
  ipcMain.handle(
    IPC.getEvents,
    async (_event, sessionId: string, limit?: number) =>
      (await requireServices()).store.getEvents(sessionId, {
        limit: limit ?? 400,
      }),
  );
  ipcMain.handle(
    IPC.getEventsByIds,
    async (_event, sessionId: string, ids: string[]) =>
      (await requireServices()).store.getEventsByIds(sessionId, ids),
  );
  ipcMain.handle(IPC.getConversation, async (_event, sessionId: string) =>
    (await requireServices()).companion.getConversation(sessionId),
  );
  ipcMain.handle(IPC.refreshInterpretation, async (_event, sessionId: string) =>
    (await requireServices()).runner.refresh(sessionId),
  );

  // Reads persisted index state. Deliberately not `ensureIndexed`: opening a
  // room should not commit the machine to indexing the repository.
  ipcMain.handle(IPC.getProjectKnowledge, async (_event, projectId: string) =>
    (await requireServices()).knowledge.describe(projectId),
  );

  // Rebuilt from current state on every call. There is no cache to invalidate
  // because there is nothing stored: the room asks again when the sessions,
  // observation or index state change, and gets a brief that cannot disagree
  // with them.
  ipcMain.handle(IPC.getProjectBrief, async (_event, projectId: string) =>
    (await requireServices()).brief.get(projectId),
  );

  // ---------------------------------------------------------------- identity

  ipcMain.handle(IPC.getUserProfile, async () =>
    (await requireServices()).profile.get(),
  );
  ipcMain.handle(IPC.setUserProfile, async (_event, next: UserProfile) =>
    (await requireServices()).profile.set(next),
  );
  ipcMain.handle(IPC.getPresenceProfile, async () =>
    (await requireServices()).presence.get(),
  );
  ipcMain.handle(IPC.setPresenceProfile, async (_event, next: PresenceProfile) =>
    (await requireServices()).presence.set(next),
  );
  ipcMain.handle(IPC.getRunActivity, async () => (await requireServices()).runs.activity);

  // Grounded by going and looking — the same investigator Vo delegates to, with
  // the same three read tools. Still deliberately has no adapter in reach.
  //
  // `spokenAnswer` is dropped here rather than ignored in the renderer. The
  // short form exists for a voice channel, and making it structurally
  // unavailable to the typed UI is cheaper than a convention about not using it.
  ipcMain.handle(
    IPC.ask,
    async (_event, sessionId: string, question: string): Promise<AskResult> => {
      const result = await (await requireServices()).companion.ask(sessionId, question);
      return { entry: result.entry, refs: result.refs, failed: result.failed };
    },
  );

  // The generic artifact open. `ContextNavigator` itself stays off the bridge:
  // the renderer gets display projections, never the read toolset.
  ipcMain.handle(IPC.openArtifact, async (_event, ref: ContextRef) =>
    (await requireServices()).workbench.resolve(ref),
  );

  // The control channel. Separate handler, separate service, separate button.
  ipcMain.handle(
    IPC.sendInstruction,
    async (_event, sessionId: string, text: string) =>
      (await requireServices()).registry.sendInstruction(sessionId, text),
  );

  ipcMain.handle(IPC.launch, async (_event, cwd: string, prompt: string) =>
    (await requireServices()).registry.launchSession(PROVIDER, { cwd, prompt }),
  );

  // ------------------------------------------------------------- observation

  ipcMain.handle(IPC.startObserving, async (_event, sessionId: string) =>
    (await requireServices()).observation.start(sessionId),
  );
  ipcMain.handle(IPC.stopObserving, async (_event, sessionId: string) => {
    (await requireServices()).observation.stop(sessionId);
  });
  ipcMain.handle(
    IPC.getObservation,
    async (_event, sessionId: string): Promise<ObservationView> => {
      const { store, observation } = await requireServices();
      return {
        status: observation.status(sessionId),
        windows: store.getWindows(sessionId),
        notes: store.getWindowNotes(sessionId),
        surfaceUpdates: store.getSurfaceUpdates(sessionId),
      };
    },
  );
  ipcMain.handle(
    IPC.setPreference,
    async (_event, sessionId: string, preference: string | null) =>
      (await requireServices()).observation.setCommunicationPreference(
        sessionId,
        preference,
      ),
  );

  // --------------------------------------------------------------------- Vo

  // The renderer owns the microphone and the audio. This handler exists only
  // because the SDP exchange needs the credential, and the credential must not
  // reach a browser context.
  ipcMain.handle(
    IPC.startLive,
    async (_event, sessionId: string, sdpOffer: string) =>
      (await requireServices()).live.start(sessionId, sdpOffer),
  );
  ipcMain.handle(IPC.stopLive, async () => {
    await (await requireServices()).live.stop();
  });
  ipcMain.handle(IPC.liveStatus, async () => (await requireServices()).live.status);

  // One-way, and unawaited: the renderer is reporting what it measured, not
  // asking for anything. It is also the only IPC message that originates in the
  // renderer as a fact rather than a request, so it is validated here rather
  // than trusted — the main process decides what a measurement means.
  ipcMain.on(IPC.livePlayback, (_event, report: unknown) => {
    const playback = readPlaybackReport(report);
    if (!playback) return;
    void requireServices()
      .then((services) => services.live.reportPlayback(playback))
      .catch((error) => console.error('[vowe] live:playback', error));
  });
  ipcMain.handle(IPC.chooseFolder, async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    title: 'Vowe',
    // Matches --win in the renderer so there is no flash before first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#ffffff',
    // The sidebar runs to the top edge; the traffic lights sit in its first 52px.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    window = null;
  });
}

/**
 * The presence preview, in a window of its own.
 *
 * Development only, opened by `pnpm --filter @vowe/desktop dev:presence`. It
 * renders the real component across every state and size in the real Chromium
 * this application ships with, which is the only place looking at it proves
 * anything. It gets no preload: there is nothing for it to ask the backend.
 */
function createPresencePreviewWindow(): void {
  const preview = new BrowserWindow({
    width: 1180,
    height: 900,
    title: 'Vowe Presence — preview',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#ffffff',
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void preview.loadURL(`${devServer}/presence-preview.html`);
  else void preview.loadFile(path.join(dirname, '../renderer/presence-preview.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  if (process.env.VOWE_PRESENCE_PREVIEW === '1') createPresencePreviewWindow();
  servicesReady = createServices();
  try {
    services = await servicesReady;
    broadcastSessions();
  } catch (error) {
    console.error('[vowe] failed to start services', error);
    // A store that would not open is not a degraded Vowe, it is a Vowe with no
    // memory — and a schema migration that failed is the one startup error a
    // person can actually act on. Say so rather than leaving an empty window.
    dialog.showErrorBox(
      'Vowe could not open its local database',
      error instanceof Error ? error.message : String(error),
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void services?.registry.stop();
  services?.runner.stop();
  services?.observation.stopAll();
  void services?.live.stop();
  // Last: everything above may still be writing. Closing the database
  // checkpoints the write-ahead log and releases the file.
  void services?.store.close();
});

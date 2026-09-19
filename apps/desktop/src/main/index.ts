import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, dialog, ipcMain, nativeTheme } from 'electron';

import { loadLocalEnv } from './env.js';

// Before anything reads a credential. Every key Vowe takes is optional, so a
// missing or malformed file degrades exactly like an empty environment.
const envFile = loadLocalEnv();

import {
  CommunicationPolicy,
  CompanionService,
  ContextNavigator,
  DelegatedQuestionRunner,
  HeuristicDecisionRouter,
  HeuristicInterpreter,
  InterpretationRunner,
  LiveBridge,
  LlmSemanticInterpreter,
  NdjsonEventStore,
  ObservationService,
  SessionRegistry,
  UnavailableLiveTransport,
  type DecisionRouter,
  type LiveTransport,
  type SemanticInterpreter,
} from '@vowe/core';
import { ClaudeCodeAdapter, PROVIDER } from '@vowe/adapter-claude-code';
import { AnthropicLlmClient } from '@vowe/llm';
import { JevDecisionRouter } from '@vowe/decision-jev';
import { OpenAiLiveTransport } from '@vowe/live-openai';

import { IPC, type AppStatus, type ObservationView } from '../shared/ipc.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

interface Services {
  store: NdjsonEventStore;
  registry: SessionRegistry;
  companion: CompanionService;
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
 * Note what is handed to what: the companion gets the store and (optionally)
 * an LLM. It never sees the registry or an adapter, so a question asked of
 * Vowe has no path to the coding agent even by accident.
 */
async function createServices(): Promise<Services> {
  if (envFile) console.log(`[vowe] loaded configuration from ${envFile}`);
  const storeRoot = path.join(app.getPath('userData'), 'vowe');
  const store = new NdjsonEventStore(storeRoot);
  await store.init();

  const llm = AnthropicLlmClient.fromEnvironment();
  const interpreter: SemanticInterpreter = llm
    ? new LlmSemanticInterpreter(llm, (error) =>
        console.error('[vowe] interpretation failed', error),
      )
    : new HeuristicInterpreter();

  const registry = new SessionRegistry({
    store,
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

  const companion = new CompanionService({ store, llm });

  // ------------------------------------------------------ observation harness

  // One read-only view of everything Vowe can see, shared unchanged by the
  // observer following the work and by the runner answering questions about it.
  const navigator = new ContextNavigator({
    store,
    resolveCwd: (sessionId) => registry.get(sessionId)?.cwd ?? null,
  });

  const router: DecisionRouter =
    JevDecisionRouter.fromEnvironment({
      onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
    }) ?? new HeuristicDecisionRouter();

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
    observer: llm ?? nullObserver(),
    navigator,
    policy: new CommunicationPolicy({
      router,
      ...(llm ? { llm } : {}),
      onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
    }),
    router,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });

  const live = new LiveBridge({
    transport: liveTransport,
    observation,
    delegated: new DelegatedQuestionRunner({
      store,
      navigator,
      investigator: llm ?? nullObserver(),
      onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
    }),
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
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
  });

  await registry.start();

  return {
    store,
    registry,
    companion,
    runner,
    observation,
    live,
    status: {
      llmConfigured: llm !== undefined,
      voiceConfigured: liveTransport.available,
      voiceUnavailableReason: liveTransport.unavailableReason,
      decisionsConfigured: router.available,
      storeRoot,
      providers: [PROVIDER],
    },
  };
}

/**
 * The observation model when none is configured.
 *
 * Observation needs a model in a way interpretation does not — there is no
 * deterministic prose to fall back to. Saying so plainly, once per window, is
 * better than a heuristic that pretends to have understood something.
 */
function nullObserver(): import('@vowe/core').ObservationLlm {
  const message =
    'No model is configured, so this window was recorded but not interpreted. Its trace range is still addressable.';
  return {
    async observeWindow() {
      return { summary: message };
    },
    async investigate() {
      return { spokenAnswer: message, fullAnswer: message, refs: [] };
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

  // Answered from what we observed. Deliberately has no adapter in reach.
  ipcMain.handle(IPC.ask, async (_event, sessionId: string, question: string) =>
    (await requireServices()).companion.ask(sessionId, question),
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

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  servicesReady = createServices();
  try {
    services = await servicesReady;
    broadcastSessions();
  } catch (error) {
    console.error('[vowe] failed to start services', error);
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
});

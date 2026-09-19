import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, dialog, ipcMain, nativeTheme } from 'electron';

import {
  CompanionService,
  HeuristicInterpreter,
  InterpretationRunner,
  LlmSemanticInterpreter,
  NdjsonEventStore,
  SessionRegistry,
  type SemanticInterpreter,
} from '@vowe/core';
import { ClaudeCodeAdapter, PROVIDER } from '@vowe/adapter-claude-code';
import { AnthropicLlmClient } from '@vowe/llm';

import { IPC, type AppStatus } from '../shared/ipc.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

interface Services {
  store: NdjsonEventStore;
  registry: SessionRegistry;
  companion: CompanionService;
  runner: InterpretationRunner;
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
    status: {
      llmConfigured: llm !== undefined,
      storeRoot,
      providers: [PROVIDER],
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
});

import { CursorAdapter } from '@vowe/adapter-cursor';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, dialog, ipcMain, nativeTheme } from 'electron';

import { loadLocalEnv } from './env.js';

// Before anything reads a credential. Every key Vowe takes is optional, so a
// missing or malformed file degrades exactly like an empty environment.
const envFile = loadLocalEnv();

import {
  hasCurrentSupport,
  ArtifactResolver,
  AttentionCursorStore,
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
  investigationChronology,
  listGitFiles,
  AppearanceStore,
  ObservingStore,
  PresenceProfileStore,
  ProjectBriefService,
  ProjectKnowledgeService,
  ProjectMemoryStore,
  ProjectService,
  SessionRegistry,
  SessionTitleService,
  TemperamentStore,
  UserProfileStore,
  UnavailableLiveTransport,
  VoicePreferenceStore,
  VoweRunRecorder,
  type DecisionRouter,
  type LiveTransport,
  type LiveVoice,
  type PersistedWorkbench,
  type Project,
  type SemanticInterpreter,
  type WorkbenchCandidate,
  type TemperamentProfile,
  type VoicePreference,
} from '@vowe/core';
import { ClaudeCodeAdapter } from '@vowe/adapter-claude-code';
import { CodexAdapter } from '@vowe/adapter-codex';
import { PiAdapter } from '@vowe/adapter-pi';
import { createGraphifyKnowledge } from '@vowe/knowledge-graphify';
import { AnthropicLlmClient, AnthropicTitleModel } from '@vowe/llm';
import { JevDecisionRouter } from '@vowe/decision-jev';
import { OpenAiLiveTransport } from '@vowe/live-openai';

import { WINDOW_BACKGROUND } from '../shared/appearance.js';
import {
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  WINDOW_HEIGHT,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_WIDTH,
} from '../shared/layout.js';
import {
  IPC,
  type AppStatus,
  type AskResult,
  type ObservationView,
  type ProjectAskResult,
} from '../shared/ipc.js';
import type {
  ContextRef,
  EventStore,
  InvestigationReceipt,
  InvestigationStep,
  PlaybackReport,
  AppearanceSetting,
  PresenceProfile,
  UserProfile,
  VoweRun,
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
  /** How Vowe behaves. Separate from how it looks, and separately stored. */
  temperament: TemperamentStore;
  voice: VoicePreferenceStore;
  /** Where the developer's understanding of each session got to. */
  cursors: AttentionCursorStore;
  /** Reading these is what keeps the synchronous core readers accurate. */
  readTemperament: () => TemperamentProfile;
  applyTemperament: (next: TemperamentProfile) => void;
  readVoicePreference: () => VoicePreference;
  applyVoicePreference: (next: VoicePreference) => void;
  /** The voices the configured transport will actually accept. */
  voices: readonly LiveVoice[];
  companion: CompanionService;
  /** Resolves a ContextRef into something the renderer can display. */
  workbench: ArtifactResolver;
  /** The one grounded investigator. Typed questions and Vo both arrive here. */
  delegated: DelegatedQuestionRunner;
  runner: InterpretationRunner;
  /** Names a session, once, when a person's action asks for a name. */
  titles: SessionTitleService;
  observation: ObservationService;
  /**
   * Projects the developer has paused. Their sessions are still recorded, but
   * interpretation, the Session Observer and naming reach no model for them;
   * anything the developer explicitly asks still runs.
   */
  observing: {
    paused(): string[];
    set(projectId: string, observing: boolean): Promise<string[]>;
    allows(sessionId: string): boolean;
  };
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
/** Everything Vowe keeps on disk, under one directory. */
function storeRoot(): string {
  return path.join(app.getPath('userData'), 'vowe');
}

/**
 * The appearance, read before anything else and applied to the window itself.
 *
 * Deliberately outside `Services`. Everything in there is wired after the
 * window is created, because the window should paint while discovery runs —
 * but the appearance has to be decided *before* the first frame or the choice
 * arrives as a flash. It is one small file and no dependencies, so it is read
 * on its own.
 */
let appearanceStore: AppearanceStore | null = null;
function appearance(): AppearanceStore {
  appearanceStore ??= new AppearanceStore({
    root: storeRoot(),
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });
  return appearanceStore;
}

/**
 * Hand the setting to Electron, which is what resolves `system`.
 *
 * `themeSource` is the one place the preference exists at runtime: Chromium
 * answers `prefers-color-scheme` from it, so the stylesheet and the presence
 * both follow without anything being pushed to the renderer. Left on
 * `system`, macOS switching itself at dusk reaches the window on its own.
 */
function applyAppearance(setting: AppearanceSetting): void {
  nativeTheme.themeSource = setting.theme;
  window?.setBackgroundColor(windowBackground());
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

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
  /*
   * Every provider Vowe can observe, registered the same way.
   *
   * Nothing below this point names one. A provider that is not installed
   * simply discovers no sessions and reports no capabilities, so the list is
   * unconditional and the honesty happens per session instead.
   */
  const onAdapterError = (scope: string, error: unknown) =>
    console.error(`[vowe] ${scope}`, error);
  registry.registerAdapter(new ClaudeCodeAdapter({ onError: onAdapterError }));
  registry.registerAdapter(new PiAdapter({ onError: onAdapterError }));
  registry.registerAdapter(new CodexAdapter({ onError: onAdapterError }));
  registry.registerAdapter(new CursorAdapter({onError: error => console.error('[cursor] evidence',error)}));

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
      hasCurrentSupport: ref => hasCurrentSupport(store,ref),
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
  const temperamentStore = new TemperamentStore({
    root: storeRoot,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });
  const voiceStore = new VoicePreferenceStore({
    root: storeRoot,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });
  const cursors = new AttentionCursorStore({
    root: storeRoot,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });

  /**
   * Temperament and voice, cached for the synchronous readers in core.
   *
   * The policy and the investigator ask for these mid-decision and mid-answer,
   * where there is nothing sensible to await. They are two small documents
   * read once at startup and rewritten only when the developer changes them,
   * so a cached copy is the accurate one rather than a stale one.
   */
  let temperament = await temperamentStore.get();
  let voicePreference = await voiceStore.get();

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

  /**
   * Titles, written once, when a person asks for one by acting.
   *
   * There are exactly two triggers, both below: Vowe creating a session, and
   * someone opening an existing one for the first time. Discovery is not one
   * of them — it used to be, and a machine with a week of history paid for
   * that at every launch and then again whenever the interpreter revised its
   * reading of a session.
   */
  const titles = new SessionTitleService({
    store,
    model: new AnthropicTitleModel({
      onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
    }),
    onTitled: (sessionId, title) => {
      // The cached session learns its name now rather than on the next
      // discovery pass, so the sidebar changes when the title is written.
      registry.noteGeneratedTitle(sessionId, title);
      broadcastSessions();
    },
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
    temperament: () => temperament,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });

  // The one grounded investigator, constructed once and shared. A question
  // typed into Vowe and the same question asked out loud run through this
  // object, so they cannot diverge in what they can look at or in what they
  // leave behind.
  const delegated = new DelegatedQuestionRunner({
    store,
    sessionsFor: (projectId) => projects.getSessions(projectId),
    navigator,
    investigator: llm ?? nullObserver(store),
    runs,
    temperament: () => temperament,
    // Forwarded straight to the window: an investigation in flight is not
    // history, and the durable account of it is the receipt written with the
    // answer. This only lets the room show the work while it happens.
    onProgress: (progress) => {
      window?.webContents.send(IPC.investigationProgress, progress);
    },
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
    projectBrief: (projectId) => brief.get(projectId),
    observation,
    delegated,
    // With these, a spoken conversation is history rather than a session that
    // evaporates when the call ends.
    store,
    runs,
    temperament: () => temperament,
    voice: () => voicePreference.voice,
    onError: (scope, error) => console.error(`[vowe] ${scope}`, error),
  });

  // Every conversation write converges on the store, so this one subscription
  // covers a typed answer, an answer delegated from Vo, and an instruction and
  // its result — including the last of those, which notified nothing before.
  store.onConversationChanged((change) => {
    window?.webContents.send(IPC.conversationChanged, change);
  });

  // Its own event, for its own table: a Project Room re-reading because some
  // session's conversation moved would be reacting to work it is not showing.
  store.onProjectConversationChanged((change) => {
    window?.webContents.send(IPC.projectConversationChanged, change);
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
  // Forwarded, never stored: the durable record of a call is the conversation,
  // which is written when a turn closes.
  live.on('transcript', (delta) => {
    window?.webContents.send(IPC.liveTranscript, delta);
  });
  // What Vowe is executing, published from the lane that already records it.
  runs.on('activity', (activity) => {
    window?.webContents.send(IPC.runActivityChanged, activity);
  });
  live.on('answered', (answered) => {
    // A delegated answer is persisted as a conversation entry, so the session
    // view has something new to show.
    if (answered.sessionId) window?.webContents.send(IPC.observationChanged, answered.sessionId);
  });

  /*
   * Discovery names nothing.
   *
   * Finding a session is not a request to name it: it is how every session on
   * the machine arrives, repeatedly, for as long as Vowe is running. A
   * session appears in the sidebar the moment it is found, under the
   * deterministic concise name `sessionTitle` derives, and it stays under that
   * name until a person opens it.
   */
  const refreshVoice = () => { void live.refreshProjectContext().catch((error) => console.error('[vowe] live:project-context', error)); };
  registry.on('session:added', refreshVoice);
  registry.on('session:updated', refreshVoice);
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

  const observingStore = new ObservingStore({
    root: storeRoot,
    onError: (scope, error) => console.warn(`[vowe] ${scope}`, error),
  });
  let paused = new Set((await observingStore.get()).pausedProjects);
  const isPaused = (sessionId: string) => {
    const projectId = registry.get(sessionId)?.projectId;
    return !!projectId && paused.has(projectId);
  };
  const applyObserving = async (next: Set<string>) => {
    paused = next;
    runner.setPaused(isPaused);
    await observation.setPaused(isPaused);
  };
  await applyObserving(paused);

  await registry.start();

  return {
    observing: {
      paused: () => [...paused],
      allows: (sessionId) => !isPaused(sessionId),
      set: async (projectId, observing) => {
        const next = new Set(paused);
        if (observing) next.delete(projectId);
        else next.add(projectId);
        const stored = await observingStore.set({ pausedProjects: [...next] });
        await applyObserving(new Set(stored.pausedProjects));
        return stored.pausedProjects;
      },
    },
    store,
    registry,
    runs,
    projects,
    knowledge,
    brief,
    profile,
    presence,
    temperament: temperamentStore,
    voice: voiceStore,
    cursors,
    readTemperament: () => temperament,
    applyTemperament: (next) => {
      temperament = next;
    },
    readVoicePreference: () => voicePreference,
    applyVoicePreference: (next) => {
      voicePreference = next;
    },
    voices: liveTransport.voices,
    companion,
    workbench,
    delegated,
    runner,
    titles,
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
      providers: registry.providers(),
      launchCapableProviders: registry.launchCapableProviders(),
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
  /*
   * Not behind `requireServices`: the appearance is readable and settable
   * before the database is open, which is the point of it being its own file.
   */
  ipcMain.handle(IPC.getAppearance, () => appearance().get());
  ipcMain.handle(IPC.setAppearance, async (_event, next: AppearanceSetting) => {
    const stored = await appearance().set(next);
    applyAppearance(stored);
    return stored;
  });

  ipcMain.handle(IPC.getRunActivity, async () => (await requireServices()).runs.activity);

  // Written through the store, then applied to the cached copy the synchronous
  // readers in core use — in that order, so a failed write never takes effect.
  ipcMain.handle(IPC.getTemperament, async () =>
    (await requireServices()).temperament.get(),
  );
  ipcMain.handle(
    IPC.setTemperament,
    async (_event, next: TemperamentProfile): Promise<TemperamentProfile> => {
      const services = await requireServices();
      const stored = await services.temperament.set(next);
      services.applyTemperament(stored);
      return stored;
    },
  );
  ipcMain.handle(IPC.getVoicePreference, async () =>
    (await requireServices()).voice.get(),
  );
  ipcMain.handle(
    IPC.setVoicePreference,
    async (_event, next: VoicePreference): Promise<VoicePreference> => {
      const services = await requireServices();
      const stored = await services.voice.set(next);
      services.applyVoicePreference(stored);
      return stored;
    },
  );
  // From the transport, never from a constant: a picker must not be able to
  // offer a voice the provider would refuse once someone is already on a call.
  ipcMain.handle(IPC.listVoices, async () => [...(await requireServices()).voices]);

  ipcMain.handle(IPC.getAttentionCursor, async (_event, sessionId: string) =>
    (await requireServices()).cursors.get(sessionId),
  );
  ipcMain.handle(
    IPC.markSessionViewed,
    async (_event, sessionId: string, seq: number): Promise<void> => {
      await (await requireServices()).cursors.mark(sessionId, { seq });
    },
  );

  // Grounded by going and looking — the same investigator Vo delegates to, with
  // the same three read tools. Still deliberately has no adapter in reach.
  //
  // `spokenAnswer` is dropped here rather than ignored in the renderer. The
  // short form exists for a voice channel, and making it structurally
  // unavailable to the typed UI is cheaper than a convention about not using it.
  ipcMain.handle(
    IPC.ask,
    async (
      _event,
      sessionId: string,
      question: string,
      contextRefs?: ContextRef[],
    ): Promise<AskResult> => {
      const result = await (
        await requireServices()
      ).companion.ask(sessionId, question, contextRefs);
      return { entry: result.entry, refs: result.refs, failed: result.failed };
    },
  );

  // The same investigator, asked about a repository. `spokenAnswer` is dropped
  // here for the same reason it is dropped above.
  ipcMain.handle(
    IPC.askProject,
    async (
      _event,
      projectId: string,
      question: string,
      contextRefs?: ContextRef[],
    ): Promise<ProjectAskResult> => {
      const services = await requireServices();
      const result = await services.companion.askProject(projectId, question, contextRefs);
      void services.live.projectAsked(projectId, question, result.entry.text)
        .catch((error) => console.error('[vowe] live:typed-context', error));
      return { entry: result.entry, refs: result.refs, failed: result.failed };
    },
  );

  ipcMain.handle(IPC.getProjectConversation, async (_event, projectId: string) =>
    (await requireServices()).store.getProjectConversation(projectId),
  );

  ipcMain.handle(IPC.listProjectMemories, async (_event, projectId: string) =>
    (await requireServices()).knowledge.listMemories(projectId),
  );

  // What was actually conveyed, beside what was said. The renderer needs both
  // to be honest about a reply that was cut off.
  ipcMain.handle(IPC.getProjectDeliveries, async (_event, projectId: string) =>
    (await requireServices()).store.getDeliveriesForProject(projectId),
  );
  ipcMain.handle(IPC.getDeliveries, async (_event, sessionId: string) =>
    (await requireServices()).store.getDeliveriesForSession(sessionId),
  );

  /*
   * Put a session away, or bring it back.
   *
   * The renderer is told afterwards, because the projects panel is a
   * projection of what the store holds and archiving changes what belongs in
   * it — without the announcement the list would keep the session until
   * something else happened to refresh it.
   */
  ipcMain.handle(
    IPC.archiveSession,
    async (_event, sessionId: string, archived: boolean): Promise<void> => {
      const services = await requireServices();
      await services.store.setSessionArchived(sessionId, archived);
      // The registry is the list the renderer reads; the column is where this
      // lives. Telling it now is what makes the panel react to the click.
      services.registry.noteArchived(
        sessionId,
        services.store.getSession(sessionId)?.archivedAt ?? null,
      );
      broadcastSessions();
    },
  );

  // Open or close a project in the panel. The panel re-reads projects on the
  // same announcement sessions use, so that is the one sent.
  ipcMain.handle(
    IPC.setProjectOpen,
    async (_event, projectId: string, open: boolean): Promise<void> => {
      await (await requireServices()).store.setProjectOpen(projectId, open);
      broadcastSessions();
    },
  );

  // Opening by folder. The path is checked here, because resolution falls back
  // to the path itself for a folder outside git — and a typo would otherwise
  // become a project.
  ipcMain.handle(
    IPC.openProjectAt,
    async (_event, directory: string): Promise<Project> => {
      const services = await requireServices();
      const trimmed = directory.trim();
      const absolute = path.resolve(
        trimmed === '~' || trimmed.startsWith('~/')
          ? path.join(os.homedir(), trimmed.slice(1))
          : trimmed,
      );
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`No folder at ${absolute}`);
      const project = await services.projects.projectAt(absolute);
      if (!project) throw new Error(`Could not open ${absolute}`);
      await services.store.setProjectOpen(project.id, true);
      broadcastSessions();
      return services.projects.listProjectsForDisplay().find((item) => item.id === project.id) ?? project;
    },
  );

  // The generic artifact open. `ContextNavigator` itself stays off the bridge:
  // the renderer gets display projections, never the read toolset.
  ipcMain.handle(IPC.openArtifact, async (_event, ref: ContextRef) =>
    (await requireServices()).workbench.resolve(ref),
  );

  /*
   * Repository files, by name, as addresses.
   *
   * The narrowest thing that makes the launcher's search real, and it holds
   * the same line the open above does: `ContextNavigator` stays on this side,
   * and what crosses is a path and a name. No file is read to answer this.
   */
  ipcMain.handle(
    IPC.findFiles,
    async (_event, sessionId: string, query: string): Promise<WorkbenchCandidate[]> => {
      const services = await requireServices();
      const cwd = services.registry.get(sessionId)?.cwd ?? null;
      const found = await listGitFiles(cwd, query, 20);
      return found.map((relative) => ({
        /*
         * Absolute, for the same reason the navigator resolves grep hits
         * here: `git` prints repository-relative paths, and a ref travels to
         * a reader whose working directory is not the repository. This is the
         * one place that still knows which tree the path came from.
         */
        ref: { kind: 'repo', path: cwd ? path.resolve(cwd, relative) : relative },
        // The developer reads the path they know, which is the relative one.
        label: relative.split('/').pop() || relative,
        detail: relative.split('/').slice(0, -1).join('/'),
      }));
    },
  );

  /*
   * The desk, across a session switch and across a restart.
   *
   * References and their order, which is all a strip needs to draw itself;
   * what each tab shows is read back through `openArtifact` when somebody
   * looks at it.
   */
  ipcMain.handle(IPC.getWorkbench, async (_event, sessionId: string) =>
    (await requireServices()).store.getWorkbenchState(sessionId),
  );
  ipcMain.handle(
    IPC.saveWorkbench,
    async (_event, sessionId: string, desk: PersistedWorkbench): Promise<void> => {
      await (await requireServices()).store.setWorkbenchState(sessionId, desk);
    },
  );

  /*
   * The chronology of one settled answer.
   *
   * A join across two lanes that were already durable, performed here because
   * this is the side that has the store: the run whose `outputEntryId` is this
   * entry, that run's trace, and the receipt the entry itself carries. The
   * renderer receives the same `InvestigationStep[]` shape the live column
   * renders, so a finished investigation and one in flight are drawn by one
   * component rather than two that can drift.
   */
  ipcMain.handle(
    IPC.getInvestigationSteps,
    async (_event, entryId: string): Promise<InvestigationStep[]> => {
      const { store } = await requireServices();
      const run = store.getRunForEntry(entryId);
      const receipt = run ? receiptFor(store, run, entryId) : undefined;
      return investigationChronology({
        ...(receipt ? { receipt } : {}),
        ...(run ? { trace: store.getTraceItems(run.id) } : {}),
      });
    },
  );

  // The control channel. Separate handler, separate service, separate button.
  ipcMain.handle(
    IPC.sendInstruction,
    async (_event, sessionId: string, text: string) =>
      (await requireServices()).registry.sendInstruction(sessionId, text),
  );

  ipcMain.handle(
    IPC.launch,
    async (_event, cwd: string, prompt: string, provider?: string) => {
    const services = await requireServices();
    /*
     * Which agent to start is the caller's choice, not a constant. Absent a
     * choice, the first provider that can actually launch here wins — which
     * keeps a machine without a given CLI installed from being offered it.
     */
    const capable = services.registry.launchCapableProviders();
    const target = provider ?? capable[0];
    if (!target) {
      throw new Error('No installed provider can start a new session.');
    }
    const session = await services.registry.launchSession(target, { cwd, prompt });
    /*
     * A session Vowe started is named straight away.
     *
     * The first of the two triggers, and the easy one: the developer has just
     * written the prompt, so there is a real naming signal and an obvious
     * moment. Deliberately not awaited — what the session is called is not a
     * precondition of it having been launched.
     */
    if (services.observing.allows(session.id)) void services.titles.ensure(session.id);
    return session;
    },
  );

  /*
   * The second trigger: someone opened this session.
   *
   * Its own channel rather than a side effect of reading the conversation,
   * because the distinction is the whole point — listing, discovering and
   * polling a session must never reach a model, and opening one may. The
   * handler returns immediately and the service takes it from there; a naming
   * failure is invisible to the room that called it.
   */
  ipcMain.handle(IPC.sessionOpened, async (_event, sessionId: string) => {
    const services = await requireServices();
    if (services.observing.allows(sessionId)) void services.titles.ensure(sessionId);
  });

  ipcMain.handle(IPC.getPausedProjects, async () => (await requireServices()).observing.paused());
  ipcMain.handle(IPC.setProjectObserving, async (_event, projectId: string, observing: boolean) =>
    (await requireServices()).observing.set(projectId, observing === true),
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
  ipcMain.handle(IPC.startProjectLive, async (_event, projectId: string, sdpOffer: string) =>
    (await requireServices()).live.start({ projectId }, sdpOffer),
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

  // For attaching a file to a question. The renderer never reads it: it hands
  // back a path, which becomes a `repo:` ref the investigator opens for itself.
  ipcMain.handle(IPC.isFullscreen, () => window?.isFullScreen() ?? false);

  ipcMain.handle(IPC.chooseFile, async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile'] };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    /*
     * The default width is load-bearing, not a preference.
     *
     * It is the width at which the reading measure fits between both panels
     * with its gutters — the arithmetic in `shared/layout.ts` — which is what
     * makes opening a panel move the conversation across rather than re-wrap
     * it. The floor is the same promise with the projects panel alone, since
     * that is the one usually out.
     */
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'Vowe',
    // The room's own surface, so the frame before the stylesheet arrives is
    // the colour the room is about to be rather than a lighter grey.
    backgroundColor: windowBackground(),
    /*
     * The window's own controls, centred in the application band.
     *
     * Both numbers come from `shared/layout.ts`, which is also where the
     * renderer's `--chrome-height` and `--traffic-lights` come from: `y`
     * centres the buttons in the band, and the band leaves `x` plus their
     * width alone on its left. Two copies of either is how the chrome and the
     * real controls drift apart.
     */
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y },
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // The renderer reserves space for the traffic lights, which do not exist in
  // fullscreen. Telling it which state the window is in beats guessing in CSS
  // and leaving a dead band at the top of the sidebar.
  const announceFullscreen = () => {
    window?.webContents.send(IPC.fullscreenChanged, window.isFullScreen());
  };
  window.on('enter-full-screen', announceFullscreen);
  window.on('leave-full-screen', announceFullscreen);

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
    backgroundColor: windowBackground(),
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void preview.loadURL(`${devServer}/presence-preview.html`);
  else void preview.loadFile(path.join(dirname, '../renderer/presence-preview.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  /*
   * Before the window exists, and awaited.
   *
   * After the window is created there is no appearance to *apply* any more,
   * only one to change — and a change the developer can see is the startup
   * flash this ordering exists to prevent. One small JSON read is the whole
   * cost, and the frame it delays is a frame that would have been the wrong
   * colour.
   */
  applyAppearance(await appearance().get());
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

/**
 * The receipt on the answer this run produced.
 *
 * A run knows which session or project it belonged to and which entry it
 * wrote, so the entry is found in the thread it was written to rather than
 * through a lookup by id that no store offers. Session and project threads are
 * deliberately separate types and separate tables; a run belongs to one of
 * them, and this asks the one it belongs to.
 */
function receiptFor(
  store: EventStore,
  run: VoweRun,
  entryId: string,
): InvestigationReceipt | undefined {
  const thread = run.sessionId
    ? store.getConversation(run.sessionId)
    : run.projectId
      ? store.getProjectConversation(run.projectId)
      : [];
  return thread.find((entry) => entry.id === entryId)?.investigation;
}

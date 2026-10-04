import { contextBridge, ipcRenderer } from 'electron';

import type {
  AppearanceSetting,
  ContextRef,
  CreateProjectInput,
  DesignChange,
  InvestigationProgress,
  StudioProgress,
  LiveTranscriptDelta,
  ConversationChange,
  LiveStatus,
  NormalizedEvent,
  PersistedWorkbench,
  PresenceProfile,
  ProjectConversationChange,
  TemperamentProfile,
  UserProfile,
  VoicePreference,
  VoweRunActivity,
} from '@vowe/core';
import type { FleetLayoutChange } from '@vowe/core';
import type { CaptainExchangeChange } from '@vowe/core';
import { IPC, type VoweApi } from '../shared/ipc.js';

const api: VoweApi = {
  getStatus: () => ipcRenderer.invoke(IPC.status),
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getSession: (sessionId) => ipcRenderer.invoke(IPC.getSession, sessionId),
  getEvents: (sessionId, limit) =>
    ipcRenderer.invoke(IPC.getEvents, sessionId, limit),
  getConversation: (sessionId) =>
    ipcRenderer.invoke(IPC.getConversation, sessionId),
  refreshInterpretation: (sessionId) =>
    ipcRenderer.invoke(IPC.refreshInterpretation, sessionId),
  askCompanion: (sessionId, question, contextRefs) =>
    ipcRenderer.invoke(IPC.ask, sessionId, question, contextRefs),
  getProjectDeliveries: (projectId) => ipcRenderer.invoke(IPC.getProjectDeliveries, projectId),
  getDeliveries: (sessionId) => ipcRenderer.invoke(IPC.getDeliveries, sessionId),
  sendInstruction: (sessionId, text) =>
    ipcRenderer.invoke(IPC.sendInstruction, sessionId, text),
  launchSession: (cwd, prompt, provider) =>
    ipcRenderer.invoke(IPC.launch, cwd, prompt, provider),
  chooseFolder: () => ipcRenderer.invoke(IPC.chooseFolder),
  chooseFile: () => ipcRenderer.invoke(IPC.chooseFile),
  getProjectKnowledge: (projectId) =>
    ipcRenderer.invoke(IPC.getProjectKnowledge, projectId),
  getProjectBrief: (projectId) =>
    ipcRenderer.invoke(IPC.getProjectBrief, projectId),
  askProject: (projectId, question, contextRefs) =>
    ipcRenderer.invoke(IPC.askProject, projectId, question, contextRefs),
  getProjectConversation: (projectId) =>
    ipcRenderer.invoke(IPC.getProjectConversation, projectId),
  listProjectMemories: (projectId) =>
    ipcRenderer.invoke(IPC.listProjectMemories, projectId),

  getUserProfile: () => ipcRenderer.invoke(IPC.getUserProfile),
  setUserProfile: (profile: UserProfile) =>
    ipcRenderer.invoke(IPC.setUserProfile, profile),
  getPresenceProfile: () => ipcRenderer.invoke(IPC.getPresenceProfile),
  setPresenceProfile: (profile: PresenceProfile) =>
    ipcRenderer.invoke(IPC.setPresenceProfile, profile),
  getAppearance: () => ipcRenderer.invoke(IPC.getAppearance),
  setAppearance: (setting: AppearanceSetting) =>
    ipcRenderer.invoke(IPC.setAppearance, setting),
  getTemperament: () => ipcRenderer.invoke(IPC.getTemperament),
  setTemperament: (profile: TemperamentProfile) =>
    ipcRenderer.invoke(IPC.setTemperament, profile),
  getVoicePreference: () => ipcRenderer.invoke(IPC.getVoicePreference),
  setVoicePreference: (preference: VoicePreference) =>
    ipcRenderer.invoke(IPC.setVoicePreference, preference),
  listVoices: () => ipcRenderer.invoke(IPC.listVoices),

  getAttentionCursor: (sessionId) =>
    ipcRenderer.invoke(IPC.getAttentionCursor, sessionId),
  markSessionViewed: (sessionId, seq) =>
    ipcRenderer.invoke(IPC.markSessionViewed, sessionId, seq),
  sessionOpened: (sessionId) => ipcRenderer.invoke(IPC.sessionOpened, sessionId),

  getRunActivity: () => ipcRenderer.invoke(IPC.getRunActivity),

  getPausedProjects: () => ipcRenderer.invoke(IPC.getPausedProjects),
  setProjectObserving: (projectId, observing) =>
    ipcRenderer.invoke(IPC.setProjectObserving, projectId, observing),
  startObserving: (sessionId) =>
    ipcRenderer.invoke(IPC.startObserving, sessionId),
  stopObserving: (sessionId) => ipcRenderer.invoke(IPC.stopObserving, sessionId),
  getObservation: (sessionId) =>
    ipcRenderer.invoke(IPC.getObservation, sessionId),
  setCommunicationPreference: (sessionId, preference) =>
    ipcRenderer.invoke(IPC.setPreference, sessionId, preference),

  // The SDP offer goes out and the answer comes back; the API key never
  // crosses this boundary in either direction.
  archiveSession: (sessionId: string, archived: boolean) =>
    ipcRenderer.invoke(IPC.archiveSession, sessionId, archived),
  setProjectOpen: (projectId: string, open: boolean) =>
    ipcRenderer.invoke(IPC.setProjectOpen, projectId, open),
  openProjectAt: (directory: string) => ipcRenderer.invoke(IPC.openProjectAt, directory),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke(IPC.createProject, input),
  renameProject: (projectId: string, name: string) =>
    ipcRenderer.invoke(IPC.renameProject, projectId, name),
  removeProject: (projectId: string) => ipcRenderer.invoke(IPC.removeProject, projectId),
  addProjectFolder: (projectId: string, folder: string) =>
    ipcRenderer.invoke(IPC.addProjectFolder, projectId, folder),
  removeProjectFolder: (projectId: string, folder: string) =>
    ipcRenderer.invoke(IPC.removeProjectFolder, projectId, folder),
  openArtifact: (ref: ContextRef) => ipcRenderer.invoke(IPC.openArtifact, ref),
  findFiles: (sessionId: string, query: string) =>
    ipcRenderer.invoke(IPC.findFiles, sessionId, query),
  getWorkbench: (sessionId: string) => ipcRenderer.invoke(IPC.getWorkbench, sessionId),
  saveWorkbench: (sessionId: string, desk: PersistedWorkbench) =>
    ipcRenderer.invoke(IPC.saveWorkbench, sessionId, desk),
  getInvestigationSteps: (entryId: string) =>
    ipcRenderer.invoke(IPC.getInvestigationSteps, entryId),

  startProjectLive: (projectId, sdpOffer) => ipcRenderer.invoke(IPC.startProjectLive, projectId, sdpOffer),
  startLive: (sessionId, sdpOffer) =>
    ipcRenderer.invoke(IPC.startLive, sessionId, sdpOffer),
  stopLive: () => ipcRenderer.invoke(IPC.stopLive),
  getLiveStatus: () => ipcRenderer.invoke(IPC.liveStatus),
  reportLivePlayback: (report) => ipcRenderer.send(IPC.livePlayback, report),

  onSessionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.sessionsChanged, handler);
    return () => ipcRenderer.off(IPC.sessionsChanged, handler);
  },
  onSessionEvent: (listener) => {
    const handler = (_: unknown, event: NormalizedEvent) => listener(event);
    ipcRenderer.on(IPC.sessionEvent, handler);
    return () => ipcRenderer.off(IPC.sessionEvent, handler);
  },
  onObservationChanged: (listener) => {
    const handler = (_: unknown, sessionId: string) => listener(sessionId);
    ipcRenderer.on(IPC.observationChanged, handler);
    return () => ipcRenderer.off(IPC.observationChanged, handler);
  },
  onProjectKnowledgeChanged: (listener) => {
    const handler = (_: unknown, projectId: string) => listener(projectId);
    ipcRenderer.on(IPC.projectKnowledgeChanged, handler);
    return () => ipcRenderer.off(IPC.projectKnowledgeChanged, handler);
  },
  onConversationChanged: (listener) => {
    const handler = (_: unknown, change: ConversationChange) => listener(change);
    ipcRenderer.on(IPC.conversationChanged, handler);
    return () => ipcRenderer.off(IPC.conversationChanged, handler);
  },
  onLiveStatus: (listener) => {
    const handler = (_: unknown, status: LiveStatus) => listener(status);
    ipcRenderer.on(IPC.liveStatusChanged, handler);
    return () => ipcRenderer.off(IPC.liveStatusChanged, handler);
  },
  onProjectConversationChanged: (listener) => {
    const handler = (_: unknown, change: ProjectConversationChange) => listener(change);
    ipcRenderer.on(IPC.projectConversationChanged, handler);
    return () => ipcRenderer.off(IPC.projectConversationChanged, handler);
  },
  onLiveTranscript: (listener) => {
    const handler = (_: unknown, delta: LiveTranscriptDelta) => listener(delta);
    ipcRenderer.on(IPC.liveTranscript, handler);
    return () => ipcRenderer.off(IPC.liveTranscript, handler);
  },
  isFullscreen: () => ipcRenderer.invoke(IPC.isFullscreen),
  onFullscreenChanged: (listener) => {
    const handler = (_: unknown, fullscreen: boolean) => listener(fullscreen);
    ipcRenderer.on(IPC.fullscreenChanged, handler);
    return () => ipcRenderer.off(IPC.fullscreenChanged, handler);
  },
  listDesigns: (projectId) => ipcRenderer.invoke(IPC.listDesigns, projectId),
  getDesign: (designId) => ipcRenderer.invoke(IPC.getDesign, designId),
  createDesign: (projectId) => ipcRenderer.invoke(IPC.createDesign, projectId),
  converseDesign: (designId, message, contextRefs, options) =>
    ipcRenderer.invoke(IPC.converseDesign, designId, message, contextRefs, options),
  manipulateDesign: (designId, ops) => ipcRenderer.invoke(IPC.manipulateDesign, designId, ops),
  setDesignLayout: (designId, layout) => ipcRenderer.invoke(IPC.setDesignLayout, designId, layout),
  tidyDesign: (designId) => ipcRenderer.invoke(IPC.tidyDesign, designId),
  cancelDesignTurn: (designId) => ipcRenderer.invoke(IPC.cancelDesignTurn, designId),
  onStudioProgress: (listener) => {
    const handler = (_: unknown, progress: StudioProgress) => listener(progress);
    ipcRenderer.on(IPC.studioProgress, handler);
    return () => ipcRenderer.off(IPC.studioProgress, handler);
  },
  onDesignChanged: (listener) => {
    const handler = (_: unknown, change: DesignChange) => listener(change);
    ipcRenderer.on(IPC.designChanged, handler);
    return () => ipcRenderer.off(IPC.designChanged, handler);
  },
  getFleetLayout: (projectId) => ipcRenderer.invoke(IPC.getFleetLayout, projectId),
  saveFleetLayout: (projectId, layout) => ipcRenderer.invoke(IPC.saveFleetLayout, projectId, layout),
  onFleetLayoutChanged: (listener) => {
    const handler = (_: unknown, change: FleetLayoutChange) => listener(change);
    ipcRenderer.on(IPC.fleetLayoutChanged, handler);
    return () => ipcRenderer.off(IPC.fleetLayoutChanged, handler);
  },
  onInvestigationProgress: (listener) => {
    const handler = (_: unknown, progress: InvestigationProgress) => listener(progress);
    ipcRenderer.on(IPC.investigationProgress, handler);
    return () => ipcRenderer.off(IPC.investigationProgress, handler);
  },
  onRunActivity: (listener) => {
    const handler = (_: unknown, activity: VoweRunActivity) => listener(activity);
    ipcRenderer.on(IPC.runActivityChanged, handler);
    return () => ipcRenderer.off(IPC.runActivityChanged, handler);
  },
  launchCaptain: (projectId, folder) => ipcRenderer.invoke(IPC.launchCaptain, projectId, folder),
  listCaptainExchanges: (projectId) => ipcRenderer.invoke(IPC.listCaptainExchanges, projectId),
  answerQuestion: (exchangeId, text, alsoTellCaptain) =>
    ipcRenderer.invoke(IPC.answerQuestion, exchangeId, text, alsoTellCaptain),
  onCaptainExchangeChanged: (listener) => {
    const handler = (_: unknown, change: CaptainExchangeChange) => listener(change);
    ipcRenderer.on(IPC.captainExchangeChanged, handler);
    return () => ipcRenderer.off(IPC.captainExchangeChanged, handler);
  },
  getFleetStatuses: (sessionIds) => ipcRenderer.invoke(IPC.getFleetStatuses, sessionIds),
  onFleetStatusChanged: (listener) => {
    const handler = (_: unknown, sessionId: string) => listener(sessionId);
    ipcRenderer.on(IPC.fleetStatusChanged, handler);
    return () => ipcRenderer.off(IPC.fleetStatusChanged, handler);
  },
  getAttemptSummaries: (sessionIds) => ipcRenderer.invoke(IPC.getAttemptSummaries, sessionIds),
};

contextBridge.exposeInMainWorld('vowe', api);

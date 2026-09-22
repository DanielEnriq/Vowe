import { contextBridge, ipcRenderer } from 'electron';

import type {
  ContextRef,
  LiveTranscriptDelta,
  ConversationChange,
  LiveStatus,
  NormalizedEvent,
  PresenceProfile,
  ProjectConversationChange,
  TemperamentProfile,
  UserProfile,
  VoicePreference,
  VoweRunActivity,
} from '@vowe/core';
import { IPC, type VoweApi } from '../shared/ipc.js';

const api: VoweApi = {
  getStatus: () => ipcRenderer.invoke(IPC.status),
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getSession: (sessionId) => ipcRenderer.invoke(IPC.getSession, sessionId),
  getEvents: (sessionId, limit) =>
    ipcRenderer.invoke(IPC.getEvents, sessionId, limit),
  getEventsByIds: (sessionId, ids) =>
    ipcRenderer.invoke(IPC.getEventsByIds, sessionId, ids),
  getConversation: (sessionId) =>
    ipcRenderer.invoke(IPC.getConversation, sessionId),
  refreshInterpretation: (sessionId) =>
    ipcRenderer.invoke(IPC.refreshInterpretation, sessionId),
  askCompanion: (sessionId, question, contextRefs) =>
    ipcRenderer.invoke(IPC.ask, sessionId, question, contextRefs),
  getDeliveries: (sessionId) => ipcRenderer.invoke(IPC.getDeliveries, sessionId),
  sendInstruction: (sessionId, text) =>
    ipcRenderer.invoke(IPC.sendInstruction, sessionId, text),
  launchSession: (cwd, prompt) => ipcRenderer.invoke(IPC.launch, cwd, prompt),
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

  getRunActivity: () => ipcRenderer.invoke(IPC.getRunActivity),

  startObserving: (sessionId) =>
    ipcRenderer.invoke(IPC.startObserving, sessionId),
  stopObserving: (sessionId) => ipcRenderer.invoke(IPC.stopObserving, sessionId),
  getObservation: (sessionId) =>
    ipcRenderer.invoke(IPC.getObservation, sessionId),
  setCommunicationPreference: (sessionId, preference) =>
    ipcRenderer.invoke(IPC.setPreference, sessionId, preference),

  // The SDP offer goes out and the answer comes back; the API key never
  // crosses this boundary in either direction.
  openArtifact: (ref: ContextRef) => ipcRenderer.invoke(IPC.openArtifact, ref),

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
  onRunActivity: (listener) => {
    const handler = (_: unknown, activity: VoweRunActivity) => listener(activity);
    ipcRenderer.on(IPC.runActivityChanged, handler);
    return () => ipcRenderer.off(IPC.runActivityChanged, handler);
  },
};

contextBridge.exposeInMainWorld('vowe', api);

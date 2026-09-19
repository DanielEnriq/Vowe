import { contextBridge, ipcRenderer } from 'electron';

import type { LiveStatus, NormalizedEvent } from '@vowe/core';
import { IPC, type VoweApi } from '../shared/ipc.js';

const api: VoweApi = {
  getStatus: () => ipcRenderer.invoke(IPC.status),
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
  askCompanion: (sessionId, question) =>
    ipcRenderer.invoke(IPC.ask, sessionId, question),
  sendInstruction: (sessionId, text) =>
    ipcRenderer.invoke(IPC.sendInstruction, sessionId, text),
  launchSession: (cwd, prompt) => ipcRenderer.invoke(IPC.launch, cwd, prompt),
  chooseFolder: () => ipcRenderer.invoke(IPC.chooseFolder),

  startObserving: (sessionId) =>
    ipcRenderer.invoke(IPC.startObserving, sessionId),
  stopObserving: (sessionId) => ipcRenderer.invoke(IPC.stopObserving, sessionId),
  getObservation: (sessionId) =>
    ipcRenderer.invoke(IPC.getObservation, sessionId),
  setCommunicationPreference: (sessionId, preference) =>
    ipcRenderer.invoke(IPC.setPreference, sessionId, preference),

  // The SDP offer goes out and the answer comes back; the API key never
  // crosses this boundary in either direction.
  startLive: (sessionId, sdpOffer) =>
    ipcRenderer.invoke(IPC.startLive, sessionId, sdpOffer),
  stopLive: () => ipcRenderer.invoke(IPC.stopLive),
  getLiveStatus: () => ipcRenderer.invoke(IPC.liveStatus),

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
  onLiveStatus: (listener) => {
    const handler = (_: unknown, status: LiveStatus) => listener(status);
    ipcRenderer.on(IPC.liveStatusChanged, handler);
    return () => ipcRenderer.off(IPC.liveStatusChanged, handler);
  },
};

contextBridge.exposeInMainWorld('vowe', api);

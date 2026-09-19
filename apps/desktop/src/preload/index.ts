import { contextBridge, ipcRenderer } from 'electron';

import type { NormalizedEvent } from '@vowe/core';
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
};

contextBridge.exposeInMainWorld('vowe', api);

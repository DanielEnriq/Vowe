import type { VoweApi } from '../shared/ipc.js';

declare global {
  interface Window {
    vowe: VoweApi;
  }
}

export {};

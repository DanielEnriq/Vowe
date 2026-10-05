import type { InstructionResult, TranscriptDelta, TranscriptPage } from '@vowe/core';

export { useTranscript } from '../hooks/useVoweData.js';

/** The fleet transcript calls on the bridge. Null when the bridge lacks them. */
export interface FleetTranscriptApi {
  getTranscript(sessionId: string, options?: { before?: string; limit?: number }): Promise<TranscriptPage>;
  onTranscriptDelta(listener: (delta: TranscriptDelta) => void): () => void;
  sendToAgent(sessionId: string, text: string): Promise<InstructionResult>;
  interruptAgent(sessionId: string): Promise<boolean>;
}

export function fleetTranscriptApi(): FleetTranscriptApi | null {
  const api = typeof window === 'undefined' ? undefined : (window.vowe as Partial<FleetTranscriptApi> | undefined);
  if (!api || typeof api.getTranscript !== 'function' || typeof api.onTranscriptDelta !== 'function') return null;
  return api as FleetTranscriptApi;
}

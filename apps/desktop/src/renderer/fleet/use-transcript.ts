import { useCallback, useEffect, useRef, useState } from 'react';

import type { InstructionResult, TranscriptDelta, TranscriptItem, TranscriptPage } from '@vowe/core';
import { applyTranscriptDelta } from '@vowe/core/fleet-transcript';

import type { Streaming } from '../state/fleet-transcript.js';

/**
 * The fleet transcript calls, read off the bridge by name so this view does
 * not depend on them being declared yet. Null when the bridge has none.
 */
export interface FleetTranscriptApi {
  getTranscript(sessionId: string, options?: { before?: string; limit?: number }): Promise<TranscriptPage>;
  onTranscriptDelta(listener: (delta: TranscriptDelta) => void): () => void;
  sendToAgent(sessionId: string, text: string): Promise<InstructionResult>;
  interruptAgent(sessionId: string): Promise<boolean>;
}

export function fleetTranscriptApi(): FleetTranscriptApi | null {
  const api = (typeof window === 'undefined' ? undefined : window.vowe) as unknown as Partial<FleetTranscriptApi> | undefined;
  if (!api || typeof api.getTranscript !== 'function' || typeof api.onTranscriptDelta !== 'function') return null;
  return api as FleetTranscriptApi;
}

export interface TranscriptState {
  items: TranscriptItem[];
  streaming: Streaming;
  loaded: boolean;
  live: boolean;
  /** Whether an older page is there to load. */
  hasOlder: boolean;
  loadOlder(): Promise<void>;
}

/**
 * A session's transcript: the newest page, kept current by deltas. Deltas
 * that arrive before the page are applied over it once it lands.
 */
export function useTranscript(sessionId: string | null): TranscriptState {
  const [state, setState] = useState<{ items: TranscriptItem[]; streaming: Streaming; loaded: boolean; live: boolean; before: string | null }>(
    { items: [], streaming: {}, loaded: false, live: false, before: null },
  );
  const olderBusy = useRef(false);

  useEffect(() => {
    setState({ items: [], streaming: {}, loaded: false, live: false, before: null });
    const api = fleetTranscriptApi();
    if (!sessionId || !api) {
      setState((current) => ({ ...current, loaded: true }));
      return;
    }
    let alive = true;
    let early: TranscriptDelta[] | null = [];
    const off = api.onTranscriptDelta((delta) => {
      if (!alive || delta.sessionId !== sessionId) return;
      if (early) {
        early.push(delta);
        return;
      }
      setState((current) => ({ ...current, ...applyTranscriptDelta(current.items, current.streaming, delta) }));
    });
    void api
      .getTranscript(sessionId)
      .then((page) => {
        if (!alive) return;
        let next: { items: TranscriptItem[]; streaming: Streaming } = { items: page.items, streaming: {} };
        for (const delta of early ?? []) next = applyTranscriptDelta(next.items, next.streaming, delta);
        early = null;
        setState({ ...next, loaded: true, live: page.live, before: page.before });
      })
      .catch(() => {
        if (!alive) return;
        early = null;
        setState((current) => ({ ...current, loaded: true }));
      });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);

  const before = state.before;
  const loadOlder = useCallback(async () => {
    const api = fleetTranscriptApi();
    if (!api || !sessionId || !before || olderBusy.current) return;
    olderBusy.current = true;
    try {
      const page = await api.getTranscript(sessionId, { before });
      setState((current) => {
        if (current.before !== before) return current;
        const have = new Set(current.items.map((item) => item.id));
        return {
          ...current,
          items: [...page.items.filter((item) => !have.has(item.id)), ...current.items],
          before: page.before,
        };
      });
    } finally {
      olderBusy.current = false;
    }
  }, [sessionId, before]);

  return {
    items: state.items,
    streaming: state.streaming,
    loaded: state.loaded,
    live: state.live,
    hasOlder: state.before !== null,
    loadOlder,
  };
}

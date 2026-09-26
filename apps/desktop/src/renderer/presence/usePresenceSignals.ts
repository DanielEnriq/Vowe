import { useEffect, useMemo, useState } from 'react';

import type { AgentSession, VoweRunActivity } from '@vowe/core';
import {
  resolvePresenceState,
  type PresenceSignals,
  type PresenceState,
} from '@vowe/core/presence';

import type { AppStatus } from '../../shared/ipc.js';
import { isLive } from '../components/ui.js';

/**
 * Which executions mean Vowe is answering the developer.
 *
 * The distinction this file exists to protect: a coding worker running while
 * Vowe follows it is *observing*, and only Vowe's own investigation on the
 * developer's behalf is *thinking*. They are different lanes in the execution
 * record and they must stay different on screen.
 */
const INVESTIGATING = new Set(['investigation', 'live_response']);

/** Vowe reading the work rather than being asked about it. */
const FOLLOWING = new Set([
  'observation',
  'interpretation',
  'communication_decision',
  'decision',
]);

/**
 * Runtime truth, gathered once for the whole application.
 *
 * Every field comes from something that already exists: the execution lane for
 * what Vowe is running, the live bridge for the call and its playback, the
 * observation harness for what is being followed, and the Project Room's read
 * model for Needs You. Nothing here is inferred from timing and nothing is
 * invented — a signal the application cannot yet produce stays false.
 */
export function usePresenceSignals(options: {
  status: AppStatus | null;
  sessions: AgentSession[];
}): { signals: PresenceSignals; state: PresenceState } {
  const { status, sessions } = options;

  const [live, setLive] = useState<{ connected: boolean; playbackActive: boolean }>({
    connected: false,
    playbackActive: false,
  });
  const [runs, setRuns] = useState<VoweRunActivity>({ kinds: [] });
  const [observing, setObserving] = useState(false);
  const [needsAttention, setNeedsAttention] = useState(false);

  // Live status is pushed, so this is a subscription and not a poll.
  useEffect(() => {
    let cancelled = false;
    void window.vowe
      .getLiveStatus()
      .then((next) => {
        if (!cancelled) {
          setLive({ connected: next.connected, playbackActive: next.playbackActive });
        }
      })
      .catch(() => undefined);
    const off = window.vowe.onLiveStatus((next) => {
      setLive({ connected: next.connected, playbackActive: next.playbackActive });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.vowe
      .getRunActivity()
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => undefined);
    return window.vowe.onRunActivity(setRuns);
  }, []);

  // Only live sessions can be observed or need anything, so only live sessions
  // are asked about. `attentionFor` returns nothing for the rest by design.
  const liveIds = useMemo(
    () => sessions.filter(isLive).map((session) => session.id),
    [sessions],
  );
  const liveProjectIds = useMemo(
    () => [
      ...new Set(
        sessions
          .filter(isLive)
          .map((session) => session.projectId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ],
    [sessions],
  );

  const liveKey = liveIds.join(',');
  const projectKey = liveProjectIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const ids = liveKey ? liveKey.split(',') : [];

    const read = async (): Promise<void> => {
      const views = await Promise.all(
        ids.map((id) => window.vowe.getObservation(id).catch(() => null)),
      );
      if (!cancelled) {
        setObserving(views.some((view) => view?.status.observing === true));
      }
    };

    void read();
    const off = window.vowe.onObservationChanged(() => {
      void read();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [liveKey]);

  useEffect(() => {
    let cancelled = false;
    const ids = projectKey ? projectKey.split(',') : [];

    // Coalesced like the room's brief: one pass in flight, at most one after.
    let reading = false;
    let again = false;
    const read = async (): Promise<void> => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const briefs = await Promise.all(
          ids.map((id) => window.vowe.getProjectBrief(id).catch(() => null)),
        );
        if (!cancelled) {
          setNeedsAttention(briefs.some((brief) => (brief?.needsAttention.length ?? 0) > 0));
        }
      } finally {
        reading = false;
        if (again && !cancelled) {
          again = false;
          setTimeout(() => void read(), 250);
        }
      }
    };

    void read();
    const off = window.vowe.onSessionsChanged(() => {
      void read();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [projectKey]);

  const signals: PresenceSignals = {
    // No model is not a degraded presence, it is an honest one: Vowe cannot
    // interpret anything, and a presence that kept breathing would say it could.
    voweAvailable: status?.llmConfigured ?? false,
    // The handshake belongs to whoever pressed Talk. From here a call is up or
    // it is not, and claiming otherwise would be guessing.
    liveJoining: false,
    liveConnected: live.connected,
    // The sidebar does not own the microphone, so it cannot know about mute.
    // A connected call is a call being listened to until something says other.
    liveMuted: false,
    livePlaybackActive: live.playbackActive,
    needsAttention,
    investigating: runs.kinds.some((kind) => INVESTIGATING.has(kind)),
    following: observing || runs.kinds.some((kind) => FOLLOWING.has(kind)),
  };

  return { signals, state: resolvePresenceState(signals) };
}

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AgentSession,
  ConversationDelivery,
  ConversationEntry,
  NormalizedEvent,
  PresenceProfile,
  Project,
  ProjectBrief,
  ProjectConversationEntry,
  SessionAttentionCursor,
  TemperamentProfile,
  VoicePreference,
  WorkerMilestone,
} from '@vowe/core';
import { DEFAULT_PRESENCE_PROFILE } from '@vowe/core/presence';
import { DEFAULT_TEMPERAMENT, workerMilestones } from '@vowe/core/projections';

import type { AppStatus } from '../../shared/ipc.js';

/**
 * The renderer's reads, each one a subscription rather than a poll.
 *
 * Every hook here follows the same shape: fetch on mount, re-fetch when the
 * main process says the underlying thing moved. Nothing recomputes a
 * projection the main process already owns — a room that derived its own
 * synthesis could disagree with the one that produced it.
 */

/** Projects and sessions, which every room needs and nothing owns alone. */
export function useWorkspace(): {
  projects: Project[];
  sessions: AgentSession[];
  refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);

  const refresh = useCallback(async () => {
    const [nextProjects, nextSessions] = await Promise.all([
      window.vowe.listProjects(),
      window.vowe.listSessions(),
    ]);
    setProjects(nextProjects);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    void refresh();
    return window.vowe.onSessionsChanged(() => void refresh());
  }, [refresh]);

  return { projects, sessions, refresh };
}

export function useAppStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(() => {
    void window.vowe.getStatus().then(setStatus).catch(() => undefined);
  }, []);
  return status;
}

/**
 * The Project Room's whole read model, re-fetched on the three things that
 * can change it. The contract names these exactly.
 */
export function useProjectBrief(projectId: string | null): ProjectBrief | null {
  const [brief, setBrief] = useState<ProjectBrief | null>(null);

  useEffect(() => {
    if (!projectId) {
      setBrief(null);
      return;
    }
    let live = true;
    const load = () => {
      void window.vowe
        .getProjectBrief(projectId)
        .then((next) => {
          if (live) setBrief(next);
        })
        .catch(() => undefined);
    };

    load();
    const unsubscribes = [
      window.vowe.onSessionsChanged(load),
      window.vowe.onObservationChanged(() => load()),
      window.vowe.onProjectKnowledgeChanged((changed) => {
        if (changed === projectId) load();
      }),
    ];
    return () => {
      live = false;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [projectId]);

  return brief;
}

export interface SessionThread {
  entries: ConversationEntry[];
  deliveries: ConversationDelivery[];
  events: NormalizedEvent[];
  milestones: WorkerMilestone[];
  reload: () => void;
}

/**
 * One session's conversation, what was actually delivered of it, and the few
 * worker events worth a line beside it.
 *
 * Milestones are selected in core and merely rendered here — the inclusion
 * rules are a product decision, not a component's.
 */
export function useSessionThread(sessionId: string | null): SessionThread {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [deliveries, setDeliveries] = useState<ConversationDelivery[]>([]);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);

  const load = useCallback(() => {
    if (!sessionId) return;
    void Promise.all([
      window.vowe.getConversation(sessionId),
      window.vowe.getDeliveries(sessionId),
      window.vowe.getEvents(sessionId, 400),
    ])
      .then(([nextEntries, nextDeliveries, nextEvents]) => {
        setEntries(nextEntries);
        setDeliveries(nextDeliveries);
        setEvents(nextEvents);
      })
      .catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    setEntries([]);
    setDeliveries([]);
    setEvents([]);
    load();
    if (!sessionId) return;

    const unsubscribes = [
      window.vowe.onConversationChanged((change) => {
        if (change.sessionId === sessionId) load();
      }),
      window.vowe.onSessionEvent((event) => {
        if (event.sessionId === sessionId) load();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [sessionId, load]);

  const milestones = useMemo(() => workerMilestones(events, { limit: 40 }), [events]);

  return { entries, deliveries, events, milestones, reload: load };
}

/** A project's own thread, with its own change event. */
export function useProjectThread(projectId: string | null): {
  entries: ProjectConversationEntry[];
  reload: () => void;
} {
  const [entries, setEntries] = useState<ProjectConversationEntry[]>([]);

  const load = useCallback(() => {
    if (!projectId) return;
    void window.vowe
      .getProjectConversation(projectId)
      .then(setEntries)
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    setEntries([]);
    load();
    if (!projectId) return;
    return window.vowe.onProjectConversationChanged((change) => {
      if (change.projectId === projectId) load();
    });
  }, [projectId, load]);

  return { entries, reload: load };
}

/**
 * The appearance profile, live.
 *
 * Presence Studio writes it and every other mount reads it, so this holds one
 * copy and hands back a setter rather than each mount fetching its own and
 * drifting apart.
 */
export function usePresenceProfile(): [
  PresenceProfile,
  (next: PresenceProfile) => Promise<void>,
] {
  const [profile, setProfile] = useState<PresenceProfile>(DEFAULT_PRESENCE_PROFILE);

  useEffect(() => {
    void window.vowe
      .getPresenceProfile()
      .then(setProfile)
      .catch(() => undefined);
  }, []);

  const save = useCallback(async (next: PresenceProfile) => {
    // Optimistic, then corrected by what was actually stored: the presence
    // should follow the developer's hand, not the disk.
    setProfile(next);
    const stored = await window.vowe.setPresenceProfile(next);
    setProfile(stored);
  }, []);

  return [profile, save];
}

export function useTemperament(): [
  TemperamentProfile,
  (next: TemperamentProfile) => Promise<void>,
] {
  const [temperament, setTemperament] = useState<TemperamentProfile>(DEFAULT_TEMPERAMENT);

  useEffect(() => {
    void window.vowe
      .getTemperament()
      .then(setTemperament)
      .catch(() => undefined);
  }, []);

  const save = useCallback(async (next: TemperamentProfile) => {
    setTemperament(next);
    const stored = await window.vowe.setTemperament(next);
    setTemperament(stored);
  }, []);

  return [temperament, save];
}

export function useVoicePreference(): [
  VoicePreference,
  (next: VoicePreference) => Promise<void>,
] {
  const [preference, setPreference] = useState<VoicePreference>({ voice: null });

  useEffect(() => {
    void window.vowe
      .getVoicePreference()
      .then(setPreference)
      .catch(() => undefined);
  }, []);

  const save = useCallback(async (next: VoicePreference) => {
    setPreference(next);
    const stored = await window.vowe.setVoicePreference(next);
    setPreference(stored);
  }, []);

  return [preference, save];
}

/**
 * Where the developer's attention last was in this session, read once when the
 * room opens.
 *
 * Read before the mark is moved, on purpose: opening the room is what makes
 * the checkpoint worth showing, and marking first would erase it.
 */
export function useAttentionCursor(
  sessionId: string | null,
  latestSeq: number,
): SessionAttentionCursor | null {
  const [cursor, setCursor] = useState<SessionAttentionCursor | null>(null);

  useEffect(() => {
    setCursor(null);
    if (!sessionId) return;
    let live = true;
    void window.vowe
      .getAttentionCursor(sessionId)
      .then((next) => {
        if (live) setCursor(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sessionId]);

  // Moving the mark is what "I have seen this" means, and it happens after the
  // checkpoint above has already been computed from the old one.
  useEffect(() => {
    if (!sessionId || latestSeq <= 0) return;
    const timer = setTimeout(() => {
      void window.vowe.markSessionViewed(sessionId, latestSeq).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [sessionId, latestSeq]);

  return cursor;
}

/**
 * Whether Vowe is actually following this session.
 *
 * Read rather than assumed. The header says "Observing" or not, and a room
 * that simply asserted the former would be claiming Vowe could see work it
 * might not be watching at all.
 */
export function useObservationStatus(sessionId: string | null): {
  observing: boolean;
  catchingUp: boolean;
} {
  const [status, setStatus] = useState({ observing: false, catchingUp: false });

  useEffect(() => {
    setStatus({ observing: false, catchingUp: false });
    if (!sessionId) return;

    let live = true;
    const load = () => {
      void window.vowe
        .getObservation(sessionId)
        .then((view) => {
          if (live) {
            setStatus({
              observing: view.status.observing,
              catchingUp: view.status.catchingUp,
            });
          }
        })
        .catch(() => undefined);
    };

    load();
    const unsubscribe = window.vowe.onObservationChanged((changed) => {
      if (changed === sessionId) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId]);

  return status;
}

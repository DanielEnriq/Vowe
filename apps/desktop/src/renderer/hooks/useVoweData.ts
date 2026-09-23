import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentSession,
  AppearanceSetting,
  InvestigationProgress,
  ConversationDelivery,
  ConversationEntry,
  NormalizedEvent,
  PersistedWorkbench,
  PresenceProfile,
  Project,
  ProjectBrief,
  ProjectConversationEntry,
  ProjectMemoryRecord,
  SessionAttentionCursor,
  TemperamentProfile,
  WindowNote,
  VoicePreference,
  WorkerMilestone,
} from '@vowe/core';
import { DEFAULT_PRESENCE_PROFILE } from '@vowe/core/presence';
import {
  DEFAULT_APPEARANCE_SETTING,
  DEFAULT_TEMPERAMENT,
  workerMilestones,
} from '@vowe/core/projections';

import type { AppStatus } from '../../shared/ipc.js';
import {
  NOTHING_STREAMED,
  QUIET,
  commitStreamed,
  gather,
  isReplaced,
  liveInvestigationReducer,
  type LiveInvestigation,
  type StreamedText,
} from '../state/live-investigation.js';

export type { LiveInvestigation } from '../state/live-investigation.js';

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
 * What Vowe has worked out about this project and kept.
 *
 * Read for the idle room, which has space to say what has been learned here
 * recently. No model runs for it and nothing is summarised: these are the
 * records `ProjectMemoryStore` already wrote, newest first. An empty list is
 * an answer — the room then omits the section rather than filling it.
 */
export function useProjectMemories(projectId: string | null): ProjectMemoryRecord[] {
  const [records, setRecords] = useState<ProjectMemoryRecord[]>([]);

  useEffect(() => {
    setRecords([]);
    if (!projectId) return;
    let live = true;
    const load = () => {
      void window.vowe
        .listProjectMemories(projectId)
        .then((next) => {
          if (live) setRecords(next);
        })
        .catch(() => undefined);
    };

    load();
    // The same event the brief listens to: a new memory is a change to what
    // Vowe knows about this repository.
    const unsubscribe = window.vowe.onProjectKnowledgeChanged((changed) => {
      if (changed === projectId) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [projectId]);

  return records;
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

/**
 * Dark, light, or the machine's.
 *
 * Only the *preference* lives here. What the window is actually showing comes
 * from `prefers-color-scheme` — see `shell/theme.ts` — because with `system`
 * chosen the answer changes without anyone asking for it.
 */
export function useAppearance(): [
  AppearanceSetting,
  (next: AppearanceSetting) => Promise<void>,
] {
  const [setting, setSetting] = useState<AppearanceSetting>(DEFAULT_APPEARANCE_SETTING);

  useEffect(() => {
    void window.vowe.getAppearance().then(setSetting).catch(() => undefined);
  }, []);

  const save = useCallback(async (next: AppearanceSetting) => {
    setSetting(next);
    const stored = await window.vowe.setAppearance(next);
    setSetting(stored);
  }, []);

  return [setting, save];
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
/**
 * The desk a session was left on, read once and written back as it changes.
 *
 * The room hands its current desk in rather than being handed a setter: every
 * change to the desk is already a reducer action, and a second way to save
 * would be a second thing to keep in step with it.
 *
 * Writes are near-immediate and flush on the way out. A desk change is a
 * deliberate, sparse act — open, close, activate, keep — not a keystroke, so
 * there is nothing worth coalescing over a second, and "come back and your
 * workspace is still there" is the whole promise. Switching sessions or
 * closing the room cannot outrun the write.
 */
export function useSessionWorkbench(
  sessionId: string | null,
  desk: PersistedWorkbench,
): PersistedWorkbench | null {
  const [stored, setStored] = useState<PersistedWorkbench | null>(null);
  /*
   * The read has landed, so it is safe to write.
   *
   * Without this, the empty desk of the first render is written back before
   * the stored one arrives, and restoring a session erases it instead.
   */
  const hydrated = useRef(false);

  useEffect(() => {
    hydrated.current = false;
    setStored(null);
    if (!sessionId) return;
    let live = true;
    void window.vowe
      .getWorkbench(sessionId)
      .then((next) => {
        if (!live) return;
        setStored(next);
        hydrated.current = true;
      })
      .catch(() => {
        // A desk that cannot be read is a desk that starts empty. Writing is
        // still allowed, so today's tabs are not lost to yesterday's failure.
        if (live) hydrated.current = true;
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !hydrated.current) return;
    let pending = true;
    const save = () => {
      if (!pending) return;
      pending = false;
      void window.vowe.saveWorkbench(sessionId, desk).catch(() => undefined);
    };
    const timer = setTimeout(save, 150);
    return () => {
      clearTimeout(timer);
      // Leaving the room is not a reason to lose the last thing that changed.
      save();
    };
  }, [sessionId, desk]);

  return stored;
}

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
  /** The observer's own notes, which is where a checkpoint's prose comes from. */
  notes: WindowNote[];
} {
  const [status, setStatus] = useState<{
    observing: boolean;
    catchingUp: boolean;
    notes: WindowNote[];
  }>({ observing: false, catchingUp: false, notes: [] });

  useEffect(() => {
    setStatus({ observing: false, catchingUp: false, notes: [] });
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
              notes: view.notes,
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

function useInvestigationProgress(
  matches: (scope: InvestigationProgress['scope']) => boolean,
  key: string | null,
  /**
   * Entries already in the thread.
   *
   * The live view is not dismissed when the investigation reports it finished,
   * because at that moment the room has the streamed answer and not yet the
   * durable one, and clearing would blank the answer the developer is reading.
   * It is dismissed when the entry it was streaming towards actually appears,
   * which makes the swap a replacement.
   */
  settledIds: readonly string[],
): LiveInvestigation {
  const [state, setState] = useState<LiveInvestigation>(QUIET);
  const pending = useRef<StreamedText>(NOTHING_STREAMED);
  const frame = useRef<number | null>(null);
  const matcher = useRef(matches);
  matcher.current = matches;

  useEffect(() => {
    setState(QUIET);
    pending.current = NOTHING_STREAMED;
    if (!key) return;

    /*
     * One commit per frame, holding everything that arrived during it.
     *
     * The coalescing is for React's benefit and changes nothing about the
     * text: deltas are appended to the buffer the instant they land, and the
     * frame simply decides when to hand the accumulated string over. A
     * provider that sends one character at a time and one that sends two
     * hundred both end up with the same string on screen, just as promptly.
     */
    const flush = (): void => {
      frame.current = null;
      const batch = pending.current;
      pending.current = NOTHING_STREAMED;
      setState((current) => commitStreamed(current, batch));
    };

    const schedule = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(flush);
    };

    const off = window.vowe.onInvestigationProgress((progress) => {
      // Scoped: a question running in another room must not make this one look
      // busy, or put another room's words in this one.
      if (!matcher.current(progress.scope)) return;

      if (progress.phase === 'reasoning' || progress.phase === 'answer') {
        pending.current = gather(pending.current, progress);
        schedule();
        return;
      }

      // A new investigation starts from silence, buffer included.
      if (progress.phase === 'started') pending.current = NOTHING_STREAMED;
      setState((current) => liveInvestigationReducer(current, progress));
    });

    return () => {
      off();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [key]);

  // The swap: the moment the answer exists durably, the live copy goes.
  const replaced = isReplaced(state, settledIds);
  useEffect(() => {
    if (replaced) setState(QUIET);
  }, [replaced]);

  return state;
}

/**
 * The investigation currently in flight for one session, if any.
 *
 * Driven by the main process rather than polled: the runner reports each
 * lookup as it records it and each piece of language as the model emits it.
 */
export function useInvestigation(
  sessionId: string | null,
  settledIds: readonly string[] = [],
): LiveInvestigation {
  const matches = useCallback(
    (scope: InvestigationProgress['scope']) =>
      'sessionId' in scope && scope.sessionId === sessionId,
    [sessionId],
  );
  return useInvestigationProgress(matches, sessionId, settledIds);
}

/** The same, for a project's own thread. */
export function useProjectInvestigation(
  projectId: string | null,
  settledIds: readonly string[] = [],
): LiveInvestigation {
  const matches = useCallback(
    (scope: InvestigationProgress['scope']) =>
      'projectId' in scope && scope.projectId === projectId,
    [projectId],
  );
  return useInvestigationProgress(matches, projectId, settledIds);
}

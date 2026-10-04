import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { AgentSession, FleetLayout, FleetPoint, Project } from '@vowe/core';

import { messageOf } from '../components/ui.js';
import { useCaptainExchanges, useFleetLayout, useFleetStatuses } from '../hooks/useVoweData.js';
import { BackIcon, PlusIcon } from '../shell/icons.js';
import { RoomIdentity } from '../shell/TopChrome.js';
import { needsYouCount, placeCaptain, placeUnplaced } from '../state/fleet-canvas.js';
import type { RunMode } from '../state/fleet-run.js';
import { countParts, fleetCounts, ipcMessage } from '../state/project-fleet.js';
import { isCurrent } from '../state/session-visibility.js';
import { FleetCanvas } from './FleetCanvas.js';
import { FleetCompare } from './FleetCompare.js';
import { FleetPanes } from './FleetPanes.js';
import { FleetQuestions } from './FleetQuestions.js';
import { NewRunSheet } from './NewRunSheet.js';
import type { FleetTab, FleetViewProps } from './types.js';

interface Props {
  project: Project;
  /** Every session; the room keeps its project's. */
  sessions: readonly AgentSession[];
  tab: FleetTab;
  /** Providers that can launch here. */
  providers: readonly string[];
  onTab: (tab: FleetTab) => void;
  onHome: () => void;
  onOpenSession: (sessionId: string) => void;
}

const TABS: { tab: FleetTab; label: string }[] = [
  { tab: 'canvas', label: 'Canvas' },
  { tab: 'panes', label: 'Panes' },
  { tab: 'compare', label: 'Compare' },
  { tab: 'questions', label: 'Questions' },
];

/**
 * The fleet: a band saying how the project's agents are doing, and the canvas
 * or one of the views beside it.
 *
 * The room owns the layout — every change from the canvas or the run sheet is
 * applied to the newest copy and saved — and puts any current session of the
 * project that has no node yet into free space, never moving one that has.
 */
export function FleetRoom({ project, sessions, tab, providers, onTab, onHome, onOpenSession }: Props): ReactElement {
  const { layout, loaded, save } = useFleetLayout(project.id);
  const latest = useRef(layout);
  latest.current = layout;
  const apply = useCallback((change: (current: FleetLayout) => FleetLayout) => {
    if (!loaded) return;
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    void save(next);
  }, [loaded, save]);

  const [now] = useState(() => Date.now());
  const projectSessions = useMemo(() => sessions.filter((session) => session.projectId === project.id), [sessions, project.id]);
  const onCanvas = useMemo(
    () => new Set(layout.nodes.map((node) => node.sessionId).filter((id): id is string => id !== null)),
    [layout.nodes],
  );
  const shownSessions = useMemo(
    () => projectSessions.filter((session) => onCanvas.has(session.id) || isCurrent(session, { now })),
    [projectSessions, onCanvas, now],
  );
  const watched = useMemo(() => [...new Set([...onCanvas, ...shownSessions.map((session) => session.id)])].sort(), [onCanvas, shownSessions]);
  const statuses = useFleetStatuses(watched);
  const { exchanges } = useCaptainExchanges(project.id);
  const counts = fleetCounts(statuses, [...onCanvas]);
  const waiting = needsYouCount(exchanges);

  // Sessions taken off the canvas by hand stay off it.
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed(project.id));
  useEffect(() => setDismissed(readDismissed(project.id)), [project.id]);
  const dismiss = (sessionIds: string[]) => {
    setDismissed((current) => {
      const next = new Set([...current, ...sessionIds]);
      writeDismissed(project.id, next);
      return next;
    });
  };

  // While something is launching, its sessions are its own to place.
  const [launching, setLaunching] = useState(0);
  const busy = useCallback((on: boolean) => setLaunching((count) => Math.max(0, count + (on ? 1 : -1))), []);

  const currentIds = useMemo(
    () => projectSessions.filter((session) => isCurrent(session, { now: Date.now() })).map((session) => session.id),
    [projectSessions],
  );
  useEffect(() => {
    if (!loaded || launching > 0) return;
    apply((current) => placeUnplaced(current, currentIds, dismissed));
  }, [loaded, launching, currentIds, dismissed, apply, layout]);

  const defaultFolder = project.folders.find((folder) => folder.isDefault)?.path ?? project.repoRoot;
  const spawnCaptain = async (near: FleetPoint): Promise<string | null> => {
    busy(true);
    try {
      const session = await window.vowe.launchCaptain(project.id, defaultFolder);
      apply((current) => placeCaptain(current, session.id, near));
      return null;
    } catch (cause) {
      return ipcMessage(messageOf(cause));
    } finally {
      busy(false);
    }
  };

  const [sheet, setSheet] = useState<{ mode: RunMode; near?: FleetPoint } | null>(null);

  const view: FleetViewProps = { project, sessions: shownSessions, layout, statuses, onOpenSession };
  const parts = countParts(counts);

  return (
    <main className="session-room fc-room">
      <RoomIdentity>
        <button className="fc-back" type="button" onClick={onHome} title={project.name}>
          <BackIcon />
          <span className="fc-back-name">{project.name}</span>
        </button>
        <h1>Fleet</h1>
        <span className="fc-band-spacer" />
        <div className="fc-tally" aria-label="Fleet status">
          {parts.map((part) => (
            <span className="fc-tally-part" key={part.tone}>
              <span className={`dot ${part.tone}`} aria-hidden />
              {part.text}
            </span>
          ))}
        </div>
        <div className="segmented fc-tabs" role="tablist" aria-label="Fleet views">
          {TABS.map((item) => (
            <button
              key={item.tab}
              type="button"
              role="tab"
              aria-selected={tab === item.tab}
              className={tab === item.tab ? 'on' : undefined}
              onClick={() => onTab(item.tab)}
            >
              {item.label}
              {item.tab === 'questions' && waiting > 0 && <span className="fc-badge">{waiting}</span>}
            </button>
          ))}
        </div>
        <button className="button solid compact" type="button" onClick={() => setSheet({ mode: 'parallel' })}>
          <PlusIcon />Run agents
        </button>
      </RoomIdentity>

      <div className="fc-body">
        {tab === 'canvas' ? (
          <FleetCanvas
            sessions={shownSessions}
            layout={layout}
            loaded={loaded}
            statuses={statuses}
            exchanges={exchanges}
            apply={apply}
            onOpenSession={onOpenSession}
            onOpenTab={onTab}
            onSpawnAgent={(near) => setSheet({ mode: 'single', near })}
            onSpawnCaptain={spawnCaptain}
            onDismiss={dismiss}
          />
        ) : tab === 'panes' ? (
          <FleetPanes {...view} />
        ) : tab === 'compare' ? (
          <FleetCompare {...view} />
        ) : (
          <FleetQuestions {...view} />
        )}
      </div>

      {sheet && (
        <NewRunSheet
          project={project}
          layout={layout}
          loaded={loaded}
          providers={providers}
          initialMode={sheet.mode}
          near={sheet.near}
          apply={apply}
          onBusy={busy}
          onClose={() => setSheet(null)}
        />
      )}
    </main>
  );
}

/** Per viewer, and only a convenience: losing it puts those sessions back on the canvas. */
function dismissedKey(projectId: string): string {
  return `vowe.fleet.dismissed.${projectId}`;
}

function readDismissed(projectId: string): Set<string> {
  try {
    const raw = window.localStorage?.getItem(dismissedKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(projectId: string, ids: ReadonlySet<string>): void {
  try {
    window.localStorage?.setItem(dismissedKey(projectId), JSON.stringify([...ids]));
  } catch {
    // Not stored: they come back next time, which is the safe way to be wrong.
  }
}

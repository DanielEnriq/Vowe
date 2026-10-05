import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentSession, FleetLayout, FleetPoint, Project } from '@vowe/core';
import { folderName } from '@vowe/core/projections';

import { messageOf } from '../components/ui.js';
import { useFleetLayout } from '../hooks/useVoweData.js';
import { CloseIcon } from '../shell/icons.js';
import { captainNames } from '../state/fleet-canvas.js';
import {
  PARALLEL_COUNTS,
  applyRun,
  buildRunPlan,
  launchFailureText,
  runButtonLabel,
  runProviders,
  type ParallelCount,
  type RunMode,
} from '../state/fleet-run.js';
import { ipcMessage } from '../state/project-fleet.js';

interface Props {
  project: Project;
  layout: FleetLayout;
  /** Whether `layout` is the stored one yet; nothing is written before it is. */
  loaded: boolean;
  /** Providers that can launch here; Claude Code alone when empty. */
  providers: readonly string[];
  initialMode?: RunMode;
  /** Where on the canvas the new nodes should go. */
  near?: FleetPoint;
  apply: (change: (layout: FleetLayout) => FleetLayout) => void;
  /** Launching started or stopped. */
  onBusy?: (busy: boolean) => void;
  onClose: () => void;
}

/**
 * Run agents: one task, as parallel attempts or a single agent.
 *
 * Each launch is a real worker. Whatever started is put on the canvas — boxed
 * together when they are attempts at the same task, wired to the chosen
 * captain — even if others failed to start.
 */
export function NewRunSheet({ project, layout, loaded, providers, initialMode = 'parallel', near, apply, onBusy, onClose }: Props): ReactElement {
  const offered = runProviders(providers);
  const folders = project.folders.length ? project.folders.map((folder) => folder.path) : [project.repoRoot];
  const defaultFolder = project.folders.find((folder) => folder.isDefault)?.path ?? folders[0]!;
  const captains = layout.nodes.filter((node) => node.role === 'captain');
  const names = captainNames(layout.nodes);

  const [task, setTask] = useState('');
  const [mode, setMode] = useState<RunMode>(initialMode);
  const [count, setCount] = useState<ParallelCount>(3);
  const [provider, setProvider] = useState(offered[0]!);
  const [folder, setFolder] = useState(defaultFolder);
  const [captainId, setCaptainId] = useState<string | null>(captains[0]?.id ?? null);
  const [captainChosen, setCaptainChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskInput = useRef<HTMLTextAreaElement>(null);

  // A captain that left the canvas while the sheet was open is not a choice.
  const chosenCaptain = captainId && captains.some((node) => node.id === captainId) ? captainId : null;
  const plan = buildRunPlan({ task, mode, parallelCount: count, provider, folder, captainId: chosenCaptain });

  useEffect(() => {
    taskInput.current?.focus();
  }, []);
  // The first captain is the default once the layout has arrived, until somebody picks.
  const firstCaptain = captains[0]?.id ?? null;
  useEffect(() => {
    if (!captainChosen && captainId === null && firstCaptain) setCaptainId(firstCaptain);
  }, [captainChosen, captainId, firstCaptain]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const run = async () => {
    if (!plan || busy || !loaded) return;
    setBusy(true);
    onBusy?.(true);
    setError(null);
    const results = await Promise.allSettled(
      Array.from({ length: plan.count }, () => window.vowe.launchSession(plan.folder, plan.task, plan.provider)),
    );
    const started = results
      .filter((result): result is PromiseFulfilledResult<AgentSession> => result.status === 'fulfilled')
      .map((result) => result.value.id);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (started.length) apply((current) => applyRun(current, plan, started, near).layout);
    onBusy?.(false);
    setBusy(false);
    const text = launchFailureText(started.length, plan.count, failure ? ipcMessage(messageOf(failure.reason)) : null);
    if (text) setError(text);
    else onClose();
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="sheet sectioned fc-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-run-title"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div className="sheet-head">
          <h2 id="new-run-title">Run agents</h2>
          <button className="icon-button outlined" type="button" aria-label="Close" disabled={busy} onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="sheet-field">
            <label htmlFor="nr-task">Task</label>
            <textarea
              id="nr-task"
              ref={taskInput}
              className="fc-task"
              rows={3}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void run();
                }
              }}
            />
          </div>

          <div className="fc-modes" role="radiogroup" aria-label="Mode">
            <div
              className={`fc-mode${mode === 'parallel' ? ' on' : ''}`}
              role="radio"
              aria-checked={mode === 'parallel'}
              tabIndex={0}
              onClick={() => setMode('parallel')}
              onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setMode('parallel'); } }}
            >
              <ParallelFigure />
              <div className="fc-mode-row">
                <span className="fc-mode-name">Parallel attempts</span>
                <span className="fc-counts">
                  {PARALLEL_COUNTS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`fc-count${mode === 'parallel' && count === value ? ' on' : ''}`}
                      aria-pressed={mode === 'parallel' && count === value}
                      onClick={(event) => {
                        event.stopPropagation();
                        setMode('parallel');
                        setCount(value);
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </span>
              </div>
            </div>
            <div
              className={`fc-mode${mode === 'single' ? ' on' : ''}`}
              role="radio"
              aria-checked={mode === 'single'}
              tabIndex={0}
              onClick={() => setMode('single')}
              onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setMode('single'); } }}
            >
              <SingleFigure />
              <div className="fc-mode-row">
                <span className="fc-mode-name">Single agent</span>
              </div>
            </div>
          </div>

          <div className="fc-field-row">
            <div className="sheet-field">
              <label htmlFor="nr-agent">Agent</label>
              <select id="nr-agent" className="fc-select" value={provider} onChange={(event) => setProvider(event.target.value)}>
                {offered.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            {folders.length > 1 && (
              <div className="sheet-field">
                <label htmlFor="nr-folder">Folder</label>
                <select id="nr-folder" className="fc-select" value={folder} onChange={(event) => setFolder(event.target.value)}>
                  {folders.map((path) => <option key={path} value={path} title={path}>{folderName(path)}</option>)}
                </select>
              </div>
            )}
            <div className="sheet-field">
              <label htmlFor="nr-captain">Wire to captain</label>
              <select
                id="nr-captain"
                className={`fc-select${chosenCaptain ? ' tint' : ''}`}
                value={chosenCaptain ?? ''}
                onChange={(event) => { setCaptainChosen(true); setCaptainId(event.target.value || null); }}
              >
                {captains.map((node) => <option key={node.id} value={node.id}>{names.get(node.id)}</option>)}
                <option value="">None</option>
              </select>
            </div>
          </div>

          {error && <p className="sheet-error">{error}</p>}
        </div>

        <div className="sheet-foot">
          <button className="link-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button solid" type="submit" disabled={!plan || busy || !loaded}>
            {busy ? 'Starting…' : runButtonLabel(mode, count)}
            <span className="fc-keys">⌘⏎</span>
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The sheet opened from outside the canvas: it reads and writes the project's
 * layout itself, and waits for the stored one before writing.
 */
export function ProjectRunSheet({ project, providers, onClose }: { project: Project; providers: readonly string[]; onClose: () => void }): ReactElement {
  const { layout, loaded, save } = useFleetLayout(project.id);
  const latest = useRef(layout);
  latest.current = layout;
  const apply = useCallback((change: (current: FleetLayout) => FleetLayout) => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    void save(next);
  }, [save]);
  return <NewRunSheet project={project} layout={layout} loaded={loaded} providers={providers} apply={apply} onClose={onClose} />;
}

function ParallelFigure(): ReactElement {
  return (
    <svg className="fc-mode-figure" width="54" height="46" viewBox="0 0 54 46" fill="none" aria-hidden>
      <rect className="fill-strong" x="0" y="18" width="10" height="10" rx="3" />
      <path className="line" d="M10 23.5h10.5M20.5 5.5v36M20.5 5.5H30M20.5 23.5H30M20.5 41.5H30" />
      <rect className="box" x="30.5" y="1.5" width="21" height="8" rx="2" />
      <rect className="box" x="30.5" y="19.5" width="21" height="8" rx="2" />
      <rect className="box" x="30.5" y="37.5" width="21" height="8" rx="2" />
    </svg>
  );
}

function SingleFigure(): ReactElement {
  return (
    <svg className="fc-mode-figure" width="54" height="46" viewBox="0 0 54 46" fill="none" aria-hidden>
      <rect className="box" x="16.5" y="19.5" width="21" height="8" rx="2" />
    </svg>
  );
}

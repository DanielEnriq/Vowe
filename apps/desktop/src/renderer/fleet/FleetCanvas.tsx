import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';

import type {
  AgentSession,
  AttemptSummary,
  CaptainExchange,
  FleetLayout,
  FleetNode,
  FleetPoint,
  FleetStatus,
  FleetView,
  FleetViewport,
} from '@vowe/core';
import {
  FLEET_NODE_HEIGHT,
  FLEET_NODE_RADIUS,
  FLEET_NODE_WIDTH,
  clusterRect,
  fitView,
  nodeById,
  nodeRect,
  screenToCanvas,
  tidy,
  wireRoute,
  wiredAgents,
  zoomAt,
} from '@vowe/core/fleet-model';
import { sessionTitle } from '@vowe/core/projections';

import { useAttemptSummaries } from '../hooks/useVoweData.js';
import {
  INITIAL_CANVAS,
  NO_SELECTION,
  answeredBy,
  attemptWire,
  captainNames,
  clusterChip,
  deleteSelection,
  dragPreview,
  dropNode,
  elapsedLabel,
  groupSelection,
  pruneSelection,
  spawnPoint,
  stepCanvas,
  waitingQuestion,
  wireAt,
  type CanvasEffect,
  type CanvasInput,
  type CanvasState,
} from '../state/fleet-canvas.js';
import { STATUS_TONE, statusWord } from '../state/project-fleet.js';
import type { FleetTab } from './types.js';

interface Props {
  sessions: AgentSession[];
  layout: FleetLayout;
  loaded: boolean;
  statuses: Record<string, FleetStatus>;
  exchanges: CaptainExchange[];
  /** Change the layout; persisted by the room. */
  apply: (change: (layout: FleetLayout) => FleetLayout) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenTab: (tab: FleetTab) => void;
  /** Open the run sheet for one agent, to be put near this canvas point. */
  onSpawnAgent: (near: FleetPoint) => void;
  /** Launch a captain near this point. Resolves to why it could not, or null. */
  onSpawnCaptain: (near: FleetPoint) => Promise<string | null>;
  /** These sessions' nodes were taken off the canvas by hand. */
  onDismiss: (sessionIds: string[]) => void;
}

const HINT_MS = 1600;
const WHEEL_ZOOM = 0.0025;
const BUTTON_ZOOM = 1.2;

/** Keep a gesture's pointer; a pointer the browser no longer tracks is simply not captured. */
function capture(event: ReactPointerEvent): void {
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // Not an active pointer (a synthetic or already-released one): the gesture still works without capture.
  }
}

/**
 * The fleet canvas: agents and captains where somebody put them.
 *
 * Nothing here moves a node except a drag, and nothing re-lays out except the
 * Tidy button. A drop inside a box joins it and a drop outside leaves it; a
 * wire is drawn from a captain to an agent with the wire tool. Every change
 * goes through `apply`, which the room persists.
 */
export function FleetCanvas(props: Props): ReactElement {
  const { sessions, layout, loaded, statuses, exchanges, apply } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<FleetViewport | null>(null);
  const [view, setView] = useState<FleetView>({ scale: 1, x: 48, y: 48 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [canvas, setCanvas] = useState<CanvasState>(INITIAL_CANVAS);
  const canvasRef = useRef(canvas);
  const [hint, setHint] = useState<{ text: string; x: number; y: number } | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [spawning, setSpawning] = useState(false);
  const now = useNow(10_000);

  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const agentSessions = useMemo(
    () => layout.nodes.filter((node) => node.role === 'agent' && node.sessionId).map((node) => node.sessionId!),
    [layout.nodes],
  );
  const summaries = useAttemptSummaries(agentSessions);
  const summaryOf = useMemo(() => new Map(summaries.map((summary) => [summary.sessionId, summary])), [summaries]);

  // ---------------------------------------------------------------- measure
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Fit once, when there is something to fit and somewhere to fit it.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !loaded || !size) return;
    fitted.current = true;
    if (layout.nodes.length) setView(fitView(layout, size));
  }, [loaded, size, layout]);

  // A node or wire that left the canvas leaves the selection too.
  useEffect(() => {
    const pruned = pruneSelection(layout, canvasRef.current.selection);
    if (pruned !== canvasRef.current.selection) commit({ ...canvasRef.current, selection: pruned });
  }, [layout]);

  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  const commit = (next: CanvasState) => {
    canvasRef.current = next;
    setCanvas(next);
  };

  const say = useCallback((text: string, at?: FleetPoint) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    const box = viewport.current;
    setHint({ text, x: at?.x ?? 76, y: at?.y ?? (box ? 24 : 0) });
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  const pointer = (event: { clientX: number; clientY: number }): FleetPoint => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const run = (input: CanvasInput, at?: FleetPoint) => {
    const step = stepCanvas(canvasRef.current, input, layout, viewRef.current);
    if (step.state !== canvasRef.current) commit(step.state);
    if (step.effect) perform(step.effect, at);
  };

  const perform = (effect: CanvasEffect, at?: FleetPoint) => {
    switch (effect.kind) {
      case 'drop':
        apply((current) => dropNode(current, effect.nodeId, effect.at));
        return;
      case 'wire': {
        const tried = attemptWire(layout, effect.fromId, effect.toId);
        if (!tried.ok) { say(tried.reason, at); return; }
        apply((current) => {
          const again = attemptWire(current, effect.fromId, effect.toId);
          return again.ok ? again.layout : current;
        });
        return;
      }
      case 'view':
        setView(effect.view);
        return;
      case 'refuse':
        say(effect.reason, at);
        return;
    }
  };

  // ---------------------------------------------------------------- pointer
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-ui]')) return;
    viewport.current?.focus({ preventScroll: true });
    const screen = pointer(event);
    const point = screenToCanvas(viewRef.current, screen);
    const nodeElement = target.closest<HTMLElement>('[data-node]');
    if (nodeElement) {
      run({ type: 'down-node', nodeId: nodeElement.dataset['node']!, screen, canvas: point, additive: event.shiftKey || event.metaKey }, screen);
    } else {
      const wire = wireAt(layout, point, 6 / viewRef.current.scale);
      if (wire) run({ type: 'down-wire', wireId: wire });
      else run({ type: 'down-empty', screen, view: viewRef.current });
    }
    if (canvasRef.current.gesture.kind !== 'idle') capture(event);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (canvasRef.current.gesture.kind === 'idle') return;
    if (event.buttons === 0) { run({ type: 'cancel' }); return; }
    const screen = pointer(event);
    run({ type: 'move', screen, canvas: screenToCanvas(viewRef.current, screen) });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (canvasRef.current.gesture.kind === 'idle') return;
    run({ type: 'up' }, pointer(event));
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-ui]')) return;
    const id = target.closest<HTMLElement>('[data-node]')?.dataset['node'];
    const sessionId = id ? nodeById(layout, id)?.sessionId : null;
    if (sessionId) props.onOpenSession(sessionId);
  };

  // Wheel pans; with ⌘ or a pinch it zooms about the pointer. Non-passive, so the page does not scroll.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setView((current) => (event.ctrlKey || event.metaKey
        ? zoomAt(current, Math.exp(-event.deltaY * WHEEL_ZOOM * (event.ctrlKey ? 4 : 1)), anchor)
        : { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // ------------------------------------------------------------------ keys
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Escape') { run({ type: 'escape' }); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selection = canvasRef.current.selection;
      if (!selection.wire && selection.nodes.length === 0) return;
      event.preventDefault();
      const removed = deleteSelection(layout, selection);
      apply((current) => deleteSelection(current, selection).layout);
      if (removed.sessions.length) props.onDismiss(removed.sessions);
      commit({ ...canvasRef.current, selection: NO_SELECTION });
    }
  };

  // ------------------------------------------------------------------ acts
  const centre = () => spawnPoint(viewRef.current, size ?? { width: 800, height: 600 });
  const spawnCaptain = async () => {
    if (spawning) return;
    setSpawning(true);
    const failed = await props.onSpawnCaptain(centre());
    setSpawning(false);
    if (failed) say(failed);
  };
  const briefOf = (sessionId: string | null): string => {
    const session = sessionId ? byId.get(sessionId) : undefined;
    return session ? session.task?.trim() || sessionTitle(session) : '';
  };
  const group = () => {
    const ids = canvasRef.current.selection.nodes;
    const grouped = groupSelection(layout, ids, briefOf);
    if (!grouped.ok) { say(grouped.reason); return; }
    apply((current) => {
      const again = groupSelection(current, ids, briefOf);
      return again.ok ? again.layout : current;
    });
  };
  const zoomBy = (factor: number) => {
    const box = size ?? { width: 800, height: 600 };
    setView((current) => zoomAt(current, factor, { x: box.width / 2, y: box.height / 2 }));
  };
  const fit = () => { if (size) setView(fitView(layout, size)); };

  // ----------------------------------------------------------------- draw
  const gesture = canvas.gesture;
  const preview = gesture.kind === 'drag' ? dragPreview(layout, gesture.nodeId, gesture.at) : null;
  const shown = preview?.layout ?? layout;
  const selected = new Set(canvas.selection.nodes);
  const names = captainNames(shown.nodes);

  const drawing = gesture.kind === 'wire' ? (() => {
    const from = nodeById(shown, gesture.fromId);
    if (!from) return null;
    const over = gesture.over ? nodeById(shown, gesture.over) : null;
    const end = over ? nodeRect(over) : { x: gesture.to.x, y: gesture.to.y, w: 0, h: 0 };
    return wireRoute(nodeRect(from), end);
  })() : null;

  const grid = 24 * view.scale;
  const style = {
    '--fc-grid': `${grid}px`,
    '--fc-grid-x': `${view.x}px`,
    '--fc-grid-y': `${view.y}px`,
  } as CSSProperties;

  return (
    <div
      ref={viewport}
      className={`fc-canvas${canvas.tool === 'wire' ? ' crosshair' : ''}${gesture.kind === 'drag' || (gesture.kind === 'pan' && gesture.moved) ? ' grabbing' : ''}`}
      style={style}
      tabIndex={0}
      aria-label="Fleet canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => run({ type: 'cancel' })}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <div className="fc-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {shown.clusters.map((cluster) => {
          const rect = clusterRect(cluster, shown.nodes);
          if (!rect) return null;
          return (
            <div
              key={cluster.id}
              className={`fc-box${preview?.highlight === cluster.id ? ' lit' : ''}`}
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            >
              <div className="fc-box-head">
                <span className="fc-chip"><ListGlyph />{clusterChip(cluster.memberIds.length)}</span>
                <span className="fc-box-brief" title={cluster.brief}>{cluster.brief}</span>
                <button
                  className="fc-box-link"
                  type="button"
                  data-ui
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => props.onOpenTab('compare')}
                >
                  Compare
                </button>
              </div>
            </div>
          );
        })}

        <svg className="fc-lines" width="1" height="1" aria-hidden>
          {shown.wires.map((wire) => {
            const from = nodeById(shown, wire.captainId);
            const to = nodeById(shown, wire.agentId);
            if (!from || !to) return null;
            const route = wireRoute(nodeRect(from), nodeRect(to));
            const end = route.points[route.points.length - 1]!;
            const lit = canvas.selection.wire === wire.id;
            return (
              <g key={wire.id} className={`fc-wire${lit ? ' lit' : ''}`}>
                <path d={route.d} />
                <circle cx={end.x} cy={end.y} r={3.5} />
              </g>
            );
          })}
          {drawing && (
            <g className="fc-wire drawing">
              <path d={drawing.d} />
              <circle cx={drawing.points[drawing.points.length - 1]!.x} cy={drawing.points[drawing.points.length - 1]!.y} r={6} />
            </g>
          )}
        </svg>

        {shown.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            session={node.sessionId ? byId.get(node.sessionId) ?? null : null}
            status={node.sessionId ? statuses[node.sessionId] ?? 'idle' : 'idle'}
            summary={node.sessionId ? summaryOf.get(node.sessionId) ?? null : null}
            exchanges={exchanges}
            wired={node.role === 'captain' ? wiredAgents(shown, node.id).length : 0}
            captainName={names.get(node.id) ?? 'Captain'}
            selected={selected.has(node.id)}
            lifted={gesture.kind === 'drag' && gesture.nodeId === node.id}
            target={gesture.kind === 'wire' && gesture.over === node.id}
            now={now}
            onAnswer={() => props.onOpenTab('questions')}
          />
        ))}

        {loaded && layout.nodes.length === 0 && (
          <button
            className="fc-slot"
            type="button"
            data-ui
            aria-label="Spawn an agent"
            style={{ left: 0, top: 0, width: FLEET_NODE_WIDTH, height: FLEET_NODE_HEIGHT }}
            onClick={() => props.onSpawnAgent({ x: 0, y: 0 })}
          >
            <PlusGlyph />
          </button>
        )}
      </div>

      <div className="fc-rail" data-ui>
        <RailButton label="Select and move" on={canvas.tool === 'select'} onClick={() => run({ type: 'tool', tool: 'select' })}><PointerGlyph /></RailButton>
        <RailButton label="Spawn an agent" onClick={() => props.onSpawnAgent(centre())}><AgentGlyph /></RailButton>
        <RailButton label="Spawn a captain" tint disabled={spawning} onClick={() => void spawnCaptain()}><HexGlyph /></RailButton>
        <RailButton label="Draw a wire" on={canvas.tool === 'wire'} onClick={() => run({ type: 'tool', tool: canvas.tool === 'wire' ? 'select' : 'wire' })}><WireGlyph /></RailButton>
        <RailButton label="Group as parallel attempts" onClick={group}><GroupGlyph /></RailButton>
        <div className="fc-rail-rule" />
        <RailButton label="Tidy the layout" onClick={() => apply(tidy)}><TidyGlyph /></RailButton>
      </div>

      <div className="fc-zoom" data-ui>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / BUTTON_ZOOM)}><MinusGlyph /></button>
        <span className="fc-zoom-figure">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(BUTTON_ZOOM)}><PlusGlyph /></button>
        <span className="fc-zoom-rule" />
        <button type="button" aria-label="Fit everything on screen" title="Fit" onClick={fit}><FitGlyph /></button>
      </div>

      {hint && <div className="fc-hint" role="status" style={{ left: hint.x + 12, top: hint.y + 12 }}>{hint.text}</div>}
    </div>
  );
}

function NodeCard({
  node,
  session,
  status,
  summary,
  exchanges,
  wired,
  captainName,
  selected,
  lifted,
  target,
  now,
  onAnswer,
}: {
  node: FleetNode;
  session: AgentSession | null;
  status: FleetStatus;
  summary: AttemptSummary | null;
  exchanges: CaptainExchange[];
  wired: number;
  captainName: string;
  selected: boolean;
  lifted: boolean;
  target: boolean;
  now: number;
  onAnswer: () => void;
}): ReactElement {
  const place: CSSProperties = { left: node.x, top: node.y, width: FLEET_NODE_WIDTH, height: FLEET_NODE_HEIGHT, borderRadius: FLEET_NODE_RADIUS };
  const state = `${selected ? ' selected' : ''}${lifted ? ' lifted' : ''}${target ? ' targeted' : ''}`;
  const activity = session?.semanticState?.currentActivity?.trim() || null;

  if (node.role === 'captain') {
    const answered = answeredBy(exchanges, node.sessionId);
    return (
      <div className={`fc-node tinted-ask${state}`} style={place} data-node={node.id}>
        <div className="fc-node-top">
          <span className="fc-glyph"><HexGlyph /></span>
          <span className="fc-node-title">{captainName}</span>
          <span className="fc-figure ask">{wired}</span>
        </div>
        <div className="fc-node-line">{activity ?? (status === 'running' ? 'Answering.' : 'Idle.')}</div>
        <div className="fc-node-foot"><span className="fc-figure ask">{answered} answered</span></div>
      </div>
    );
  }

  const tone = STATUS_TONE[status];
  const title = node.label ?? (session ? sessionTitle(session) : 'Agent');
  const question = status === 'needs-you' ? waitingQuestion(exchanges, node.sessionId) : null;
  const started = session ? Date.parse(session.createdAt) : NaN;
  const until = status === 'running' ? now : session ? Date.parse(session.lastActivityAt) : NaN;
  const elapsed = Number.isFinite(started) && Number.isFinite(until) ? elapsedLabel(until - started) : '';
  const diff = summary?.diff ?? null;
  const look = status === 'needs-you' ? ' tinted-attention' : status === 'done' ? ' edged-good' : status === 'failed' ? ' edged-bad' : status === 'idle' ? ' dim' : '';
  const line = question?.question ?? activity ?? session?.task ?? (session ? '' : 'Not on this machine.');

  return (
    <div className={`fc-node${look}${state}`} style={place} data-node={node.id} title={title}>
      <div className="fc-node-top">
        <span className={`dot lg ${tone}${status === 'running' ? ' glow' : ''}`} aria-hidden />
        <span className="fc-node-title">{title}</span>
        {elapsed && <span className="fc-figure">{elapsed}</span>}
      </div>
      <div className={`fc-node-line${question ? ' attention' : ''}`}>{line}</div>
      <div className="fc-node-foot">
        <span className={`status-word ${tone}`}>{statusWord(status)}</span>
        {question && (
          <button
            className="fc-answer"
            type="button"
            data-ui
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onAnswer}
          >
            Answer
          </button>
        )}
        <span className="fc-node-spacer" />
        {diff && diff.added > 0 && <span className="fc-figure good">+{diff.added}</span>}
        {diff && diff.removed > 0 && <span className="fc-figure bad">−{diff.removed}</span>}
      </div>
    </div>
  );
}

function RailButton({
  label,
  on = false,
  tint = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  on?: boolean;
  tint?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactElement;
}): ReactElement {
  return (
    <button
      className={`fc-rail-button${on ? ' on' : ''}${tint ? ' tint' : ''}`}
      type="button"
      aria-label={label}
      aria-pressed={on || undefined}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Re-render on an interval, for the elapsed times. */
function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

// ---------------------------------------------------------------- glyphs

function PointerGlyph(): ReactElement {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M3.5 2.5l9 4.6-4 1.1-1.1 4z" /></svg>;
}
function AgentGlyph(): ReactElement {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="2.5" y="4" width="11" height="8" rx="2" /><path d="M6 8h4" strokeLinecap="round" /></svg>;
}
function HexGlyph(): ReactElement {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 2.2 13.2 5v4.2L8 13.8 2.8 9.2V5z" /></svg>;
}
function WireGlyph(): ReactElement {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="3.6" cy="3.6" r="1.8" /><circle cx="12.4" cy="12.4" r="1.8" /><path d="M3.6 5.4V12h7" /></svg>;
}
function GroupGlyph(): ReactElement {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2.5" strokeDasharray="2.6 2.2" /><rect x="5" y="5" width="6" height="6" rx="1.2" /></svg>;
}
function TidyGlyph(): ReactElement {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 3.5h11M2.5 8h7M2.5 12.5h11" /></svg>;
}
function ListGlyph(): ReactElement {
  return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 5h10M3 8h10M3 11h6" /></svg>;
}
function MinusGlyph(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3.5 8h9" /></svg>;
}
function PlusGlyph(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3.5v9M3.5 8h9" /></svg>;
}
function FitGlyph(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>;
}

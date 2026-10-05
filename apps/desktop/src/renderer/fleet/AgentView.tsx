import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import type { AgentSession, CaptainExchange, FleetLayout, FleetStatus, Project } from '@vowe/core';
import { captainOf, clusterOf } from '@vowe/core/fleet-model';

import { messageOf } from '../components/ui.js';
import { useAttemptSummaries, useCaptainExchanges } from '../hooks/useVoweData.js';
import { BackIcon } from '../shell/icons.js';
import { RoomIdentity } from '../shell/TopChrome.js';
import { ipcMessage } from '../state/project-fleet.js';
import { formatElapsed, memberLabel } from '../state/fleet-views.js';
import {
  ROW_WINDOW,
  afterGrowth,
  afterScroll,
  agentElapsed,
  clusterWords,
  composerBlock,
  currentTurn,
  exchangeFor,
  pendingSend,
  questionAnswer,
  settlePending,
  showJump,
  thinkingLabel,
  toolHeadline,
  toolView,
  touchedFiles,
  transcriptRows,
  turnInFlight,
  turnLabel,
  unifiedPatch,
  windowStart,
  type FollowState,
  type PatchFile,
  type PendingSend,
  type QuestionItem,
  type ResponsePart,
  type ToolItem,
  type TranscriptRow,
} from '../state/fleet-transcript.js';
import { Markdown } from '../workbench/Markdown.js';
import { fleetTranscriptApi, useTranscript } from './use-transcript.js';
import { AnswerBox, CaptainGlyph, StatusMark, useNow } from './view-parts.js';

interface AgentViewProps {
  project: Project;
  session: AgentSession;
  layout: FleetLayout;
  status: FleetStatus | undefined;
  onBack(): void;
  onOpenAgent(sessionId: string): void;
  onCompare(clusterId: string): void;
}

/**
 * One fleet agent, as its own transcript: what it was told, what it thought,
 * said and ran, and a composer that speaks to it directly. The diff of what it
 * touched opens beside.
 */
export function AgentView({ project, session, layout, status, onBack, onOpenAgent, onCompare }: AgentViewProps): ReactElement {
  const transcript = useTranscript(session.id);
  const { items, streaming } = transcript;
  const available = fleetTranscriptApi() !== null;
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { exchanges } = useCaptainExchanges(project.id);

  const node = layout.nodes.find((candidate) => candidate.sessionId === session.id) ?? null;
  const label = memberLabel(node?.label, session, node?.role ?? 'agent');
  const cluster = node ? clusterOf(layout, node.id) : null;
  const captain = node && node.role === 'agent' ? captainOf(layout, node.id) : null;

  const inFlight = turnInFlight(items, streaming, status);
  const now = useNow(inFlight ? 1000 : 30_000);
  const elapsed = agentElapsed(session, inFlight, now);
  const turn = currentTurn(items, inFlight);
  const canStop = inFlight && session.capabilities.interrupt && available;

  useEffect(() => setPending([]), [session.id]);
  useEffect(() => {
    setPending((current) => {
      const left = settlePending(items, current);
      return left.length === current.length ? current : left;
    });
  }, [items]);
  useEffect(() => {
    if (!inFlight) setStopping(false);
  }, [inFlight]);

  const rows = useMemo(() => transcriptRows(items, streaming, pending), [items, streaming, pending]);

  const stop = useCallback(async () => {
    const api = fleetTranscriptApi();
    if (!api || stopping) return;
    setStopping(true);
    try {
      const stopped = await api.interruptAgent(session.id);
      if (!stopped) setStopping(false);
    } catch {
      setStopping(false);
    }
  }, [session.id, stopping]);

  const send = useCallback(
    async (text: string): Promise<string | null> => {
      const api = fleetTranscriptApi();
      if (!api) return 'Not available';
      const entry = pendingSend(items, pending, `pending:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, text, new Date().toISOString());
      setPending((current) => [...current, entry]);
      const drop = () => setPending((current) => current.filter((send) => send.id !== entry.id));
      try {
        const result = await api.sendToAgent(session.id, entry.text);
        if (!result.delivered) {
          drop();
          return result.note ?? 'Not delivered';
        }
        return null;
      } catch (cause) {
        drop();
        return ipcMessage(messageOf(cause));
      }
    },
    [items, pending, session.id],
  );

  return (
    <main className="session-room fa-room">
      <RoomIdentity>
        <button className="fa-back" type="button" onClick={onBack} title="Back to the fleet">
          <BackIcon />
        </button>
        <StatusMark status={status} />
        <h1 className="fa-title">{label}</h1>
        {cluster && node && (
          <>
            <span className="fa-chip">{clusterWords(cluster.memberIds.indexOf(node.id) + 1, cluster.memberIds.length).place}</span>
            <button className="fa-ghost" type="button" onClick={() => onCompare(cluster.id)}>
              {clusterWords(1, cluster.memberIds.length).compare}
            </button>
          </>
        )}
        {captain && (
          <button
            className="fa-chip fa-chip-blue"
            type="button"
            disabled={!captain.sessionId}
            onClick={() => captain.sessionId && onOpenAgent(captain.sessionId)}
          >
            <CaptainGlyph size={12} />
            May ask the captain
          </button>
        )}
        {node?.role === 'captain' && (
          <span className="fa-chip fa-chip-blue">
            <CaptainGlyph size={12} />
            Captain
          </span>
        )}
        <span className="fa-spacer" />
        <span className="fa-meta">
          {formatElapsed(elapsed)}
          {turn > 0 && ` · turn ${turn}`}
        </span>
        <button
          className={`fa-ghost${diffOpen ? ' on' : ''}`}
          type="button"
          aria-pressed={diffOpen}
          onClick={() => setDiffOpen((open) => !open)}
        >
          Diff
        </button>
        <button className="fa-stop" type="button" disabled={!canStop || stopping} onClick={() => void stop()}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </RoomIdentity>

      <div className="fa-body">
        <div className="fa-main">
          <TranscriptColumn
            rows={rows}
            project={project}
            session={session}
            exchanges={exchanges}
            loaded={transcript.loaded}
            available={available}
            hasOlder={transcript.hasOlder}
            loadOlder={transcript.loadOlder}
            onSend={send}
          />
          <AgentComposer
            block={available ? composerBlock(session) : 'Not available'}
            inFlight={inFlight}
            canStop={canStop}
            stopping={stopping}
            onStop={() => void stop()}
            onSend={send}
            resetKey={session.id}
          />
        </div>
        {diffOpen && <DiffPanel project={project} sessionId={session.id} />}
      </div>
    </main>
  );
}

// --------------------------------------------------------------- transcript

interface ColumnProps {
  rows: TranscriptRow[];
  project: Project;
  session: AgentSession;
  exchanges: CaptainExchange[];
  loaded: boolean;
  available: boolean;
  hasOlder: boolean;
  loadOlder(): Promise<void>;
  onSend(text: string): Promise<string | null>;
}

function TranscriptColumn({ rows, project, session, exchanges, loaded, available, hasOlder, loadOlder, onSend }: ColumnProps): ReactElement {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState<FollowState>({ follow: true, unseen: 0 });
  const followRef = useRef(follow);
  followRef.current = follow;
  const [shown, setShown] = useState(ROW_WINDOW);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const lastKey = useRef<string | null>(null);
  const lastCount = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    setFollow({ follow: true, unseen: 0 });
    setShown(ROW_WINDOW);
    lastKey.current = null;
    lastCount.current = 0;
  }, [session.id]);

  // New rows below: follow them, or count them and hold the window still.
  useLayoutEffect(() => {
    const element = scroller.current;
    const tail = rows[rows.length - 1]?.key ?? null;
    let added = 0;
    if (tail !== lastKey.current) {
      const at = lastKey.current === null ? -1 : rows.findIndex((row) => row.key === lastKey.current);
      added = at === -1 ? Math.max(0, rows.length - lastCount.current) : rows.length - 1 - at;
    }
    lastKey.current = tail;
    lastCount.current = rows.length;
    if (!element) return;
    if (keep.current) {
      element.scrollTop = keep.current.top + (element.scrollHeight - keep.current.height);
      keep.current = null;
      return;
    }
    if (followRef.current.follow) {
      element.scrollTop = element.scrollHeight;
    } else if (added > 0) {
      setShown((count) => count + added);
      setFollow((state) => afterGrowth(state, added));
    }
  }, [rows]);

  // Rows that change height on their own — a narrower column, a card opened
  // near the end — keep the end in view while following.
  const column = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = scroller.current;
    const content = column.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followRef.current.follow) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    setFollow((state) => afterScroll(state, element));
  };

  const jump = () => {
    const element = scroller.current;
    setFollow({ follow: true, unseen: 0 });
    setShown(ROW_WINDOW);
    if (element) element.scrollTop = element.scrollHeight;
  };

  const start = windowStart(rows.length, shown);
  const visible = start > 0 ? rows.slice(start) : rows;

  const earlier = async () => {
    const element = scroller.current;
    if (element) keep.current = { height: element.scrollHeight, top: element.scrollTop };
    if (start > 0) {
      setShown((count) => count + ROW_WINDOW);
      return;
    }
    setLoadingOlder(true);
    try {
      await loadOlder();
      setShown((count) => count + ROW_WINDOW);
    } catch {
      keep.current = null;
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div className="fa-transcript">
      <div className="fa-scroll" ref={scroller} onScroll={onScroll}>
        <div className="fa-column" ref={column}>
          {(start > 0 || hasOlder) && (
            <button className="fa-earlier" type="button" disabled={loadingOlder} onClick={() => void earlier()}>
              {loadingOlder ? 'Loading…' : 'Show earlier'}
            </button>
          )}
          {!available ? (
            <p className="fa-empty">Transcript unavailable</p>
          ) : !loaded ? (
            <p className="fa-empty">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="fa-empty">Nothing yet</p>
          ) : (
            visible.map((row) => (
              <Row key={row.key} row={row} project={project} sessionId={session.id} exchanges={exchanges} onSend={onSend} />
            ))
          )}
        </div>
      </div>
      {showJump(follow) && (
        <button className={`fa-jump${follow.unseen > 0 ? ' news' : ''}`} type="button" onClick={jump}>
          Jump to latest
        </button>
      )}
    </div>
  );
}

interface RowProps {
  row: TranscriptRow;
  project: Project;
  sessionId: string;
  exchanges: CaptainExchange[];
  onSend(text: string): Promise<string | null>;
}

function Row({ row, project, sessionId, exchanges, onSend }: RowProps): ReactElement {
  switch (row.kind) {
    case 'task':
      return (
        <section className="fa-task">
          <div className="fa-eyebrow">Task</div>
          <div className="fa-task-text">{row.text}</div>
        </section>
      );
    case 'message':
      if (row.origin === 'you') {
        return (
          <div className={`fa-you${row.pending ? ' pending' : ''}`}>
            <div className="fa-bubble">{row.text}</div>
            {row.pending && <span className="fa-sending">Sending…</span>}
          </div>
        );
      }
      return (
        <section className="fa-captain">
          <div className="fa-captain-head">
            <CaptainGlyph size={14} />
            <span className="fa-eyebrow">{row.origin === 'captain' ? 'From the captain' : 'Relayed'}</span>
          </div>
          <Markdown text={row.text} />
        </section>
      );
    case 'response':
      return <Response parts={row.parts} project={project} />;
    case 'question':
      return <Question item={row.item} sessionId={sessionId} exchanges={exchanges} onSend={onSend} />;
    case 'turn':
      return (
        <div className={`fa-turn fa-turn-${row.item.state}`} title={row.item.error}>
          <span className="fa-turn-rule" />
          <span className="fa-turn-label">{turnLabel(row.item, row.number)}</span>
          <span className="fa-turn-rule" />
        </div>
      );
    case 'system':
      return <p className="fa-system">{row.text}</p>;
  }
}

function Response({ parts, project }: { parts: ResponsePart[]; project: Project }): ReactElement {
  return (
    <div className="fa-response">
      <div className="fa-avatar" aria-hidden="true">
        <span />
      </div>
      <div className="fa-parts">
        {parts.map((part) =>
          part.kind === 'text' ? (
            <TextPart key={part.key} text={part.text} streaming={part.streaming} />
          ) : part.kind === 'thinking' ? (
            <ThinkingPart key={part.key} part={part} />
          ) : (
            <ToolCard key={part.key} item={part.item} project={project} />
          ),
        )}
      </div>
    </div>
  );
}

const TextPart = memo(function TextPart({ text, streaming }: { text: string; streaming: boolean }): ReactElement {
  return (
    <div className={`fa-text${streaming ? ' streaming' : ''}`}>
      <Markdown text={text} committed={!streaming} />
    </div>
  );
});

const ThinkingPart = memo(function ThinkingPart({ part }: { part: Extract<ResponsePart, { kind: 'thinking' }> }): ReactElement {
  const [open, setOpen] = useState(part.streaming);
  const wasStreaming = useRef(part.streaming);
  useEffect(() => {
    if (part.streaming !== wasStreaming.current) setOpen(part.streaming);
    wasStreaming.current = part.streaming;
  }, [part.streaming]);
  const canOpen = !part.redacted && part.text.trim().length > 0;
  return (
    <div className={`fa-thinking${open && canOpen ? ' open' : ''}${part.streaming ? ' live' : ''}`}>
      <button className="fa-thinking-head" type="button" disabled={!canOpen} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Chevron open={open && canOpen} />
        <span>{thinkingLabel(part)}</span>
      </button>
      {open && canOpen && <div className="fa-thinking-text">{part.text}</div>}
    </div>
  );
});

const ToolCard = memo(function ToolCard({ item, project }: { item: ToolItem; project: Project }): ReactElement {
  const [open, setOpen] = useState(false);
  const view = useMemo(() => toolView(item, project), [item, project]);
  const head = toolHeadline(item, view);
  const took = item.endedAt ? Date.parse(item.endedAt) - Date.parse(item.at) : NaN;
  return (
    <div className={`fa-tool fa-tool-${item.status}${open ? ' open' : ''}`}>
      <button className="fa-tool-head" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ToolStatus status={item.status} />
        <span className="fa-tool-name">{head.name}</span>
        {head.summary && <span className="fa-tool-summary">{head.summary}</span>}
        {head.added !== null && <span className="fa-plus">+{head.added}</span>}
        {head.removed !== null && <span className="fa-minus">−{head.removed}</span>}
        {Number.isFinite(took) && took >= 1000 && <span className="fa-tool-took">{formatElapsed(took)}</span>}
        <Chevron open={open} />
      </button>
      {open && <ToolBody item={item} view={view} />}
    </div>
  );
});

function ToolBody({ item, view }: { item: ToolItem; view: ReturnType<typeof toolView> }): ReactElement {
  const output = item.output?.replace(/\s+$/, '') ?? '';
  const outputBlock = output ? (
    <pre className={`fa-output${item.status === 'error' ? ' bad' : ''}`}>
      {output}
      {item.outputTruncated && <span className="fa-cut">{'\n'}… output truncated</span>}
    </pre>
  ) : item.status === 'running' ? null : (
    <p className="fa-tool-note">No output</p>
  );

  switch (view.kind) {
    case 'bash':
      return (
        <div className="fa-tool-body">
          <pre className="fa-command">
            <span className="fa-prompt">$ </span>
            {view.command}
          </pre>
          {outputBlock}
        </div>
      );
    case 'edit':
      return (
        <div className="fa-tool-body">
          <MiniDiff lines={view.lines} />
          {view.truncated && <p className="fa-tool-note">… more lines not shown</p>}
          {item.status === 'error' && outputBlock}
        </div>
      );
    case 'search':
      return (
        <div className="fa-tool-body">
          <Collapsible label={output ? `Output · ${output.split('\n').length} lines` : null}>{outputBlock}</Collapsible>
        </div>
      );
    case 'generic':
      return (
        <div className="fa-tool-body">
          {view.input && <pre className="fa-output">{view.input}</pre>}
          {outputBlock}
        </div>
      );
  }
}

function Collapsible({ label, children }: { label: string | null; children: ReactElement | null }): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!label) return children;
  return (
    <>
      <button className="fa-reveal" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Chevron open={open} />
        {label}
      </button>
      {open && children}
    </>
  );
}

function MiniDiff({ lines }: { lines: Array<{ kind: 'add' | 'remove' | 'context' | 'gap' | 'hunk'; text: string }> }): ReactElement {
  return (
    <div className="fa-diff">
      {lines.map((line, index) => (
        <div key={index} className={`fa-diff-line ${line.kind}`}>
          <span className="fa-diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
          <span className="fa-diff-text">{line.kind === 'gap' ? '⋯' : line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function ToolStatus({ status }: { status: ToolItem['status'] }): ReactElement {
  if (status === 'running') return <span className="fa-spinner" aria-label="Running" />;
  return (
    <span className={`fa-tool-mark ${status}`} aria-label={status === 'ok' ? 'Done' : 'Failed'}>
      {status === 'ok' ? '✓' : '✗'}
    </span>
  );
}

function Chevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg className={`fa-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- questions

function Question({
  item,
  sessionId,
  exchanges,
  onSend,
}: {
  item: QuestionItem;
  sessionId: string;
  exchanges: CaptainExchange[];
  onSend(text: string): Promise<string | null>;
}): ReactElement {
  const exchange = exchangeFor(item, sessionId, exchanges);
  const answer = questionAnswer(item, exchange);
  return (
    <section className="fa-question">
      <div className="fa-eyebrow fa-amber-ink">{answer ? 'Asked' : 'Asks'}</div>
      <div className="fa-question-text">{item.question}</div>
      {item.options && item.options.length > 0 && (
        <ul className="fa-options">
          {item.options.map((option) => (
            <li key={option}>{option}</li>
          ))}
        </ul>
      )}
      {answer ? (
        <div className={`fa-answer by-${answer.by}`}>
          {answer.by === 'captain' && <CaptainGlyph size={12} />}
          <span className="fa-answer-by">{answer.by === 'captain' ? 'Captain' : 'You'}</span>
          <span className="fa-answer-text">{answer.text}</span>
        </div>
      ) : exchange ? (
        <AnswerBox exchange={exchange} compact placeholder="Your answer" />
      ) : (
        <InlineAnswer onSend={onSend} />
      )}
    </section>
  );
}

function InlineAnswer({ onSend }: { onSend(text: string): Promise<string | null> }): ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onSend(value);
    setBusy(false);
    if (failure) setError(failure);
    else setText('');
  };
  return (
    <div className="fa-inline-answer">
      <textarea
        className="fa-inline-field"
        rows={2}
        value={text}
        placeholder="Your answer"
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="fa-inline-row">
        <button className="fa-send small" type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>
          Send to the agent
        </button>
        {error && <span className="fa-error">{error}</span>}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- composer

function AgentComposer({
  block,
  inFlight,
  canStop,
  stopping,
  onStop,
  onSend,
  resetKey,
}: {
  block: string | null;
  inFlight: boolean;
  canStop: boolean;
  stopping: boolean;
  onStop(): void;
  onSend(text: string): Promise<string | null>;
  resetKey: string;
}): ReactElement {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setText('');
    setError(null);
  }, [resetKey]);

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || block) return;
    setText('');
    setError(null);
    const failure = await onSend(value);
    if (failure) {
      setError(failure);
      setText((current) => (current ? current : value));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className={`fa-composer${block ? ' blocked' : ''}`}>
      <textarea
        ref={field}
        className="fa-field"
        rows={2}
        value={text}
        disabled={block !== null}
        placeholder={block ?? 'Instruct this agent'}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="fa-composer-row">
        {inFlight && (
          <span className="fa-running">
            <span className="fa-spinner" aria-hidden="true" />
            Running…
          </span>
        )}
        {inFlight && canStop && (
          <button className="fa-stop small" type="button" disabled={stopping} onClick={onStop}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {error && <span className="fa-error">{error}</span>}
        <span className="fa-spacer" />
        {!block && <span className="fa-keys">⏎ send · ⇧⏎ newline</span>}
        <button className="fa-send" type="button" disabled={block !== null || !text.trim()} onClick={() => void submit()}>
          Send
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- diff

function DiffPanel({ project, sessionId }: { project: Project; sessionId: string }): ReactElement {
  const ids = useMemo(() => [sessionId], [sessionId]);
  const summary = useAttemptSummaries(ids)[0] ?? null;
  const [patch, setPatch] = useState<{ files: PatchFile[]; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Re-read whenever the summary does: it is refreshed as the agent writes.
  useEffect(() => {
    let live = true;
    void window.vowe
      .openArtifact({ kind: 'diff', sessionId })
      .then((artifact) => {
        if (!live) return;
        if (artifact.content.type === 'diff') {
          setPatch({ files: unifiedPatch(artifact.content.patch), truncated: artifact.content.truncated });
          setFailed(false);
        } else {
          setPatch({ files: [], truncated: false });
        }
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [sessionId, summary]);

  const files = useMemo(() => touchedFiles(project, summary?.touchedFiles ?? [], patch?.files ?? []), [project, summary, patch]);
  const added = patch ? patch.files.reduce((sum, file) => sum + file.added, 0) : (summary?.diff?.added ?? 0);
  const removed = patch ? patch.files.reduce((sum, file) => sum + file.removed, 0) : (summary?.diff?.removed ?? 0);
  const current = files.find((file) => file.path === selected && file.inDiff) ?? files.find((file) => file.inDiff) ?? null;
  const currentPatch = current ? (patch?.files.find((file) => file.path === current.path) ?? null) : null;

  return (
    <aside className="fa-diff-panel" aria-label="Diff">
      <div className="fa-panel-head">
        <span className="fa-eyebrow">Diff</span>
        <span className="fa-spacer" />
        <span className="fa-plus">+{added}</span>
        <span className="fa-minus">−{removed}</span>
      </div>
      {summary?.diffAttribution === 'shared-folder' && <p className="fa-panel-note">Folder shared with another agent</p>}
      {files.length > 0 && (
        <ul className="fa-files">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`fa-file${current?.path === file.path ? ' on' : ''}`}
                disabled={!file.inDiff}
                onClick={() => setSelected(file.path)}
                title={file.path}
              >
                <span className="fa-file-path">{file.path}</span>
                {file.added !== null && file.added > 0 && <span className="fa-plus">+{file.added}</span>}
                {file.removed !== null && file.removed > 0 && <span className="fa-minus">−{file.removed}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="fa-panel-body">
        {currentPatch ? (
          currentPatch.binary ? (
            <p className="fa-panel-note">Binary file</p>
          ) : (
            <MiniDiff lines={currentPatch.lines} />
          )
        ) : (
          <p className="fa-panel-note">{failed ? 'Diff unavailable' : patch ? 'No changes' : 'Loading…'}</p>
        )}
        {patch?.truncated && <p className="fa-panel-note">Truncated</p>}
      </div>
    </aside>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import { formatRef } from '@vowe/core/refs';
import type { AgentSession, ConversationEntry, NormalizedEvent } from '@vowe/core';

import { EventInspector, type EvidenceView } from './EventInspector.js';
import { ObservationPanel } from './ObservationPanel.js';
import { SemanticPanel } from './SemanticPanel.js';
import { VoBar, useVo } from './VoPanel.js';
import {
  MicIcon,
  PanelIcon,
  RefreshIcon,
  formatClock,
  messageOf,
  originLabel,
  providerName,
  statusLabel,
  whyNoControl,
} from './ui.js';

interface Props {
  session: AgentSession;
  llmConfigured: boolean;
  voiceConfigured: boolean;
  voiceUnavailableReason: string | null;
}

/** Event kinds worth showing in the narrative stream. The rest live in the inspector. */
const NARRATIVE_KINDS = new Set([
  'session_started',
  'agent_message',
  'user_instruction',
  'file_changed',
  'test_started',
  'test_finished',
  'session_waiting',
  'session_finished',
  'permission_requested',
]);

/** Observed kinds that want the developer's attention. */
const ATTENTION_KINDS = new Set(['permission_requested', 'session_waiting']);

type StreamItem =
  | { type: 'conversation'; at: string; entry: ConversationEntry }
  | { type: 'event'; at: string; event: NormalizedEvent }
  /**
   * An investigation that has been sent but has not come back. `question` is
   * null once the persisted entry is carrying it.
   */
  | { type: 'pending'; at: string; question: string | null };

type Mode = 'ask' | 'instruct';

export function SessionDetail({
  session,
  llmConfigured,
  voiceConfigured,
  voiceUnavailableReason,
}: Props): ReactElement {
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<Mode>('ask');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ question: string; at: string } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceView | null>(null);
  const [traceIds, setTraceIds] = useState<string[] | null>(null);
  const [catchingUp, setCatchingUp] = useState(false);

  const vo = useVo(session.id);

  const reload = useCallback(
    async (settled?: 'settled') => {
      const [nextEvents, nextConversation] = await Promise.all([
        window.vowe.getEvents(session.id),
        window.vowe.getConversation(session.id),
      ]);
      // In one synchronous block, so React batches them and the optimistic rows
      // give way to the persisted ones in a single commit.
      setEvents(nextEvents);
      setConversation(nextConversation);
      // Only the call that was waiting on the answer retires the indicator. A
      // reload triggered by something else — a window note landing, an answer
      // delegated from Vo — must leave an investigation in flight alone.
      if (settled) setPending(null);
    },
    [session.id],
  );

  useEffect(() => {
    void reload();
    const offEvent = window.vowe.onSessionEvent((event) => {
      if (event.sessionId !== session.id) return;
      setEvents((current) => [...current, event]);
    });
    // An answer delegated from Vo is persisted to this same conversation, and
    // arrives on this channel. Without it, a spoken question's written answer
    // would sit on disk unseen until the view remounted.
    const offObservation = window.vowe.onObservationChanged((sessionId) => {
      if (sessionId === session.id) void reload();
    });
    return () => {
      offEvent();
      offObservation();
    };
  }, [reload, session.id]);

  const stream = useMemo<StreamItem[]>(() => {
    const items: StreamItem[] = [
      ...conversation.map((entry) => ({
        type: 'conversation' as const,
        at: entry.at,
        entry,
      })),
      ...events
        .filter((event) => NARRATIVE_KINDS.has(event.kind))
        .map((event) => ({ type: 'event' as const, at: event.at, event })),
      // The runner persists the question before it starts looking, so a reload
      // mid-investigation already has it. Show the optimistic copy only while
      // it would otherwise be missing, or the question renders twice.
      ...(pending
        ? [
            {
              type: 'pending' as const,
              at: pending.at,
              question: conversation.some(
                (entry) =>
                  entry.role === 'user_question' &&
                  entry.text === pending.question &&
                  entry.at >= pending.at,
              )
                ? null
                : pending.question,
            },
          ]
        : []),
    ];
    return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [conversation, events, pending]);

  const canInstruct = session.capabilities.sendInstruction;
  // A session can lose its control channel at any moment; never stay armed.
  const effectiveMode: Mode = canInstruct ? mode : 'ask';
  const instructing = effectiveMode === 'instruct';

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    // Investigating can take a while — it reads the trace, the repository and
    // the diff. Show the question and that Vowe is working, and nothing about
    // how: which tools ran is provenance, not conversation.
    if (!instructing) setPending({ question: text, at: new Date().toISOString() });
    try {
      // Two different paths through the application, on purpose.
      if (instructing) {
        await window.vowe.sendInstruction(session.id, text);
      } else {
        await window.vowe.askCompanion(session.id, text);
      }
      setDraft('');
      await reload('settled');
    } catch (cause) {
      setPending(null);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    void window.vowe
      .refreshInterpretation(session.id)
      .then(() => reload())
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setRefreshing(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const hint = !canInstruct
    ? whyNoControl(session)
    : instructing
      ? 'Delivered to the running agent as a new message'
      : 'Investigated across the session, the repository and Vowe’s memory · never reaches the agent';

  const subtitle = [
    session.cwd ?? 'Unknown folder',
    providerName(session.provider),
    originLabel(session),
  ].join(' · ');

  return (
    <section className="detail">
      <header className="detail-header titlebar-drag">
        <div className="titles">
          <span className="title">{session.displayLabel}</span>
          <span className="subtitle" title={subtitle}>
            {subtitle}
          </span>
        </div>
        <span className="status-pill">
          <span className={`dot small ${session.status}`} />
          {statusLabel(session.status)}
        </span>
        <button
          className={`icon-btn${refreshing ? ' spinning' : ''}`}
          aria-label="Re-interpret now"
          title="Re-interpret now"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshIcon />
        </button>
        <button
          className={`tool-btn${vo.phase === 'live' ? ' on' : ''}`}
          disabled={!voiceConfigured || vo.phase !== 'idle'}
          title={
            voiceConfigured
              ? 'Talk to Vo about this session'
              : (voiceUnavailableReason ?? 'No voice credential is configured')
          }
          onClick={() => void vo.join()}
        >
          <MicIcon />
          Vo
        </button>
        <button
          className={`tool-btn${evidence ? ' on' : ''}`}
          aria-pressed={evidence !== null}
          onClick={() =>
            setEvidence(
              evidence
                ? null
                : session.semanticState?.provenance.eventIds.length
                  ? 'cited'
                  : 'all',
            )
          }
        >
          <PanelIcon />
          Evidence
        </button>
      </header>

      <VoBar vo={vo} catchingUp={catchingUp} />

      <div className="detail-main">
        <div className="detail-scroll">
          <SemanticPanel
            session={session}
            llmConfigured={llmConfigured}
            refreshing={refreshing}
            onShowEvidence={() => setEvidence('cited')}
            onRefresh={refresh}
          />

          <ObservationPanel
            session={session}
            events={events}
            voiceConfigured={voiceConfigured}
            voiceUnavailableReason={voiceUnavailableReason}
            onCatchingUpChange={setCatchingUp}
            onShowTrace={(ids) => {
              setTraceIds(ids);
              setEvidence('trace');
            }}
          />

          <section className="activity" aria-label="Activity">
            <h2>Activity</h2>
            {stream.length === 0 ? (
              <p className="none">Nothing observed yet.</p>
            ) : (
              <div className="timeline">
                {stream.map((item) => (
                  <StreamRow
                    key={keyOf(item)}
                    item={item}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        {evidence && (
          <EventInspector
            sessionId={session.id}
            events={events}
            citedIds={session.semanticState?.provenance.eventIds ?? []}
            traceIds={traceIds}
            view={evidence}
            onViewChange={setEvidence}
            onClose={() => setEvidence(null)}
          />
        )}
      </div>

      <div className="composer-wrap">
        <div className={`composer${instructing ? ' instruct' : ''}`}>
          <div className="top">
            <div className="segmented" role="group" aria-label="Who this goes to">
              <button
                aria-pressed={!instructing}
                onClick={() => setMode('ask')}
              >
                Ask Vowe
              </button>
              <button
                aria-pressed={instructing}
                disabled={!canInstruct}
                title={canInstruct ? 'Send an instruction to the agent' : whyNoControl(session)}
                onClick={() => setMode('instruct')}
              >
                Instruct agent
              </button>
            </div>
            <span className="hint">{hint}</span>
          </div>
          <label htmlFor="composer-input" className="visually-hidden">
            {instructing ? 'Instruction for the agent' : 'Question for Vowe'}
          </label>
          <textarea
            id="composer-input"
            rows={2}
            value={draft}
            placeholder={
              instructing
                ? 'Tell the agent what to do next…'
                : 'Ask about this session — what it changed, why it’s stuck, what’s left…'
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="bottom">
            {error && <span className="error">{error}</span>}
            <span className="kbd">⌘↩</span>
            <button
              className={`btn small ${instructing ? 'instr' : 'primary'}`}
              disabled={busy || !draft.trim()}
              onClick={() => void submit()}
            >
              {busy
                ? instructing
                  ? 'Sending…'
                  : 'Investigating…'
                : instructing
                  ? 'Send to agent'
                  : 'Ask'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function keyOf(item: StreamItem): string {
  if (item.type === 'event') return item.event.id;
  if (item.type === 'pending') return 'pending';
  return item.entry.id;
}

function StreamRow({ item }: { item: StreamItem }): ReactElement {
  const time = <span className="time">{formatClock(item.at)}</span>;

  if (item.type === 'pending') {
    return (
      <>
        {item.question === null ? <span /> : time}
        <div className="said">
          {item.question !== null && (
            <>
              <span className="who ask">You asked Vowe</span>
              <span className="text">{item.question}</span>
            </>
          )}
          <span className="pending">Investigating…</span>
        </div>
      </>
    );
  }

  if (item.type === 'event') {
    const { event } = item;
    if (event.kind === 'user_instruction') {
      return (
        <>
          {time}
          <div className="block">
            <span className="who">Prompt to the agent</span>
            <span className="text">{event.summary}</span>
          </div>
        </>
      );
    }
    return (
      <>
        {time}
        <span
          className={`observed${ATTENTION_KINDS.has(event.kind) ? ' attention' : ''}`}
        >
          {event.summary}
        </span>
      </>
    );
  }

  const { entry } = item;
  switch (entry.role) {
    case 'user_question':
      return (
        <>
          {time}
          <div className="said">
            <span className="who ask">You asked Vowe</span>
            <span className="text">{entry.text}</span>
          </div>
        </>
      );
    case 'companion_answer':
      return (
        <>
          <span />
          <div className="block ask">
            <span className="who ask">
              Vowe · from observed events, not sent to the agent
            </span>
            <span className="text">{entry.text}</span>
            <RefList refs={entry.refs} />
          </div>
        </>
      );
    case 'user_instruction':
      return (
        <>
          {time}
          <div className="block instr">
            <span className="who instr">You instructed the agent</span>
            <span className="text">{entry.text}</span>
          </div>
        </>
      );
    case 'instruction_result':
      return (
        <>
          <span />
          <span className="observed">
            <span className="who instr">Control channel · </span>
            {entry.text}
          </span>
        </>
      );
    default:
      return (
        <>
          {time}
          <span className="note">{entry.text}</span>
        </>
      );
  }
}

/**
 * What the answer was grounded in, as the investigator's own reference strings.
 *
 * Deliberately flat and non-interactive. Descending into a `repo:` or `symbol:`
 * ref is a real feature and the evidence inspector is where it belongs; listing
 * them is what makes "is this grounded, and in what?" answerable today without
 * redesigning the conversation around it.
 */
function RefList({ refs }: { refs?: ConversationEntry['refs'] }): ReactElement | null {
  if (!refs?.length) return null;
  return (
    <div className="refs">
      <span className="refs-count">
        {refs.length} {refs.length === 1 ? 'reference' : 'references'}
      </span>
      {refs.map((ref) => {
        const text = formatRef(ref);
        return (
          <code key={text} title={text}>
            {text}
          </code>
        );
      })}
    </div>
  );
}

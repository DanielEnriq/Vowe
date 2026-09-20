import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

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
  | { type: 'event'; at: string; event: NormalizedEvent };

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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceView | null>(null);
  const [traceIds, setTraceIds] = useState<string[] | null>(null);
  const [catchingUp, setCatchingUp] = useState(false);

  const vo = useVo(session.id);

  const reload = useCallback(async () => {
    const [nextEvents, nextConversation] = await Promise.all([
      window.vowe.getEvents(session.id),
      window.vowe.getConversation(session.id),
    ]);
    setEvents(nextEvents);
    setConversation(nextConversation);
  }, [session.id]);

  useEffect(() => {
    void reload();
    return window.vowe.onSessionEvent((event) => {
      if (event.sessionId !== session.id) return;
      setEvents((current) => [...current, event]);
    });
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
    ];
    return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [conversation, events]);

  const canInstruct = session.capabilities.sendInstruction;
  // A session can lose its control channel at any moment; never stay armed.
  const effectiveMode: Mode = canInstruct ? mode : 'ask';
  const instructing = effectiveMode === 'instruct';

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Two different paths through the application, on purpose.
      if (instructing) {
        await window.vowe.sendInstruction(session.id, text);
      } else {
        await window.vowe.askCompanion(session.id, text);
      }
      setDraft('');
      await reload();
    } catch (cause) {
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
      : 'Answered from what Vowe has observed · never reaches the agent';

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
                    key={item.type === 'event' ? item.event.id : item.entry.id}
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
                  : 'Thinking…'
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

function StreamRow({ item }: { item: StreamItem }): ReactElement {
  const time = <span className="time">{formatClock(item.at)}</span>;

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

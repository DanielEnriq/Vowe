import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import type { AgentSession, ConversationEntry, NormalizedEvent } from '@vowe/core';

import { EventInspector } from './EventInspector.js';
import { ObservationPanel } from './ObservationPanel.js';
import { SemanticPanel } from './SemanticPanel.js';
import { VoPanel } from './VoPanel.js';

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

type StreamItem =
  | { type: 'conversation'; at: string; entry: ConversationEntry }
  | { type: 'event'; at: string; event: NormalizedEvent };

export function SessionDetail({
  session,
  llmConfigured,
  voiceConfigured,
  voiceUnavailableReason,
}: Props): ReactElement {
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'ask' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<string[] | null>(null);
  const [catchingUp, setCatchingUp] = useState(false);

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

  const ask = async () => {
    const question = draft.trim();
    if (!question) return;
    setBusy('ask');
    setError(null);
    try {
      await window.vowe.askCompanion(session.id, question);
      setDraft('');
      await reload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy('send');
    setError(null);
    try {
      await window.vowe.sendInstruction(session.id, text);
      setDraft('');
      await reload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const canInstruct = session.capabilities.sendInstruction;

  return (
    <section className="detail">
      <header>
        <strong>{session.displayLabel}</strong>
        <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
          <span className={`dot ${session.status}`} /> {session.status} ·{' '}
          {session.provider} · {session.attachMode} · {session.cwd ?? 'unknown cwd'}
        </div>
      </header>

      <div className="detail-body">
        <VoPanel
          session={session}
          voiceConfigured={voiceConfigured}
          voiceUnavailableReason={voiceUnavailableReason}
          catchingUp={catchingUp}
        />

        <ObservationPanel
          session={session}
          events={events}
          onShowEvidence={setEvidence}
          onCatchingUpChange={setCatchingUp}
        />

        <SemanticPanel
          session={session}
          llmConfigured={llmConfigured}
          onShowEvidence={setEvidence}
          onRefresh={() => {
            void window.vowe
              .refreshInterpretation(session.id)
              .then(() => reload());
          }}
        />

        <div className="card">
          <h2>Conversation &amp; progress</h2>
          {stream.length === 0 && (
            <p style={{ color: 'var(--muted)' }}>Nothing observed yet.</p>
          )}
          <div className="stream">
            {stream.map((item) =>
              item.type === 'conversation' ? (
                <div
                  key={item.entry.id}
                  className={`entry ${item.entry.role}`}
                >
                  <div className="who">{labelForRole(item.entry.role)}</div>
                  <div className="text">{item.entry.text}</div>
                </div>
              ) : (
                <div key={item.event.id} className="entry observed">
                  <div className="who">
                    observed · {item.event.kind} · {formatTime(item.event.at)}
                  </div>
                  <div className="text">{item.event.summary}</div>
                </div>
              ),
            )}
          </div>
        </div>

        <EventInspector
          sessionId={session.id}
          events={events}
          highlightIds={evidence}
          onClearHighlight={() => setEvidence(null)}
        />
      </div>

      <div className="composer">
        <textarea
          rows={3}
          value={draft}
          placeholder="Ask Vowe about this session, or write an instruction for the agent."
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="actions">
          <button
            className="primary"
            disabled={busy !== null || !draft.trim()}
            onClick={() => void ask()}
          >
            {busy === 'ask' ? 'Thinking…' : 'Ask Vowe'}
          </button>
          <button
            className="danger-ish"
            disabled={busy !== null || !draft.trim() || !canInstruct}
            title={
              canInstruct
                ? 'Sends this text to the coding agent.'
                : whyNoControl(session)
            }
            onClick={() => void send()}
          >
            {busy === 'send' ? 'Sending…' : 'Send to agent'}
          </button>
          <span className="hint">
            {canInstruct
              ? 'Asking never reaches the agent. Sending always does.'
              : whyNoControl(session)}
          </span>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

function whyNoControl(session: AgentSession): string {
  if (session.attachMode === 'external-live') {
    return 'This session is running in a terminal Vowe does not own, so it can be observed but not instructed.';
  }
  if (session.status === 'finished') return 'This session is finished.';
  return 'This session cannot currently receive instructions.';
}

function labelForRole(role: ConversationEntry['role']): string {
  switch (role) {
    case 'user_question':
      return 'You → Vowe';
    case 'companion_answer':
      return 'Vowe';
    case 'user_instruction':
      return 'You → agent';
    case 'instruction_result':
      return 'control channel';
    default:
      return 'note';
  }
}

function formatTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString();
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  // Electron prefixes IPC errors with the handler path; keep the useful half.
  const marker = "Error: ";
  const index = raw.lastIndexOf(marker);
  return index === -1 ? raw : raw.slice(index + marker.length);
}

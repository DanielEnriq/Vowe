import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';
import type { AppStatus } from '../shared/ipc.js';

import { SessionList } from './components/SessionList.js';
import { SessionDetail } from './components/SessionDetail.js';

export function App(): ReactElement {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);

  const refresh = useCallback(async () => {
    setSessions(await window.vowe.listSessions());
  }, []);

  useEffect(() => {
    void refresh();
    void window.vowe.getStatus().then(setStatus).catch(() => undefined);
    return window.vowe.onSessionsChanged(() => {
      void refresh();
    });
  }, [refresh]);

  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onLaunched={(session) => {
          void refresh();
          setSelectedId(session.id);
        }}
      />
      {selected ? (
        <SessionDetail
          key={selected.id}
          session={selected}
          llmConfigured={status?.llmConfigured ?? false}
          voiceConfigured={status?.voiceConfigured ?? false}
          voiceUnavailableReason={status?.voiceUnavailableReason ?? null}
        />
      ) : (
        <div className="detail">
          <header>
            <strong>No session selected</strong>
          </header>
          <div className="empty">
            {sessions.length === 0
              ? 'No coding-agent sessions discovered yet. Start one in a terminal, or start one here from the panel on the left — either way it will appear in this list.'
              : 'Select a session to see what it appears to be doing, ask about its work, or send it an instruction.'}
            {status && !status.llmConfigured && (
              <p>
                No <code>ANTHROPIC_API_KEY</code> or <code>OPENROUTER_API_KEY</code>{' '}
                is configured, so Vowe will observe and record sessions but cannot
                interpret them or answer questions about them.
              </p>
            )}
            {status && !status.voiceConfigured && (
              <p>
                Vo voice is unavailable.{' '}
                {status.voiceUnavailableReason ??
                  'No voice credential is configured.'}{' '}
                Observation is unaffected.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

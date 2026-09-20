import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';
import type { AppStatus } from '../shared/ipc.js';

import { NewSessionSheet } from './components/NewSessionSheet.js';
import { SessionDetail } from './components/SessionDetail.js';
import { SessionList } from './components/SessionList.js';

export function App(): ReactElement {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

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

  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        selectedId={selectedId}
        status={status}
        onSelect={setSelectedId}
        onNewSession={() => setSheetOpen(true)}
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
        <section className="detail">
          <header className="detail-header titlebar-drag" />
          <div className="placeholder">
            <div className="inner">
              {sessions.length === 0 ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <h1>Waiting for a coding session</h1>
                    <p>
                      Start Claude Code in any terminal and it appears here
                      within a few seconds. Vowe only watches: it won’t touch
                      the session unless you send it an instruction.
                    </p>
                  </div>
                  <div>
                    <button className="btn primary" onClick={() => setSheetOpen(true)}>
                      New session…
                    </button>
                  </div>
                  <p className="fine">
                    Sessions started from Vowe can also be instructed later.
                    Ones started in a terminal can be watched and asked about.
                  </p>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h1>Pick a session</h1>
                  <p>
                    See what it appears to be doing, ask Vowe about its work,
                    or send it an instruction.
                  </p>
                </div>
              )}

              {status && !status.voiceConfigured && (
                <p className="fine">
                  Vo’s voice is unavailable.{' '}
                  {status.voiceUnavailableReason ??
                    'No voice credential is configured.'}{' '}
                  Observation is unaffected.
                </p>
              )}

              {status && !status.llmConfigured && (
                <div className="notice">
                  <strong>Summaries and answers are off</strong>
                  <p>
                    No <code className="inline">ANTHROPIC_API_KEY</code> or{' '}
                    <code className="inline">OPENROUTER_API_KEY</code> is set.
                    Vowe still finds sessions, records every event and shows
                    their status. To turn on summaries and Ask Vowe, set a key
                    and restart:
                  </p>
                  <code>export ANTHROPIC_API_KEY=sk-ant-…</code>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {sheetOpen && (
        <NewSessionSheet
          onClose={closeSheet}
          onLaunched={(session) => {
            setSheetOpen(false);
            void refresh();
            setSelectedId(session.id);
          }}
        />
      )}
    </div>
  );
}

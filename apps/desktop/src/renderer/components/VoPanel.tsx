import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentSession, LiveStatus } from '@vowe/core';

interface Props {
  session: AgentSession;
  voiceConfigured: boolean;
  voiceUnavailableReason: string | null;
  catchingUp: boolean;
}

type Phase = 'idle' | 'joining' | 'live' | 'error';

/**
 * The voice surface.
 *
 * The renderer owns the audio and nothing else: it holds the microphone, it
 * plays what comes back, and it negotiates a peer connection directly with the
 * provider. The SDP offer goes through the main process only because the
 * exchange needs a credential, and the credential must not reach here.
 *
 * Development-quality by design — join, mute, end.
 */
export function VoPanel({
  session,
  voiceConfigured,
  voiceUnavailableReason,
  catchingUp,
}: Props): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connection = useRef<RTCPeerConnection | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    connection.current?.close();
    connection.current = null;
    for (const track of microphone.current?.getTracks() ?? []) track.stop();
    microphone.current = null;
    setMuted(false);
  }, []);

  useEffect(() => {
    void window.vowe.getLiveStatus().then(setStatus).catch(() => undefined);
    return window.vowe.onLiveStatus(setStatus);
  }, []);

  // Ending the session when the panel goes away matters: a live microphone
  // that outlives the screen it belongs to is a real problem, not a tidy-up.
  useEffect(() => () => teardown(), [teardown]);

  const join = useCallback(async () => {
    setPhase('joining');
    setError(null);
    try {
      const peer = new RTCPeerConnection();
      connection.current = peer;

      peer.ontrack = (event) => {
        if (audio.current) audio.current.srcObject = event.streams[0] ?? null;
      };
      // The provider's events travel on this channel; the label is fixed.
      peer.createDataChannel('oai-events');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphone.current = stream;
      for (const track of stream.getTracks()) peer.addTrack(track, stream);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const { sdpAnswer, status: next } = await window.vowe.startLive(
        session.id,
        offer.sdp ?? '',
      );
      await peer.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

      setStatus(next);
      setPhase('live');
    } catch (cause) {
      teardown();
      setPhase('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [session.id, teardown]);

  const end = useCallback(async () => {
    teardown();
    setPhase('idle');
    try {
      await window.vowe.stopLive();
    } catch {
      // Already gone; nothing to report.
    }
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const tracks = microphone.current?.getAudioTracks() ?? [];
    const next = !muted;
    for (const track of tracks) track.enabled = !next;
    setMuted(next);
  }, [muted]);

  if (!voiceConfigured) {
    return (
      <div className="card">
        <h2>Vo</h2>
        <p style={{ color: 'var(--muted)' }}>
          Vo voice is unavailable.{' '}
          {voiceUnavailableReason ?? 'No voice credential is configured.'}
        </p>
        <p style={{ color: 'var(--muted)' }}>
          Observation is unaffected — windows, notes and surfaced updates are all
          below.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>
        Vo{' '}
        <span className={`badge ${phase === 'live' ? 'llm' : ''}`}>
          {phase === 'live'
            ? catchingUp
              ? 'getting up to speed…'
              : 'live'
            : phase}
        </span>
        {status && status.connected && !status.sidebandAttached && (
          <span className="badge warn" style={{ marginLeft: 6 }}>
            observer updates cannot reach this call
          </span>
        )}
      </h2>

      <div style={{ display: 'flex', gap: 8 }}>
        {phase === 'live' ? (
          <>
            <button onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
            <button onClick={() => void end()}>End</button>
          </>
        ) : (
          <button onClick={() => void join()} disabled={phase === 'joining'}>
            {phase === 'joining' ? 'Joining…' : 'Join Vo'}
          </button>
        )}
      </div>

      {error && (
        <p className="error" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}

      <audio ref={audio} autoPlay />
    </div>
  );
}

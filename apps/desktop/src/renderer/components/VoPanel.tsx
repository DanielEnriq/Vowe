import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';

import type { LiveStatus } from '@vowe/core';

export type VoPhase = 'idle' | 'joining' | 'live' | 'error';

export interface Vo {
  phase: VoPhase;
  status: LiveStatus | null;
  muted: boolean;
  error: string | null;
  join: () => Promise<void>;
  end: () => Promise<void>;
  toggleMute: () => void;
  audio: RefObject<HTMLAudioElement | null>;
}

/**
 * The voice surface.
 *
 * The renderer owns the audio and nothing else: it holds the microphone, it
 * plays what comes back, and it negotiates a peer connection directly with the
 * provider. The SDP offer goes through the main process only because the
 * exchange needs a credential, and the credential must not reach here.
 */
export function useVo(sessionId: string): Vo {
  const [phase, setPhase] = useState<VoPhase>('idle');
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
        sessionId,
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
  }, [sessionId, teardown]);

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

  return { phase, status, muted, error, join, end, toggleMute, audio };
}

interface BarProps {
  vo: Vo;
  /** Vo says "getting up to speed" from the same source the panel reads. */
  catchingUp: boolean;
}

/**
 * The strip under the window's title bar while Vo is on the call. It carries
 * the controls that must always be one click away: mute, and end.
 */
export function VoBar({ vo, catchingUp }: BarProps): ReactElement | null {
  const live = vo.phase === 'live';
  const sidebandMissing =
    vo.status?.connected === true && vo.status.sidebandAttached === false;

  if (vo.phase === 'idle') {
    return <audio ref={vo.audio} autoPlay />;
  }

  return (
    <div className={`vo-bar${vo.phase === 'error' ? ' error-bar' : ''}`}>
      <span className={`dot small ${live ? 'working' : 'starting'}`} />
      <span className="label">
        {vo.phase === 'joining' && 'Vo is joining…'}
        {live && (catchingUp ? 'Vo is live · getting up to speed…' : 'Vo is live')}
        {vo.phase === 'error' && (vo.error ?? 'Vo could not join')}
      </span>
      {live && sidebandMissing && (
        <span className="warn-chip">Observer updates can’t reach this call</span>
      )}
      <span className="spacer" />
      {live && (
        <button className="btn tiny" onClick={vo.toggleMute}>
          {vo.muted ? 'Unmute' : 'Mute'}
        </button>
      )}
      {vo.phase !== 'joining' && (
        <button className="btn tiny" onClick={() => void vo.end()}>
          {vo.phase === 'error' ? 'Dismiss' : 'End'}
        </button>
      )}
      <audio ref={vo.audio} autoPlay />
    </div>
  );
}

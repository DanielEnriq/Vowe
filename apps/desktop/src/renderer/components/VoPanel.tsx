import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';

import type { LiveStatus, PlaybackReport } from '@vowe/core';

/**
 * How quiet, for how long, counts as Vo having stopped speaking.
 *
 * These are the two numbers the whole playback measurement rests on, so they
 * are named rather than buried. The provider declares no playback lifecycle —
 * its event vocabulary has no response, turn-done or barge-in event of any kind
 * — so the only truthful account of what a person heard is the audio that came
 * out of their speaker, which is here and nowhere else in the application.
 */
const SILENCE_MS = 400;
const SPEECH_THRESHOLD = 0.01;

interface PlaybackWatch {
  stop(): void;
  /** True while audio is actually coming out. */
  readonly playing: boolean;
  /** The last measured level, `0..1`. Real energy, not an envelope. */
  readonly level: number;
}

/**
 * Measure the remote audio as it plays.
 *
 * Deliberately a measurement and not an inference: it reports when audio began
 * and how long it was audible, and says nothing about why it stopped. What an
 * interruption is gets decided in the main process, where the conversation is.
 */
/**
 * Speech energy, scaled for something to look at.
 *
 * The measurement is real RMS; this only maps its useful range onto `0..1`,
 * because ordinary speech sits around a tenth of full scale and a presence fed
 * the raw figure would barely move. Nothing is smoothed, filled in or invented
 * — silence measures zero and draws as zero.
 */
const LEVEL_GAIN = 5;

function watchPlayback(
  stream: MediaStream,
  report: (report: PlaybackReport) => void,
  onLevel: (level: number) => void = () => undefined,
): PlaybackWatch {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  let playing = false;
  let startedAt = 0;
  let lastAudible = 0;
  let measured = 0;

  const tick = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) total += sample * sample;
    const level = Math.sqrt(total / samples.length);
    measured = Math.min(1, level * LEVEL_GAIN);
    onLevel(measured);
    const now = performance.now();

    if (level > SPEECH_THRESHOLD) {
      lastAudible = now;
      if (!playing) {
        playing = true;
        startedAt = now;
        report({ kind: 'started', at: new Date().toISOString() });
      }
      return;
    }
    if (playing && now - lastAudible >= SILENCE_MS) {
      playing = false;
      // The audible span, with the silence that ended it left out — otherwise
      // every turn would look 400ms longer than anyone heard.
      report({
        kind: 'stopped',
        at: new Date().toISOString(),
        audioMs: Math.max(0, Math.round(lastAudible - startedAt)),
      });
    }
  }, 50);

  return {
    get playing() {
      return playing;
    },
    get level() {
      return measured;
    },
    stop() {
      window.clearInterval(tick);
      void context.close().catch(() => undefined);
    },
  };
}

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
  /**
   * What is actually audible right now, `0..1`, or undefined when nothing is
   * being measured.
   *
   * Vowe's own playback while it is speaking, the microphone while it is
   * listening — both measured where the audio physically is, which is here.
   * Undefined rather than zero when there is nothing to measure, so the
   * presence moves on its state alone instead of being told there is silence.
   */
  level: number | undefined;
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
  const playback = useRef<PlaybackWatch | null>(null);
  const listening = useRef<{ stop(): void } | null>(null);
  const [level, setLevel] = useState<number | undefined>(undefined);

  const teardown = useCallback(() => {
    // Audio that is still playing when the call goes away was not finished —
    // reporting that is the difference between an honest record and one that
    // quietly implies the developer heard the end of something.
    if (playback.current?.playing) {
      window.vowe.reportLivePlayback({ kind: 'lost', at: new Date().toISOString() });
    }
    playback.current?.stop();
    playback.current = null;
    listening.current?.stop();
    listening.current = null;
    setLevel(undefined);
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
        const stream = event.streams[0] ?? null;
        if (audio.current) audio.current.srcObject = stream;
        playback.current?.stop();
        playback.current = stream
          ? watchPlayback(
              stream,
              (report) => window.vowe.reportLivePlayback(report),
              // Vowe speaking outranks the room: while there is playback, this
              // is what the presence is moving to.
              (measured) => setLevel(measured),
            )
          : null;
      };

      peer.onconnectionstatechange = () => {
        const state = peer.connectionState;
        if (state !== 'failed' && state !== 'disconnected') return;
        if (playback.current?.playing) {
          window.vowe.reportLivePlayback({
            kind: 'lost',
            at: new Date().toISOString(),
          });
        }
      };

      // The provider's events travel on this channel; the label is fixed. It is
      // read for one thing only — the session ending under audio that is still
      // playing — because that is the one moment this side learns something the
      // backend's own connection does not already tell it. Everything else
      // here would be a second copy of what the sideband already delivers, and
      // the renderer does not own what gets written down.
      const events = peer.createDataChannel('oai-events');
      events.onmessage = (message: MessageEvent<string>) => {
        if (!playback.current?.playing) return;
        if (!closesSession(message.data)) return;
        window.vowe.reportLivePlayback({
          kind: 'lost',
          at: new Date().toISOString(),
        });
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphone.current = stream;
      // The microphone, measured the same way, so `listening` is the developer's
      // own voice rather than a state pulsing to nothing.
      listening.current = watchMicrophone(stream, (measured) =>
        setLevel((current) => (playback.current?.playing ? current : measured)),
      );
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

  return { phase, status, muted, error, join, end, toggleMute, audio, level };
}

/**
 * The same measurement, on the way in.
 *
 * Its own small watcher rather than a second use of `watchPlayback`: nothing
 * about the microphone is reported to the main process, and a function that
 * both measured and reported would make it far too easy to start writing the
 * developer's own audio into the record.
 */
function watchMicrophone(
  stream: MediaStream,
  onLevel: (level: number) => void,
): { stop(): void } {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const tick = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) total += sample * sample;
    onLevel(Math.min(1, Math.sqrt(total / samples.length) * LEVEL_GAIN));
  }, 50);

  return {
    stop() {
      window.clearInterval(tick);
      void context.close().catch(() => undefined);
    },
  };
}


/** True for the one provider event this side acts on. Anything else is not. */
function closesSession(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  try {
    return (JSON.parse(data) as { type?: unknown }).type === 'session.closed';
  } catch {
    return false;
  }
}

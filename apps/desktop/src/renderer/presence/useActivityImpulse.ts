import { useEffect, useRef, useState } from 'react';

/**
 * How long one piece of work stays visible in the presence.
 *
 * Long enough that a single lookup is legible as a movement, short enough that
 * a burst of them reads as a burst rather than as one continuous swell.
 */
const DECAY_MS = 520;

/** Below this there is nothing left to draw, and the loop stops. */
const FLOOR = 0.004;

/**
 * Real execution, as something the presence can move to.
 *
 * This is not an envelope and not a waveform: it is a decay curve over events
 * that actually happened — a lookup recorded, a piece of reasoning emitted, a
 * sentence of the answer written. Nothing here runs on a timer of its own, so
 * a presence that is moving is a Vowe that is working, and a Vowe that has
 * stopped goes still within half a second.
 *
 * The caller coalesces its deltas before they reach here, so a fast provider
 * produces one impulse per frame rather than one per token.
 */
export function useActivityImpulse(beat: number, active: boolean): number | undefined {
  const [level, setLevel] = useState(0);
  const value = useRef(0);
  const frame = useRef<number | null>(null);
  /** Never measured anything yet: the presence should move on its state alone. */
  const measured = useRef(false);

  useEffect(() => {
    if (beat === 0) return;
    measured.current = true;
    // A new event refreshes the impulse rather than stacking onto it: two
    // lookups in one frame are not twice as much work to look at.
    value.current = 1;
    setLevel(1);

    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.max(0, now - last);
      last = now;
      // Frame-rate independent: the same curve on a 60Hz and a 120Hz display.
      value.current *= Math.exp(-dt / DECAY_MS);
      if (value.current < FLOOR) {
        value.current = 0;
        frame.current = null;
        setLevel(0);
        return;
      }
      setLevel(value.current);
      frame.current = requestAnimationFrame(step);
    };

    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(step);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [beat]);

  // Work that has stopped leaves nothing lingering behind it.
  useEffect(() => {
    if (active) return;
    value.current = 0;
    setLevel(0);
  }, [active]);

  if (!measured.current) return undefined;
  return level;
}

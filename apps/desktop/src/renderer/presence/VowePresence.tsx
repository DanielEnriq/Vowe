import { useEffect, useRef, useState, type ReactElement } from 'react';

import {
  DEFAULT_PRESENCE_PROFILE,
  clampActivity,
  resolvePresenceVisuals,
  type PresenceProfile,
  type PresenceSize,
  type PresenceState,
} from '@vowe/core/presence';

import { useOnLight } from '../shell/theme.js';
import { PointCloudOrb } from './PointCloudOrb.js';

interface Props {
  /** What Vowe is doing. Resolved from runtime truth, never from the UI. */
  state: PresenceState;
  /** How Vowe looks. One profile for the whole application. */
  profile?: PresenceProfile;
  /** Where this one is drawn. Size, not a different presence. */
  size?: PresenceSize;
  /**
   * Real, normalized speech energy, when something measured it.
   *
   * Left undefined the presence moves on its state alone. There is deliberately
   * no synthetic envelope: a mouth moving to nothing is worse than a still one.
   */
  activity?: number | undefined;
  /** Makes the presence a control. Without it, it is decoration. */
  onActivate?: (() => void) | undefined;
  /** For the accessible name when it is a control. */
  label?: string;
  className?: string;
}

/**
 * Vowe, as one object.
 *
 * The product abstraction over the renderer: this is what the rest of the
 * application mounts, and it takes product words — a state, a profile, a size.
 * Three.js does not appear in its API and must never leak past it.
 *
 * One Vowe, many sizes. The same presence appears in a sidebar at 26px and on a
 * voice stage at 400px, and it is the same entity in both, because Vowe is not
 * a session, a project or a coding worker — it is the thing watching them.
 */
export function VowePresence({
  state,
  profile = DEFAULT_PRESENCE_PROFILE,
  size = 'project',
  activity,
  onActivate,
  label = 'Vowe',
  className,
}: Props): ReactElement {
  const host = useRef<HTMLSpanElement | null>(null);
  const orb = useRef<PointCloudOrb | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // The application's appearance, not Vowe's. The profile is untouched by it.
  const onLight = useOnLight();
  const [failed, setFailed] = useState(false);

  const visuals = resolvePresenceVisuals(state, profile, size, { reducedMotion, onLight });
  // What the orb should start with, without making the mount depend on props.
  const visualsRef = useRef(visuals);
  visualsRef.current = visuals;

  // One orb per mount. Everything after this is a parameter change, which is
  // why a state transition interpolates instead of rebuilding the scene.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // No WebGL at all: the presence degrades to a quiet disc rather than
    // taking its surroundings down with it.
    const instance = new PointCloudOrb(element, visualsRef.current, () => setFailed(true));
    orb.current = instance;
    return () => {
      instance.dispose();
      orb.current = null;
    };
    // The orb outlives every prop: parameters are pushed into it below.
  }, []);

  useEffect(() => {
    orb.current?.setVisuals(visuals);
  });

  useEffect(() => {
    orb.current?.setActivity(clampActivity(activity));
  }, [activity]);

  const classes = ['presence', `presence-${size}`, className].filter(Boolean).join(' ');

  // A presence with something to do is a real button, with real focus and real
  // keyboard activation. One without is not interactive and does not pretend.
  if (onActivate) {
    return (
      <button type="button" className={classes} aria-label={label} onClick={onActivate}>
        <span className="presence-canvas" ref={host} aria-hidden="true" />
        {failed && <span className="presence-fallback" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <span className={classes} aria-hidden="true">
      <span className="presence-canvas" ref={host} />
      {failed && <span className="presence-fallback" />}
    </span>
  );
}

/** The developer's system-wide answer to "how much movement?", watched live. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const handler = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, []);

  return reduced;
}

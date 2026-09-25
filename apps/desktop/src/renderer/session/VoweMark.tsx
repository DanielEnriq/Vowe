import type { CSSProperties, ReactElement } from 'react';

import type { PresenceProfile, PresenceState } from '@vowe/core';
import {
  presenceColumns,
  presenceRows,
  resolvePresenceVisuals,
} from '@vowe/core/presence';

import { useOnLight } from '../shell/theme.js';

/**
 * Vowe, at conversation size.
 *
 * One mark before, during and after an answer. The column used to mount the
 * full point cloud while Vowe was working and then swap to a flat dot once it
 * had finished, which read as two different entities taking turns — and it put
 * a WebGL context in the conversation, where a long thread would have wanted
 * dozens of them and a browser grants a handful.
 *
 * So this is the same *identity*, drawn cheaply — and, more to the point,
 * drawn from the same numbers. Every visible quantity below comes out of
 * `resolvePresenceVisuals`, the one table the real orb is also driven by:
 *
 *  - `colorA` / `colorB` — the lit and shadow colours, profile accent included
 *  - `density` — the point grid, so the dots sit at the orb's own spacing
 *  - `size` × `scale` — how large a single point sprite is
 *  - `opacity` × `gain` × `bright` — the material's ink and the light response
 *  - `halo` — the surrounding ring, which is `0` at idle and therefore absent
 *  - `amp` — how far the shell deforms, as a breathing scale
 *  - `spin` — rotational drift of the field
 *  - `speed` — the field's own clock, which sets both periods
 *  - `pulse` — how much measured activity reaches the deformation
 *
 * Nothing here invents a rhythm, a colour or a glow of its own. A profile
 * change, a material change or a motion change moves this and the orb
 * together, because there is only one place either of them reads from.
 *
 * The full `VowePresence` orb stays where Vowe is genuinely the subject — the
 * project hero, the voice stage, the studio — rather than beside every line it
 * says.
 */
interface Props {
  profile: PresenceProfile;
  /**
   * Presence's own state, not a vocabulary of this component's.
   *
   * There used to be three values here — idle, thinking, answering — which
   * this mapped onto presence's eight on the way to the table. That was fine
   * while the only caller was a byline, which is one of those three. It stops
   * being fine the moment something with a real state has to draw itself this
   * way: the composer's control is listening, or unavailable, or asking for
   * attention, and none of those survive a squash into three.
   */
  state?: PresenceState;
  /** Real, normalized execution activity, when something measured it. */
  activity?: number | undefined;
  className?: string;
}

export function VoweMark({
  profile,
  state = 'idle',
  activity,
  className,
}: Props): ReactElement {
  /*
   * Resolved from the same table the orb uses, at the same size, so a profile
   * change moves both together — and now from the same state, with nothing
   * translated on the way in.
   */
  const onLight = useOnLight();
  const visuals = resolvePresenceVisuals(state, profile, 'signature', { onLight });

  const measured = typeof activity === 'number' && Number.isFinite(activity)
    ? Math.min(1, Math.max(0, activity))
    : 0;

  /*
   * The point grid, at the mark's size — and readable at it.
   *
   * The orb draws `presenceRows × presenceColumns` sprites over a sphere. The
   * mark wants the same *identity*: a field of separate points, not a filled
   * disc. Taking the orb's column count literally is what broke it. At the
   * signature density that is fifteen columns across thirteen pixels, so the
   * lattice came out at 0.87px and the sprite, floored at 0.45px so it would
   * not vanish, was more than half the cell — every dot touched its
   * neighbours and the mark rendered as a solid circle.
   *
   * So the density still chooses the lattice, but it may not choose one
   * finer than this size can actually show separate points on. The ceiling is
   * the honest part: below roughly three pixels per point there is no point
   * field left to see, whatever the number says.
   */
  const asked = Math.round(presenceColumns(visuals.density) / 4);
  const across = Math.max(3, Math.min(asked, Math.floor(MARK_PX / MIN_SPACING)));
  const grid = MARK_PX / across;
  /*
   * And the sprite may never be more than a fraction of its cell, however
   * large the state's own `size` is: the gap between the points is the motif.
   */
  const dot = Math.min(
    grid * 0.3,
    Math.max(0.55, grid * 0.3 * visuals.size * visuals.scale),
  );
  const rowSkew = (presenceRows(visuals.density) / presenceColumns(visuals.density)) * grid;

  // One clock, from the state's own speed, damped by the profile's motion
  // preference and by reduced motion — all of which `speed` already carries.
  const period = 1.6 / Math.max(0.15, visuals.speed);

  /*
   * Which of the material's two colours the points are drawn in.
   *
   * The orb's answer, at this size. On a dark page the points are the lit
   * colour over a wash of the shadow one — light added to the surface. On
   * paper that is a field of white dots on white, so the two swap roles: the
   * points are the material's own body colour, laid on the page as ink, and
   * the wash beneath them is fainter still. Neither colour is invented here
   * and neither material is substituted; this is the same tonal inversion the
   * orb makes when it stops adding its light and starts being seen in it.
   */
  const dotColor = onLight ? visuals.colorB : visuals.colorA;
  const dotAlpha = onLight
    ? clamp01(visuals.opacity * 0.92)
    : clamp01(visuals.opacity * visuals.gain);

  const style: CSSProperties & Record<string, string | number> = {
    '--mark-dot': withAlpha(dotColor, dotAlpha),
    '--mark-body': withAlpha(visuals.colorB, onLight ? 0.08 : 0.16),
    '--mark-grid': `${grid.toFixed(2)}px`,
    '--mark-row': `${rowSkew.toFixed(2)}px`,
    '--mark-dot-size': `${dot.toFixed(2)}px`,
    /*
     * The state's shading gain and the developer's light response, together —
     * and reflected about 1 on paper, because there the mark is dark and more
     * shading means a denser mark rather than a brighter one.
     */
    '--mark-bright': (onLight ? 2 - visuals.bright : visuals.bright).toFixed(3),
    /*
     * The ring, at the strength the state asks for.
     *
     * `halo` is `0` for `idle`, so a settled byline draws no ring at all —
     * which is the design's own decision about that state rather than this
     * component's.
     */
    '--mark-halo': withAlpha(dotColor, clamp01(visuals.halo * 0.8)),
    '--mark-halo-size': `${(visuals.halo * 5).toFixed(2)}px`,
    // Deformation depth, as a scale the disc breathes through, plus whatever
    // real activity the state lets reach it.
    '--mark-amp': (1 + visuals.amp * 0.8 + measured * visuals.pulse * 2).toFixed(4),
    '--mark-period': `${period.toFixed(2)}s`,
    // Rotational drift. The orb's `spin` is a multiplier on the same clock.
    '--mark-spin-period': `${(period * 6 / Math.max(0.1, visuals.spin)).toFixed(2)}s`,
    '--mark-torsion': `${(visuals.torsion * 140).toFixed(2)}deg`,
  };

  /*
   * Whether it moves at all, said here rather than by a list of state names in
   * the stylesheet. Every state in the table has some amplitude, including
   * idle — a settled byline in a reading column is deliberately still, and
   * so is a mark for something that is not available. Everything else is a
   * live thing and reads as dead when it holds perfectly still.
   */
  const moving = state !== 'idle' && state !== 'unavailable';
  const classes = ['vowe-mark', `is-${state}`, moving ? 'is-moving' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} style={style} aria-hidden>
      <span className="field" />
    </span>
  );
}

/** The one size this mark is drawn at, matching the design's signature slot. */
const MARK_PX = 14;

/** Closer than this and neighbouring points merge into a filled disc. */
const MIN_SPACING = 2.6;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

import { useState, type CSSProperties, type ReactElement } from 'react';

import type { PresenceProfile, ReturnCheckpoint as Checkpoint } from '@vowe/core';
import { resolvePresenceVisuals } from '@vowe/core/presence';
import { checkpointNeedsDecision } from '@vowe/core/projections';

import { CaretIcon, CloseIcon } from '../shell/icons.js';
import { awayFor, ribbonCopy, shortPaths } from '../state/checkpoint-ribbon.js';
import { VoweMark } from './VoweMark.js';

/**
 * What changed while the developer was not looking — as a note Vowe left, not
 * an alert.
 *
 * At rest it is one ribbon: Vowe's mark, how long they were gone, one short
 * line of Vowe's and the facts under it. Opening it grows the same ribbon
 * downward into a brief — what changed, what was verified, where things are,
 * what was touched — and only below that, behind its own disclosure, the raw
 * activity it was drawn from. Nothing floats over the conversation and
 * nothing asks to be dealt with.
 *
 * Selection, never synthesis. The note is picked by `ribbonCopy` and the brief
 * by core's `returnBrief`, both from what was already recorded: the
 * observer's own notes, the outcomes of the commands the worker ran, the
 * session's status and the files its edits named.
 *
 * The wash along it is tinted with the colour Vowe's own presence is lit
 * with, so a developer who made their Vowe violet gets a violet note; a
 * decision waiting overrides that with the attention colour, because that is
 * the one case where the ribbon is saying more than "welcome back".
 */
export function ReturnCheckpoint({
  checkpoint,
  presence,
}: {
  checkpoint: Checkpoint;
  presence: PresenceProfile;
}): ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  if (dismissed) return null;

  const needsDecision = checkpointNeedsDecision(checkpoint);
  const copy = ribbonCopy(checkpoint);
  const accent = resolvePresenceVisuals('idle', presence, 'project').colorA;

  return (
    <div className="ribbon-lane">
      <section
        className={`ribbon${needsDecision ? ' needs-decision' : ''}${open ? ' open' : ''}`}
        style={{ '--ribbon-accent': accent } as CSSProperties}
        aria-label="While you were away"
      >
        <div className="ribbon-row">
          <button
            className="ribbon-face"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            <VoweMark profile={presence} className="ribbon-mark" />
            <span className="ribbon-text">
              <span className="ribbon-when">
                While you were away · {awayFor(checkpoint.awayMs)}
              </span>
              <span className="ribbon-line">
                <span className="ribbon-summary">{copy.summary}</span>
                <span className="ribbon-facts">{copy.facts.join(' · ')}</span>
              </span>
            </span>
            <span className="ribbon-caret">
              <CaretIcon />
            </span>
          </button>
          <button
            className="icon-button ribbon-dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
          >
            <CloseIcon size={10} />
          </button>
        </div>

        {/* Always mounted, so opening can animate from nothing to its height. */}
        <div className="ribbon-details" aria-hidden={!open} inert={!open}>
          <div className="ribbon-details-inner">
            <div className="ribbon-details-body">
              <Brief checkpoint={checkpoint} />

              {checkpoint.milestones.length > 0 && (
                <div className={`ribbon-activity${activityOpen ? ' open' : ''}`}>
                  <button
                    type="button"
                    aria-expanded={activityOpen}
                    onClick={() => setActivityOpen((was) => !was)}
                  >
                    <CaretIcon />
                    View activity
                  </button>
                  {activityOpen && (
                    <ul className="ribbon-milestones">
                      {checkpoint.milestones.map((milestone) => (
                        <li key={milestone.id} className={milestone.failed ? 'failed' : undefined}>
                          {milestone.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * The four answers, each shown only where there is something true to say.
 *
 * Current state is always there — even "Vowe cannot tell" is an answer — and
 * whether anything needs the developer is part of it, since the two are read
 * together: where things are, and whether that is waiting on you.
 */
function Brief({ checkpoint }: { checkpoint: Checkpoint }): ReactElement {
  const { brief } = checkpoint;
  const touched = brief.touched.slice(0, MAX_TOUCHED);
  const names = shortPaths(touched);
  const more = brief.touched.length - touched.length;

  return (
    <div className="ribbon-brief">
      {brief.changed.length > 0 && (
        <section>
          <h4>What changed</h4>
          {brief.changed.map((text) => (
            <p key={text} className="changed">
              {text}
            </p>
          ))}
        </section>
      )}

      {brief.verified.length > 0 && (
        <section>
          <h4>Verified</h4>
          <ul className="verified">
            {brief.verified.map((check) => (
              <li key={check.label} className={check.passed ? 'passed' : 'failed'}>
                <span className="mark" aria-label={check.passed ? 'passed' : 'failed'} />
                <span className="label">
                  {check.label}
                  {check.runs > 1 && <span className="runs"> · ran {check.runs}×</span>}
                </span>
                <span className="result">{check.result}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Current state</h4>
        <p className="state">
          {brief.state.text}
          {brief.state.activity && <span className="activity"> Last seen: {brief.state.activity}</span>}
        </p>
        {brief.needsYou.length > 0 ? (
          brief.needsYou.map((text) => (
            <p key={text} className="needs">
              {text}
            </p>
          ))
        ) : (
          <p className="calm">Nothing needs you.</p>
        )}
      </section>

      {touched.length > 0 && (
        <section>
          <h4>Touched</h4>
          <p className="touched">
            {touched.map((path, index) => (
              <span key={path} title={path}>
                {names[index]}
              </span>
            ))}
            {more > 0 && <span className="more">and {more} more</span>}
          </p>
        </section>
      )}
    </div>
  );
}

/** Enough to say where the work was; the rest is in the diff. */
const MAX_TOUCHED = 6;

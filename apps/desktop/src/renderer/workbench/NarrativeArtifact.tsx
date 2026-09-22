import { useState, type ReactElement } from 'react';

import type { ArtifactContent, ArtifactFocus, ArtifactKind, ContextRef } from '@vowe/core';

import { CaretIcon } from '../shell/icons.js';
import { Markdown } from './Markdown.js';

type Narrative = Extract<ArtifactContent, { type: 'narrative' }>;

/**
 * Everything that is prose rather than code: worker activity, a transcript
 * point, something Vowe remembered.
 *
 * Under it, where there is one, the provider's own record. The hierarchy the
 * product contract sets out is answer → artifact → evidence → raw trace, and
 * this is the last step of that descent: available, never the default, and
 * only shown when a real payload exists to show.
 */
export function NarrativeArtifact({
  content,
  kind,
  sourceRef,
  focus,
}: {
  content: Narrative;
  kind: ArtifactKind;
  sourceRef: ContextRef;
  focus?: ArtifactFocus;
}): ReactElement {
  if (kind === 'project_memory') {
    return (
      <div className="artifact">
        <div className="memory-card">
          <Markdown text={content.text} />
        </div>
        {content.truncated && <span className="note">Truncated.</span>}
      </div>
    );
  }

  return (
    <div className="artifact">
      {/*
        Worker activity and transcript points are prose Vowe or a worker wrote,
        and both routinely contain Markdown — a list of what changed, a fenced
        command. Rendering it as such reads far better than a wall of asterisks.
      */}
      <Markdown text={content.text} />
      {content.truncated && <span className="note">Truncated.</span>}
      <RawEvidence sourceRef={sourceRef} focus={focus} />
    </div>
  );
}

/**
 * The provider's own record, on request.
 *
 * Normalization truncates and re-describes; this reaches past it to what the
 * worker actually wrote. It is fetched only when asked for, because the point
 * of the hierarchy is that raw trace is reachable rather than in the way.
 */
function RawEvidence({
  sourceRef,
  focus,
}: {
  sourceRef: ContextRef;
  focus?: ArtifactFocus;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const sessionId = 'sessionId' in sourceRef ? sourceRef.sessionId : null;
  const eventIds = focus?.eventIds ?? [];
  if (!sessionId || eventIds.length === 0) return null;

  const reveal = async () => {
    setOpen(true);
    if (raw !== null || missing) return;
    try {
      const events = await window.vowe.getEventsByIds(sessionId, eventIds);
      const payloads = events.map((event) => event.raw).filter((value) => value !== undefined);
      if (!payloads.length) {
        setMissing(true);
        return;
      }
      setRaw(JSON.stringify(payloads.length === 1 ? payloads[0] : payloads, null, 2));
    } catch {
      setMissing(true);
    }
  };

  return (
    <div className="raw-evidence">
      <button
        className={`receipt${open ? ' open' : ''}`}
        type="button"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void reveal())}
      >
        <CaretIcon />
        Show raw
      </button>

      {open &&
        (missing ? (
          <span className="note">The provider kept no record for this event.</span>
        ) : raw === null ? (
          <span className="note">Reading…</span>
        ) : (
          <pre className="code raw">{raw}</pre>
        ))}
    </div>
  );
}

import type { ReactElement } from 'react';

import type { ArtifactContent, ArtifactKind } from '@vowe/core';

import { Markdown } from './Markdown.js';

type Narrative = Extract<ArtifactContent, { type: 'narrative' }>;

/**
 * Everything that is prose rather than code: worker activity, a transcript
 * point, something Vowe remembered.
 *
 * This used to end with a disclosure onto the provider's own JSON payload.
 * What it offered was the normalization's working notes — the shape a
 * provider happened to emit — presented as though it were deeper evidence
 * about the work. It is not: the artifact above is what was understood, and
 * somebody who needs the provider's record needs the provider's log, not a
 * pretty-printed fragment of it under a caret.
 */
export function NarrativeArtifact({
  content,
  kind,
}: {
  content: Narrative;
  kind: ArtifactKind;
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
    </div>
  );
}

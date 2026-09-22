import type { ReactElement } from 'react';

import type { ArtifactContent, ArtifactKind } from '@vowe/core';

type Narrative = Extract<ArtifactContent, { type: 'narrative' }>;

/**
 * Everything that is prose rather than code: worker activity, a transcript
 * point, something Vowe remembered. Rendered as text because that is what it
 * is — dressing a window note as a document would not make it one.
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
          <span className="text">{content.text}</span>
        </div>
        {content.truncated && <span className="note">Truncated.</span>}
      </div>
    );
  }

  return (
    <div className="artifact">
      <p className="narrative">{content.text}</p>
      {content.truncated && <span className="note">Truncated.</span>}
    </div>
  );
}

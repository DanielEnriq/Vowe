import { useEffect, useRef, type ReactElement } from 'react';

import type { ArtifactContent, ArtifactFocus } from '@vowe/core';

type Source = Extract<ArtifactContent, { type: 'source' }>;

/**
 * Source, readable rather than editable.
 *
 * A lightweight renderer on purpose: this is evidence being read, not a file
 * being worked on, and an editor here would be a second place to change code.
 * What it does owe the reader is a stable gutter, the focused range actually
 * visible, and no reflowing when a long line appears.
 */
export function SourceArtifact({
  content,
  focus,
}: {
  content: Source;
  focus?: ArtifactFocus;
}): ReactElement {
  const focused = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'center' });
  }, [content.path, focus?.startLine]);

  const lines = content.text.split('\n');
  const from = focus?.startLine;
  const to = focus?.endLine ?? focus?.startLine;

  return (
    <div className="artifact">
      <span className="path">
        {content.path} · {content.startLine}–{content.endLine}
      </span>
      <pre className="code">
        {lines.map((line, index) => {
          const number = content.startLine + index;
          const inFocus = from !== undefined && number >= from && number <= (to ?? from);
          return (
            <span
              className={`line${inFocus ? ' focus' : ''}`}
              key={number}
              ref={inFocus && number === from ? focused : undefined}
            >
              <span className="gutter">{number}</span>
              {line}
            </span>
          );
        })}
      </pre>
      {content.truncated && <span className="note">Truncated — this is a slice of the file.</span>}
    </div>
  );
}

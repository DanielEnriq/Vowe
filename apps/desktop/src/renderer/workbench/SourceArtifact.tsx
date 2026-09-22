import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { ArtifactContent, ArtifactFocus } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { Markdown, isMarkdownPath } from './Markdown.js';

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
  const document = isMarkdownPath(content.path);
  /**
   * A document opens as a document.
   *
   * Someone who opens a README wants to read it; someone who wants the source
   * of it says so. The toggle is there because both are legitimate and neither
   * is a guess — but only one of them is what was asked for by default.
   */
  const [rendered, setRendered] = useState(document);

  useEffect(() => {
    setRendered(isMarkdownPath(content.path));
  }, [content.path]);

  useEffect(() => {
    if (!rendered) focused.current?.scrollIntoView({ block: 'center' });
  }, [content.path, focus?.startLine, rendered]);

  const lines = content.text.split('\n');
  const from = focus?.startLine;
  const to = focus?.endLine ?? focus?.startLine;

  return (
    <div className="artifact">
      <div className="artifact-head">
        <Fading className="path" title={content.path}>
          {content.path}
          {rendered ? '' : ` · ${content.startLine}–${content.endLine}`}
        </Fading>
        {document && (
          <div className="segmented tiny">
            <button
              className={rendered ? 'on' : undefined}
              type="button"
              aria-pressed={rendered}
              onClick={() => setRendered(true)}
            >
              Rendered
            </button>
            <button
              className={rendered ? undefined : 'on'}
              type="button"
              aria-pressed={!rendered}
              onClick={() => setRendered(false)}
            >
              Source
            </button>
          </div>
        )}
      </div>

      {rendered && <Markdown text={content.text} />}
      {!rendered && (
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
      )}
      {content.truncated && <span className="note">Truncated — this is a slice of the file.</span>}
    </div>
  );
}

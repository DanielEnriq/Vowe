import type { ReactElement } from 'react';

import type { ArtifactContent } from '@vowe/core';

type Diff = Extract<ArtifactContent, { type: 'diff' }>;

/**
 * The working tree's current diff.
 *
 * Additions and removals are coloured, and everything else is left alone: a
 * diff is read by its shape, and syntax highlighting on top of that shape adds
 * a second colour language competing with the one that carries the meaning.
 */
export function DiffArtifact({ content }: { content: Diff }): ReactElement {
  return (
    <div className="artifact">
      {content.path && <span className="path">{content.path}</span>}
      {content.stat && <pre className="code">{content.stat.trim()}</pre>}
      <pre className="code">
        {content.patch.split('\n').map((line, index) => (
          <span className={`line ${diffClass(line)}`} key={`${index}-${line.slice(0, 12)}`}>
            {line}
          </span>
        ))}
      </pre>
      {content.truncated && <span className="note">Truncated — the diff is larger than this.</span>}
    </div>
  );
}

function diffClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'meta';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  return '';
}

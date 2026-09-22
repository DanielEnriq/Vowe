import { useMemo, type ReactElement } from 'react';

import type { ArtifactContent } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { parsePatch } from '../state/patch.js';
import { CodeComparison } from './CodeComparison.js';

type Diff = Extract<ArtifactContent, { type: 'diff' }>;

/**
 * The working tree's current diff.
 *
 * The summary first, then each changed file as its own before-and-after
 * comparison, in the order git listed them. A patch that yields no files —
 * something that is not a git diff at all — is still shown, as the text it is,
 * rather than as an empty desk.
 */
export function DiffArtifact({ content }: { content: Diff }): ReactElement {
  const files = useMemo(() => parsePatch(content.patch), [content.patch]);

  return (
    <div className="artifact">
      {content.path && <Fading className="path">{content.path}</Fading>}
      {content.stat && <pre className="code">{content.stat.trim()}</pre>}
      {files.length > 0 ? (
        <div className="diff-files">
          {files.map((file, index) => (
            <CodeComparison key={`${index}:${file.path}`} file={file} />
          ))}
        </div>
      ) : (
        content.patch.trim() && <pre className="code">{content.patch.trim()}</pre>
      )}
      {content.truncated && <span className="note">Truncated — the diff is larger than this.</span>}
    </div>
  );
}

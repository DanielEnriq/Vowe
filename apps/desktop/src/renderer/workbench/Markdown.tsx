import type { ReactElement } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ContextRef } from '@vowe/core';

import { openableLink } from '../state/studio.js';

/**
 * Markdown, rendered as elements rather than as HTML.
 *
 * `react-markdown` builds React nodes directly and does not parse embedded
 * HTML unless a plugin is added to let it, so there is no string of markup to
 * sanitize and no path by which a document on the desk could execute anything.
 * That property is the reason for this choice: the workbench renders material
 * Vowe read out of a repository, and a repository is not a trusted author.
 *
 * Links are rendered as text rather than as anchors, for the same reason — a
 * document being read as evidence has no business navigating the window.
 *
 * The one exception is Vowe's own citation, `[name](ref:repo:/…#120)`, and
 * only where the caller can open it: it becomes a button that puts that
 * evidence on the desk, never an anchor. Text still being written is not yet
 * grounded, so its citations stay text until it is committed.
 */
export function Markdown({
  text,
  onOpenRef,
  committed = true,
}: {
  text: string;
  onOpenRef?: (ref: ContextRef) => void;
  committed?: boolean;
}): ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Keep `ref:` targets for the renderer below to judge; everything else
        // gets the library's usual treatment.
        urlTransform={(url) => (url.startsWith('ref:') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ children, href }) => {
            const ref = onOpenRef ? openableLink(href, committed) : null;
            if (ref && onOpenRef) {
              return (
                <button className="md-ref" type="button" title="Open on the desk" onClick={() => onOpenRef(ref)}>
                  {children}
                </button>
              );
            }
            return (
              <span className="md-link" title={typeof href === 'string' && !href.startsWith('ref:') ? href : undefined}>
                {children}
              </span>
            );
          },
          // Fenced code keeps the workbench's own code treatment so a block
          // inside a document looks like a file does beside it.
          pre: ({ children }) => <pre className="code md-code">{children}</pre>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Whether a path is a document rather than source.
 *
 * Deliberately by extension. Sniffing content would mean guessing, and a
 * TypeScript file that happens to open with a comment block is not Markdown.
 */
const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown'];

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
 */
export function Markdown({ text }: { text: string }): ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <span className="md-link" title={typeof href === 'string' ? href : undefined}>
              {children}
            </span>
          ),
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

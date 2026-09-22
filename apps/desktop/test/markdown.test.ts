import { describe, expect, it } from 'vitest';

import { isMarkdownPath } from '../src/renderer/workbench/Markdown.js';

describe('Markdown selection — by extension, never by sniffing', () => {
  it('treats documents as documents', () => {
    for (const path of ['/repo/README.md', '/repo/docs/architecture.MD', '/a/b.mdx', '/a/c.markdown']) {
      expect(isMarkdownPath(path), path).toBe(true);
    }
  });

  /**
   * Sniffing content would mean guessing, and a TypeScript file that happens
   * to open with a comment block is not a document.
   */
  it('leaves source as source', () => {
    for (const path of [
      '/repo/src/ask.ts',
      '/repo/src/md.ts',
      '/repo/notes.txt',
      '/repo/Makefile',
      '/repo/markdown.js',
    ]) {
      expect(isMarkdownPath(path), path).toBe(false);
    }
  });

  it('is not fooled by a path that merely mentions one', () => {
    expect(isMarkdownPath('/repo/.md/config.json')).toBe(false);
  });
});

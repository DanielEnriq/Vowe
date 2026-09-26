import { describe, expect, it } from 'vitest';

import { DesignTextStream, splitDesignText } from '../src/design-text.js';

const TURN = 'Reply first.\n\n<design_revision>\n<why>Because.</why>\n# Doc\n\nBody.\n</design_revision>';

describe('design revision block', () => {
  it('splits the reply from the revision', () => {
    expect(splitDesignText('Just talking.')).toEqual({ reply: 'Just talking.' });
    expect(splitDesignText(TURN)).toEqual({
      reply: 'Reply first.\n\n',
      revision: { document: '# Doc\n\nBody.', summary: 'Because.', complete: true },
    });
  });

  it('keeps text written after the block in the reply', () => {
    expect(splitDesignText(`${TURN}\n\nOne more thing.`).reply).toBe('Reply first.\n\n\n\nOne more thing.');
  });

  it('treats an unclosed block as the document so far, and a missing reason as none', () => {
    expect(splitDesignText('Hi <design_revision>\n# Doc')).toEqual({
      reply: 'Hi ',
      revision: { document: '# Doc', summary: '', complete: false },
    });
  });

  it('streams every split of the text to the same reply and document, never showing the marker', () => {
    for (let size = 1; size <= 12; size += 1) {
      const replies: string[] = [];
      const documents: string[] = [];
      const stream = new DesignTextStream((delta) => replies.push(delta), (doc) => documents.push(doc));
      for (let i = 0; i < TURN.length; i += size) stream.push(TURN.slice(i, i + size));
      stream.finish();
      expect(replies.join('')).toBe(splitDesignText(TURN).reply);
      expect(replies.join('')).not.toContain('<');
      expect(documents.at(-1)).toBe('# Doc\n\nBody.');
      for (const document of documents) expect('# Doc\n\nBody.'.startsWith(document)).toBe(true);
    }
  });

  it('releases a held-back "<" that turned out not to be the marker', () => {
    const replies: string[] = [];
    const stream = new DesignTextStream((delta) => replies.push(delta), () => undefined);
    stream.push('a < b');
    stream.finish();
    expect(replies.join('')).toBe('a < b');
  });
});

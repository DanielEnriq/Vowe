import { describe, expect, it } from 'vitest';

import type { DesignOp } from '@vowe/core';

import { DesignTextStream, splitDesignText } from '../src/design-text.js';

const OPS: DesignOp[] = [
  { op: 'design', title: 'Where understanding lives' },
  { op: 'part', id: 'observer', name: 'Observer', role: 'Watches a session', today: true },
  { op: 'part', id: 'project-understanding', name: 'Project Understanding', role: 'Durable understanding' },
  { op: 'link', from: 'observer', to: 'project-understanding' },
];
const TURN = `Reply first.\n\n<design_move>\n<why>Because.</why>\n${OPS.map((op) => JSON.stringify(op)).join('\n')}\n</design_move>`;

describe('design move block', () => {
  it('splits the reply from the move', () => {
    expect(splitDesignText('Just talking.')).toEqual({ reply: 'Just talking.' });
    expect(splitDesignText(TURN)).toEqual({
      reply: 'Reply first.\n\n',
      move: { ops: OPS, summary: 'Because.', complete: true, unreadable: 0 },
    });
  });

  it('keeps text written after the block in the reply', () => {
    expect(splitDesignText(`${TURN}\n\nOne more thing.`).reply).toBe('Reply first.\n\n\n\nOne more thing.');
  });

  it('drops a line that is not an op, and counts it', () => {
    const split = splitDesignText('Hi <design_move>\n```json\n{"op":"part","id":"a","name":"A"}\n{"op":"place","id":"a"}\n{"op":"part",\n</design_move>');
    expect(split.move).toEqual({ ops: [{ op: 'part', id: 'a', name: 'A' }], summary: '', complete: true, unreadable: 2 });
  });

  it('streams every split of the text to the same reply and ops, never showing the marker', () => {
    for (let size = 1; size <= 13; size += 1) {
      const replies: string[] = [];
      const moves: DesignOp[][] = [];
      const stream = new DesignTextStream((delta) => replies.push(delta), (ops) => moves.push(ops));
      for (let i = 0; i < TURN.length; i += size) stream.push(TURN.slice(i, i + size));
      stream.finish();
      expect(replies.join('')).toBe(splitDesignText(TURN).reply);
      expect(replies.join('')).not.toContain('<');
      // One op at a time, each view a prefix of the committed move.
      expect(moves.map((ops) => ops.length)).toEqual([1, 2, 3, 4]);
      expect(moves.at(-1)).toEqual(OPS);
    }
  });

  it('never reads a line before its newline arrives', () => {
    const moves: DesignOp[][] = [];
    const stream = new DesignTextStream(() => undefined, (ops) => moves.push(ops));
    stream.push('<design_move>\n{"op":"remove","id":"a"}');
    expect(moves).toEqual([]);
    stream.push('\n');
    expect(moves).toEqual([[{ op: 'remove', id: 'a' }]]);
  });

  it('releases a held-back "<" that turned out not to be the marker', () => {
    const replies: string[] = [];
    const stream = new DesignTextStream((delta) => replies.push(delta), () => undefined);
    stream.push('a < b');
    stream.finish();
    expect(replies.join('')).toBe('a < b');
  });
});

import { parseOp, type DesignOp } from '@vowe/core';

/**
 * How the design agent changes the design: a delimited block at the end of
 * its turn, written as ordinary text, holding one JSON op per line.
 *
 *     …the reply…
 *     <design_move>
 *     <why>Why the design changed.</why>
 *     {"op":"part","id":"project-understanding","name":"Project Understanding","role":"…"}
 *     {"op":"link","from":"semantic-state","to":"project-understanding"}
 *     </design_move>
 *
 * Text rather than a tool argument, for one reason that decides it: text
 * streams through every endpoint Vowe is pointed at, and a tool's input does
 * not — a gateway may buffer it and deliver it whole at the end. One op per
 * line is what makes that worth having: each line is complete the moment its
 * newline arrives, so parts appear on the canvas one by one as they are
 * written instead of all at once.
 *
 * One splitter serves both tenses. `splitDesignText` on the final text is the
 * committed result; `DesignTextStream` applies the same split to text as it
 * arrives and emits only what is certain, so what was shown and what is kept
 * are the same ops.
 */

export const OPEN = '<design_move>';
export const CLOSE = '</design_move>';
const WHY_OPEN = '<why>';
const WHY_CLOSE = '</why>';

export interface SplitDesign {
  /** Everything outside the block. */
  reply: string;
  /** Present once the block has begun. */
  move?: { ops: DesignOp[]; summary: string; complete: boolean; unreadable: number };
}

/**
 * Split a turn's text into the reply and the move.
 *
 * `settledOnly`: while streaming, a last line without its newline may still be
 * growing, so it is not read yet.
 */
export function splitDesignText(text: string, settledOnly = false): SplitDesign {
  const open = text.indexOf(OPEN);
  if (open === -1) return { reply: text };
  const before = text.slice(0, open);
  const rest = text.slice(open + OPEN.length);
  const close = rest.indexOf(CLOSE);
  const inside = close === -1 ? rest : rest.slice(0, close);
  const after = close === -1 ? '' : rest.slice(close + CLOSE.length);

  let summary = '';
  let body = inside;
  const whyAt = inside.indexOf(WHY_OPEN);
  if (whyAt !== -1 && inside.slice(0, whyAt).trim() === '') {
    const whyEnd = inside.indexOf(WHY_CLOSE, whyAt);
    if (whyEnd === -1) {
      // Still writing the reason; no ops yet.
      summary = inside.slice(whyAt + WHY_OPEN.length);
      body = '';
    } else {
      summary = inside.slice(whyAt + WHY_OPEN.length, whyEnd);
      body = inside.slice(whyEnd + WHY_CLOSE.length);
    }
  }

  const lines = body.split('\n');
  if (settledOnly && close === -1) lines.pop();
  const ops: DesignOp[] = [];
  let unreadable = 0;
  for (const line of lines.map((candidate) => candidate.trim())) {
    // Blank lines and stray fences are not ops, and not mistakes either.
    if (!line.startsWith('{')) continue;
    const op = readOp(line);
    if (op) ops.push(op);
    else unreadable += 1;
  }

  return {
    // Only ever extends: text after the block is appended, never re-spaced,
    // so the reply shown while streaming stays a prefix of the committed one.
    reply: after.trim() ? `${before}\n\n${after.replace(/^\s+/, '')}` : before,
    move: { ops, summary: summary.trim(), complete: close !== -1, unreadable },
  };
}

function readOp(line: string): DesignOp | null {
  try {
    return parseOp(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * The same split, applied as text arrives.
 *
 * A reply delta is emitted only once it cannot turn out to be the start of the
 * block's opening tag, so the conversation never shows a half-written marker
 * and never has to take text back. Ops are emitted whole each time a new line
 * settles, which is what the canvas applies.
 */
export class DesignTextStream {
  private text = '';
  private emitted = 0;
  private opsShown = 0;

  constructor(
    private readonly onReply: (delta: string) => void,
    private readonly onMove: (ops: DesignOp[]) => void,
  ) {}

  push(delta: string): void {
    this.text += delta;
    const split = splitDesignText(this.text, true);
    const safe = split.move ? split.reply : withoutPartial(split.reply, OPEN);
    this.emitReply(safe);
    const ops = split.move?.ops ?? [];
    if (ops.length > this.opsShown) {
      this.opsShown = ops.length;
      this.onMove(ops);
    }
  }

  /** The turn is over: whatever was held back is certain now. */
  finish(): void {
    const split = splitDesignText(this.text);
    this.emitReply(split.reply);
    const ops = split.move?.ops ?? [];
    if (ops.length > this.opsShown) {
      this.opsShown = ops.length;
      this.onMove(ops);
    }
  }

  private emitReply(reply: string): void {
    if (reply.length <= this.emitted) return;
    this.onReply(reply.slice(this.emitted));
    this.emitted = reply.length;
  }
}

/** Text minus any tail that could still become `marker`. */
function withoutPartial(text: string, marker: string): string {
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) return text.slice(0, -length);
  }
  return text;
}

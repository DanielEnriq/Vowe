/**
 * How the design agent proposes a revision: a delimited block at the end of
 * its turn, written as ordinary text.
 *
 *     …the reply…
 *     <design_revision>
 *     <why>Why the design changed.</why>
 *     # Title
 *     …the whole document…
 *     </design_revision>
 *
 * Text rather than a tool argument, for one reason that decides it: text
 * streams through every endpoint Vowe is pointed at, and a tool's input does
 * not — a gateway may buffer it and deliver the whole document at the end,
 * which turns a design being rewritten in front of you into one that swaps.
 *
 * One splitter serves both tenses. `splitDesignText` on the final text is the
 * committed result; `DesignTextStream` applies the same split to text as it
 * arrives and emits only what is certain, so what was shown and what is kept
 * are the same text.
 */

export const OPEN = '<design_revision>';
export const CLOSE = '</design_revision>';
const WHY_OPEN = '<why>';
const WHY_CLOSE = '</why>';

export interface SplitDesign {
  /** Everything outside the block. */
  reply: string;
  /** Present once the block has begun. */
  revision?: { document: string; summary: string; complete: boolean };
}

/** Split a turn's text into the reply and the proposed revision. */
export function splitDesignText(text: string): SplitDesign {
  const open = text.indexOf(OPEN);
  if (open === -1) return { reply: text };
  const before = text.slice(0, open);
  const rest = text.slice(open + OPEN.length);
  const close = rest.indexOf(CLOSE);
  const inside = close === -1 ? rest : rest.slice(0, close);
  const after = close === -1 ? '' : rest.slice(close + CLOSE.length);

  let summary = '';
  let document = inside;
  const whyAt = inside.indexOf(WHY_OPEN);
  if (whyAt !== -1 && inside.slice(0, whyAt).trim() === '') {
    const whyEnd = inside.indexOf(WHY_CLOSE, whyAt);
    if (whyEnd === -1) {
      // Still writing the reason; no document yet.
      summary = inside.slice(whyAt + WHY_OPEN.length);
      document = '';
    } else {
      summary = inside.slice(whyAt + WHY_OPEN.length, whyEnd);
      document = inside.slice(whyEnd + WHY_CLOSE.length);
    }
  }

  return {
    // Only ever extends: text after the block is appended, never re-spaced,
    // so the reply shown while streaming stays a prefix of the committed one.
    reply: after.trim() ? `${before}\n\n${after.replace(/^\s+/, '')}` : before,
    revision: { document: document.trim(), summary: summary.trim(), complete: close !== -1 },
  };
}

/**
 * The same split, applied as text arrives.
 *
 * A reply delta is emitted only once it cannot turn out to be the start of the
 * block's opening tag, so the conversation never shows a half-written marker
 * and never has to take text back. The document is emitted whole each time it
 * grows, which is what the design pane renders.
 */
export class DesignTextStream {
  private text = '';
  private emitted = 0;
  private lastDocument = '';

  constructor(
    private readonly onReply: (delta: string) => void,
    private readonly onDesign: (document: string) => void,
  ) {}

  push(delta: string): void {
    this.text += delta;
    const split = splitDesignText(this.text);
    const safe = split.revision ? split.reply : withoutPartial(split.reply, OPEN);
    this.emitReply(safe);
    let document = split.revision?.document ?? '';
    if (split.revision && !split.revision.complete) {
      // Neither a closing tag nor the start of the reason is ever the design.
      document = withoutPartial(document, CLOSE).trimEnd();
      if (WHY_OPEN.startsWith(document)) document = '';
    }
    if (document && document !== this.lastDocument) {
      this.lastDocument = document;
      this.onDesign(document);
    }
  }

  /** The turn is over: whatever was held back is certain now. */
  finish(): void {
    this.emitReply(splitDesignText(this.text).reply);
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

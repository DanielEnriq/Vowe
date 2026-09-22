import type { ReactElement } from 'react';

import { Markdown } from '../workbench/Markdown.js';

/**
 * What Vowe said, however far along it is.
 *
 * The one renderer for a message body, used by the answer arriving and by the
 * answer that was kept. Having two was a real defect and not a cosmetic one:
 * the transient copy rendered Markdown and the durable copy rendered the
 * source as plain text, so the moment an answer was persisted its headings and
 * emphasis turned back into `##` and `**` in front of the developer. One
 * component means that class of disagreement cannot come back.
 *
 * Partial Markdown is simply Markdown. A half-written fence or an unclosed
 * emphasis run is parsed as whatever it validly is so far, and re-parsed as
 * more source arrives — which is why this takes source text and never a
 * pre-rendered fragment. Nothing here truncates, windows or summarises: the
 * text grows, and what was on screen stays on screen.
 */
export function MessageBody({ text }: { text: string }): ReactElement {
  return (
    <div className="message-body">
      <Markdown text={text} />
    </div>
  );
}

import { formatRef, refFromLink, type ContextRef } from '../context/refs.js';

/**
 * A Markdown link whose target is a Vowe reference: `[observer-runner.ts](ref:repo:/…#120)`.
 *
 * The design document and Vowe's replies cite the repository this way, and the
 * renderer turns exactly these — and nothing else — into buttons that open the
 * Workbench. Nothing is ever a navigating anchor.
 */
const REF_LINK = /\[([^\]\n]*)\]\((ref:[^)\s]+)\)/g;

/**
 * Keep only citations that point at something Vowe actually checked.
 *
 * A model can write a link to a file it never saw, and a design that renders
 * that link as evidence would be claiming grounding it does not have. So at
 * commit, every `ref:` link must name a target a consultation (or an
 * attachment) returned in this design; anything else keeps its text and loses
 * its link. A `repo:` citation of a returned file may point at any line of it —
 * the grounding is the file, and the line is where to look.
 */
export function groundDesignLinks(text: string, allowed: readonly ContextRef[]): string {
  const exact = new Set(allowed.map(formatRef));
  const files = new Set(
    allowed.flatMap((ref) => (ref.kind === 'repo' ? [ref.path] : [])),
  );
  return text.replace(REF_LINK, (_whole, label: string, href: string) => {
    const ref = refFromLink(href);
    if (ref && (exact.has(formatRef(ref)) || (ref.kind === 'repo' && files.has(ref.path)))) {
      return `[${label}](ref:${formatRef(ref)})`;
    }
    return label;
  });
}

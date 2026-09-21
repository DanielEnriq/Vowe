/**
 * What the Workbench will put on the desk.
 *
 * This is a **display projection**, not a second evidence system. `ContextRef`
 * remains the address of everything Vowe can see; an artifact is what one of
 * those addresses looks like when a person, rather than a model, is going to
 * read it. Nothing here is stored, and nothing is canonical: an artifact is
 * rebuilt from its ref whenever somebody opens it.
 *
 * This module imports nothing but a type, for the same reason `refs.ts` does:
 * the renderer needs these shapes, and the renderer is a browser context.
 */

import type { ContextRef } from '../context/refs.js';

/**
 * What a piece of evidence *is*, in the product's own terms.
 *
 * Deliberately independent of `ArtifactContent['type']`, which is how it draws.
 * A code-graph symbol is source evidence and renders as prose; a window is
 * worker activity and renders as prose too. A future viewer switches on the
 * content type; a future badge, filter or icon reads the kind.
 *
 * Only what a `ContextRef` can actually address today is here. The product
 * contract also names `test_failure`, `basis` and `raw_event`; none of them has
 * an address yet, and a kind nothing can produce is a promise, not a type.
 * `transcript` is here and is not in that list, because it does have one.
 */
export type ArtifactKind =
  /** A location in the working tree, or a node in the code graph. */
  | 'source'
  /** What this worker has changed. */
  | 'diff'
  /** What the worker did: a window, a range of trace, one event. */
  | 'worker_activity'
  /** Something that was said between the worker and the developer. */
  | 'transcript'
  /** Something Vowe worked out about this project and kept. */
  | 'project_memory';

export interface WorkbenchArtifact {
  /**
   * The formatted ref. Stable by construction, so opening the same thing twice
   * is the same artifact and a desk can tell without keeping a table.
   */
  id: string;
  kind: ArtifactKind;
  /** What to call it: a filename, `Window 7`, the question Vowe was asked. */
  title: string;
  subtitle?: string;
  /** The address this was built from. Every artifact has one. */
  sourceRef: ContextRef;
  content: ArtifactContent;
  /** Where to look once it is open. */
  focus?: ArtifactFocus;
}

export type ArtifactContent =
  /** A file, as it is now, with its own lines and no gutter baked in. */
  | { type: 'source'; path: string; text: string; startLine: number; endLine: number; truncated: boolean }
  /** The current working tree. Paths are the repository's own. */
  | { type: 'diff'; stat: string; patch: string; path?: string; truncated: boolean }
  /**
   * Material the navigator has already rendered for a person to read.
   *
   * Composed there rather than here: the normalized rendering of a window, an
   * event or a remembered result is the same rendering the investigator reads,
   * and two of them would eventually disagree.
   */
  | { type: 'narrative'; text: string; truncated: boolean }
  /**
   * The address is valid and the material is not there — a file since deleted,
   * a window that was never interpreted, a repository Vowe has no knowledge of.
   *
   * Expected absence only. A fault is an error, and stays one.
   */
  | { type: 'unavailable'; reason: string };

export interface ArtifactFocus {
  /** 1-based and inclusive, matching the content's own numbering. */
  startLine?: number;
  endLine?: number;
  eventIds?: string[];
}

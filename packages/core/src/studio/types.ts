/**
 * Studio: a place to think about what a system should become.
 *
 * Three durable things and nothing else. A design is a thread of conversation
 * with the system being designed beside it — a small model of parts and links
 * (`model.ts`) changed in moves, kept as an append-only list of revisions so
 * that "what did the design say before, and why did it change?" is always
 * answerable. Where each part sits is the design's view state, kept apart
 * from its history.
 *
 * None of this is project truth. A design is exploratory by construction: it
 * lives in its own tables, nothing reads it but Studio, and nothing in it is
 * admitted to project memory or handed to Project Ask. Discussing an idea here
 * must not quietly turn it into something Vowe believes about the project.
 *
 * This module imports nothing but types, so the renderer can share the shapes.
 */

import type { ContextRef } from '../context/refs.js';
import type { InvestigationReceipt } from '../types/conversation.js';
import type { DesignLayout } from './layout.js';
import type { DesignModel, DesignMove } from './model.js';

/** One design: a conversation and the document it maintains. */
export interface Design {
  id: string;
  projectId: string;
  createdAt: string;
}

/**
 * A design as a picker shows it.
 *
 * Derived on read and never stored: the title comes from the current document's
 * first heading, falling back to how the conversation opened, and "updated" is
 * the latest turn. Nothing here can disagree with the rows it is built from.
 */
export interface DesignSummary extends Design {
  title: string;
  /** What the design is for, from its model; empty for a Studio 0 document. */
  intent: string;
  updatedAt: string;
  revisions: number;
  /** Parts on the canvas now. */
  parts: number;
  /** Where those parts sit, for a thumbnail of the design's shape. */
  outline: { row: number; col: number }[];
}

/**
 * A turn in a design conversation.
 *
 * `user_message` / `companion_message` rather than question and answer: Studio
 * is a conversation about a design, not a sequence of questions. A Vowe turn
 * that consulted the repository carries the account of it as an ordinary
 * `InvestigationReceipt`, whose `consult` checks name the question, the finding
 * and the files it rests on.
 */
export interface DesignEntry {
  id: string;
  designId: string;
  at: string;
  /**
   * `developer_move`: the developer changed the design on the canvas; the text
   * is a plain account of it and a revision points here. `companion_note`: a
   * consequence Vowe noticed in such a move, drawn on the part it concerns
   * rather than said in the thread.
   */
  role: 'user_message' | 'companion_message' | 'developer_move' | 'companion_note';
  text: string;
  refs?: ContextRef[];
  investigation?: InvestigationReceipt;
  /** A `companion_note`'s place: the move it responds to and the element it is about. */
  anchor?: { moveId: string; on: string };
}

/**
 * One version of the living design. Never updated, never deleted.
 *
 * `summary` is why the design changed — not a paraphrase of it; empty when the
 * agent gave no reason, never filled in on its behalf — and `entryId`
 * is the reply that explains the change, committed in the same transaction. The
 * design before a revision is the one with the previous `ord`.
 */
export interface DesignRevision {
  id: string;
  designId: string;
  /** 1-based, gap-free within a design. Assigned by the store. Display order only. */
  ord: number;
  at: string;
  /** The design as a document: Studio 0's whole design, now a projection of `model`. */
  document: string;
  summary: string;
  entryId: string;
  /** The design after this revision. Absent on a Studio 0 revision. */
  model?: DesignModel;
  /** The change that made it. Absent on a Studio 0 revision. */
  move?: DesignMove;
}

export interface DesignChange {
  designId: string;
  projectId: string;
}

/**
 * The durable half of Studio.
 *
 * Narrow on purpose: `StudioService` is handed this and a project lookup, not
 * the whole event store, so it cannot read or write anything else Vowe keeps.
 */
export interface DesignStore {
  createDesign(design: Design): Promise<Design>;
  getDesign(designId: string): Design | null;
  /** Newest first. */
  listDesigns(projectId: string): Design[];
  /** Oldest first; `limit` keeps the most recent. */
  getDesignEntries(designId: string, limit?: number): DesignEntry[];
  /** Oldest first. The current design is the last one. */
  getDesignRevisions(designId: string): DesignRevision[];
  appendDesignEntry(entry: DesignEntry): Promise<DesignEntry>;
  /**
   * A reply and the revision it explains, in one transaction.
   *
   * Either both are durable or neither is: a design that changed without the
   * reply saying why, or a reply describing a change that never landed, would
   * each be a history that lies.
   */
  commitDesignTurn(
    entry: DesignEntry,
    revision?: Omit<DesignRevision, 'ord'>,
    /** Where the design's parts now sit, written in the same transaction. */
    layout?: DesignLayout,
  ): Promise<{ entry: DesignEntry; revision?: DesignRevision }>;
  /** Empty before anything was placed. */
  getDesignLayout(designId: string): DesignLayout;
  /** View state: updated in place, never a revision. */
  saveDesignLayout(designId: string, layout: DesignLayout): Promise<void>;
  /** Fires after `COMMIT`, never before. */
  onDesignChanged(listener: (change: DesignChange) => void): () => void;
}

/**
 * The desk a session was left on.
 *
 * Addresses only. No artifact content is ever written here: what a tab shows is
 * rebuilt from its ref when it is opened, so a desk restored a week later shows
 * the file as it is now rather than as it was — and a store of what someone was
 * looking at never becomes a second copy of their repository.
 */
export interface PersistedWorkbenchTab {
  /**
   * The string form of the ref, which is also the tab's identity.
   *
   * A string rather than a shape because `parseRef` is total and nullable: a
   * ref written by an older version, or one hand-edited into nonsense, is
   * dropped on read without a schema validator standing over it.
   */
  ref: string;
  /** What it was called last time, so the strip can draw before anything resolves. */
  title: string;
  /** At most one tab in a desk is a `preview`; normalization enforces it. */
  status: 'preview' | 'durable';
}

export interface PersistedWorkbench {
  /** Left to right, as the strip draws them. Deliberately uncapped. */
  tabs: PersistedWorkbenchTab[];
  /** The ref string of a tab in `tabs`, or null. */
  activeId: string | null;
}

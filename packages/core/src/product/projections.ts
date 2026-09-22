/**
 * Pure product projections, for a browser context.
 *
 * A subpath of its own for the same reason `presence` has one: the renderer is
 * a browser, and importing the whole of `@vowe/core` to select a few worker
 * milestones would drag `node:fs` and `node:events` into a bundle with no use
 * for either. Everything re-exported here is a type, a table or a pure
 * function — nothing that reaches a filesystem, a process or a clock it did
 * not receive.
 *
 * The rule that keeps it true: a module listed here may not import a store.
 */
export * from './worker-milestones.js';
export * from './evidence.js';
export * from './investigation-chronology.js';
export * from './return-checkpoint.js';
export * from './temperament.js';
export * from './session-display.js';
export * from './session-title.js';
export * from './user-profile.js';
export * from './voice-preference.js';

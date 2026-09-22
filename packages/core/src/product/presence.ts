/**
 * Everything the renderer needs to draw Vowe, and nothing else.
 *
 * A subpath of its own because the renderer is a browser: importing the whole
 * of `@vowe/core` for a state machine and a table of numbers would drag
 * `node:fs` and `node:events` into a bundle that has no use for either. The
 * three modules here are pure — types, presets and two functions.
 */
export * from './presence-profile.js';
export * from './presence-state.js';
export * from './presence-visuals.js';

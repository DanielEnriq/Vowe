/**
 * The Workbench substrate: `ContextRef` as something a person can look at.
 *
 * A display projection over evidence Vowe already knows how to reference —
 * deliberately not a second evidence ontology. The one thing that *is*
 * persisted is a desk's list of addresses, which is `persisted.ts`: what was
 * open, never what it said.
 */
export * from './artifact.js';
export * from './artifact-resolver.js';
export * from './persisted.js';

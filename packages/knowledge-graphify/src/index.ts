/**
 * Graphify as Vowe's structural repository knowledge.
 *
 * Everything vendor-specific about code graphs lives in this package, behind
 * `ProjectKnowledgeProvider` from core — the same bargain `@vowe/decision-jev`
 * and `@vowe/live-openai` make. Core never imports from here.
 */
export * from './graphify-cli.js';
export * from './graph-reader.js';
export * from './lexical-retrieval.js';
export * from './graphify-provider.js';
export * from './graphify-memory-mirror.js';

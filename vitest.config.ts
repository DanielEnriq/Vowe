import { defineConfig } from 'vitest/config';

/**
 * One runner for the whole workspace.
 *
 * Tests import package sources directly rather than built `dist` output, so a
 * test run never depends on build order. `@vowe/*` resolves to each package's
 * `src/index.ts`; the `.js` extensions the sources use (NodeNext) are mapped
 * back to their TypeScript originals.
 */
export default defineConfig({
  test: {
    /**
     * Package tests, and the renderer's pure state modules.
     *
     * `apps/desktop/test` covers logic that is genuinely renderer-local — a
     * workbench desk, a composer's destination, how a conversation groups —
     * which has no business in core just because core owned the runner. It
     * stays plain TypeScript with no DOM: components are verified by looking
     * at them, and a snapshot suite over this UI would test nothing a person
     * would notice.
     */
    include: ['packages/*/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
    environment: 'node',
    // Replay and store tests write real files under a temp root.
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      // Subpaths first: the array is ordered, and a bare '@vowe/core' find
      // would otherwise swallow '@vowe/core/presence' and rewrite it into a
      // path inside index.ts.
      {
        find: '@vowe/core/presence',
        replacement: new URL('./packages/core/src/product/presence.ts', import.meta.url).pathname,
      },
      {
        find: '@vowe/core/projections',
        replacement: new URL('./packages/core/src/product/projections.ts', import.meta.url).pathname,
      },
      {
        find: '@vowe/core/refs',
        replacement: new URL('./packages/core/src/context/refs.ts', import.meta.url).pathname,
      },
      { find: '@vowe/core', replacement: new URL('./packages/core/src/index.ts', import.meta.url).pathname },
      { find: '@vowe/llm', replacement: new URL('./packages/llm/src/index.ts', import.meta.url).pathname },
      { find: '@vowe/decision-jev', replacement: new URL('./packages/decision-jev/src/index.ts', import.meta.url).pathname },
      { find: '@vowe/live-openai', replacement: new URL('./packages/live-openai/src/index.ts', import.meta.url).pathname },
      {
        find: '@vowe/knowledge-graphify',
        replacement: new URL('./packages/knowledge-graphify/src/index.ts', import.meta.url).pathname,
      },
      {
        find: '@vowe/adapter-claude-code',
        replacement: new URL('./packages/adapter-claude-code/src/index.ts', import.meta.url).pathname,
      },
    ],
  },
});

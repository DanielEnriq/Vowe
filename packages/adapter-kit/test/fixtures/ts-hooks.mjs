// Resolve workspace sources for a child process, as vitest does for tests:
// `@vowe/*` to TypeScript sources and NodeNext `.js` imports to their `.ts`.
const packages = {
  '@vowe/core': new URL('../../../core/src/index.ts', import.meta.url).href,
  '@vowe/adapter-kit': new URL('../../src/index.ts', import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (packages[specifier]) return { url: packages[specifier], shortCircuit: true };
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts'))
    return next(`${specifier.slice(0, -3)}.ts`, context);
  return next(specifier, context);
}

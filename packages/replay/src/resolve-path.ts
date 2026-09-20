import path from 'node:path';

/**
 * Resolve a path the way the person typing it expects.
 *
 * A package script runs with its own directory as the working directory, so
 * `pnpm replay packages/replay/fixtures/x.jsonl` from the repository root would
 * otherwise look for `packages/replay/packages/replay/fixtures/x.jsonl`. pnpm
 * records where the command was actually invoked in `INIT_CWD`, which is the
 * directory the argument was written relative to.
 */
export function resolveFromInvocation(target: string): string {
  if (path.isAbsolute(target)) return target;
  const from = process.env['INIT_CWD'] ?? process.cwd();
  return path.resolve(from, target);
}
